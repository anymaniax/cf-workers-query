import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheApiAdaptor } from './cache-api';
import { createQuery } from './create-query';
import { DedupeManager } from './dedupe-manager';
import { invalidateQuery } from './invalidate-query';

const { scheduled } = vi.hoisted(() => ({
  scheduled: [] as Promise<unknown>[],
}));

vi.mock('./wait-until', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    scheduled.push(promise);
  },
}));

const DATA_CACHE = 'cf-workers-query-cache';
const MARKER_CACHE = 'cf-workers-query-dedup';

type Store = 'data' | 'marker';
type Op = { kind: 'match' | 'put' | 'delete'; store: Store };
type Gate = (op: Op) => Promise<void> | undefined;

type Entry = { body: ArrayBuffer; status: number; headers: [string, string][] };

const createFakeCaches = () => {
  const stores = new Map<string, Map<string, Entry>>();
  const log: string[] = [];
  let gate: Gate = () => undefined;

  const open = (name: string) => {
    const entries = stores.get(name) ?? new Map<string, Entry>();
    stores.set(name, entries);
    const store: Store = name === MARKER_CACHE ? 'marker' : 'data';

    const run = async <T>(kind: Op['kind'], fn: () => Promise<T> | T) => {
      log.push(`${kind} ${store} start`);
      await gate({ kind, store });
      const result = await fn();
      log.push(`${kind} ${store} done`);
      return result;
    };

    return {
      match: (key: URL | string) =>
        run('match', () => {
          const entry = entries.get(String(key));
          return entry
            ? new Response(entry.body.slice(0), {
                status: entry.status,
                headers: entry.headers,
              })
            : undefined;
        }),
      put: (key: URL | string, response: Response) =>
        run('put', async () => {
          const headers: [string, string][] = [];
          response.headers.forEach((value, name) => headers.push([name, value]));
          entries.set(String(key), {
            body: await response.arrayBuffer(),
            status: response.status,
            headers,
          });
        }),
      delete: (key: URL | string) =>
        run('delete', () => entries.delete(String(key))),
    };
  };

  return {
    caches: { open: async (name: string) => open(name) },
    log,
    setGate: (next: Gate) => {
      gate = next;
    },
  };
};

let fake: ReturnType<typeof createFakeCaches>;

const settleBackground = async () => {
  while (scheduled.length) {
    await Promise.allSettled(scheduled.splice(0));
  }
};

const never = () => new Promise<void>(() => undefined);

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const TIMED_OUT = Symbol('timed out');

const within = <T>(promise: Promise<T>, ms = 200) =>
  Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms)),
  ]);

const seedEntry = async (
  queryKey: ReadonlyArray<unknown>,
  data: unknown,
  ageSeconds: number
) => {
  const cache = await globalThis.caches.open(DATA_CACHE);
  const headers = new Headers({
    'cache-control': 'max-age=60',
    'cf-workers-query': 'true',
    'cf-workers-query-date': String(Date.now() - ageSeconds * 1000),
  });
  await cache.put(
    new CacheApiAdaptor().buildCacheKey(queryKey),
    new Response(JSON.stringify(data), { headers })
  );
};

const readEntry = (queryKey: ReadonlyArray<unknown>) =>
  new CacheApiAdaptor({ cacheName: DATA_CACHE }).retrieve(queryKey);

const isMarked = (queryKey: ReadonlyArray<unknown>) =>
  new DedupeManager().isProcessing(queryKey);

beforeEach(() => {
  scheduled.length = 0;
  fake = createFakeCaches();
  vi.stubGlobal('caches', fake.caches);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createQuery critical path', () => {
  it('serves a stale hit without waiting on the dedupe check', async () => {
    const queryKey = ['stale-no-wait'];
    await seedEntry(queryKey, { v: 1 }, 10);
    fake.setGate((op) =>
      op.store === 'marker' && op.kind === 'match' ? never() : undefined
    );

    const result = await within(
      createQuery({
        queryKey,
        queryFn: async () => ({ v: 2 }),
        staleTime: 1,
        gcTime: 60,
      })
    );

    expect(result).not.toBe(TIMED_OUT);
    expect(result).toMatchObject({ data: { v: 1 }, source: 'stale' });
  });

  it('runs queryFn without waiting on the dedupe marker write', async () => {
    const queryKey = ['miss-no-marker-wait'];
    fake.setGate((op) =>
      op.store === 'marker' && op.kind === 'put' ? never() : undefined
    );

    const result = await within(
      createQuery({
        queryKey,
        queryFn: async () => ({ v: 1 }),
        staleTime: 30,
        gcTime: 60,
      })
    );

    expect(result).not.toBe(TIMED_OUT);
    expect(result).toMatchObject({ data: { v: 1 }, source: 'miss' });
  });

  it('clears the dedupe marker only after its write has landed', async () => {
    const queryKey = ['marker-order'];
    const markerWrite = deferred();
    fake.setGate((op) =>
      op.store === 'marker' && op.kind === 'put' ? markerWrite.promise : undefined
    );

    const result = await within(
      createQuery({
        queryKey,
        queryFn: async () => ({ v: 1 }),
        staleTime: 30,
        gcTime: 60,
      })
    );
    expect(result).not.toBe(TIMED_OUT);

    markerWrite.resolve();
    await settleBackground();

    const markerWriteDone = fake.log.indexOf('put marker done');
    const markerDeleteStart = fake.log.indexOf('delete marker start');
    expect(markerWriteDone).toBeGreaterThan(-1);
    expect(markerDeleteStart).toBeGreaterThan(markerWriteDone);
    expect(await isMarked(queryKey)).toBe(false);
  });
});

describe('createQuery semantics', () => {
  it('returns the fetched value itself on a miss and caches it', async () => {
    const queryKey = ['miss'];
    const value = { v: 1, nested: { list: [1, 2] } };

    const result = await createQuery({
      queryKey,
      queryFn: async () => value,
      staleTime: 30,
      gcTime: 60,
    });

    expect(result.data).toBe(value);
    expect(result).toMatchObject({
      error: null,
      lastModified: null,
      source: 'miss',
    });
    expect((await readEntry(queryKey))?.data).toEqual(value);
  });

  it('does not resolve a miss before its entry is written', async () => {
    const queryKey = ['miss-write-awaited'];
    const dataWrite = deferred();
    fake.setGate((op) =>
      op.store === 'data' && op.kind === 'put' ? dataWrite.promise : undefined
    );

    const pending = createQuery({
      queryKey,
      queryFn: async () => ({ v: 1 }),
      staleTime: 30,
      gcTime: 60,
    });

    expect(await within(pending, 100)).toBe(TIMED_OUT);
    dataWrite.resolve();
    expect(await pending).toMatchObject({ data: { v: 1 }, source: 'miss' });
  });

  it('serves a read right after a miss from the cache', async () => {
    const queryKey = ['read-your-write'];
    const queryFn = vi.fn(async () => ({ v: 1 }));
    const options = { queryKey, queryFn, staleTime: 30, gcTime: 60 };

    await createQuery(options);
    const second = await createQuery(options);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ data: { v: 1 }, source: 'hit' });
    expect(second.lastModified).toEqual(expect.any(Number));
  });

  it('serves a fresh hit without running queryFn', async () => {
    const queryKey = ['fresh'];
    await seedEntry(queryKey, { v: 1 }, 0);
    const queryFn = vi.fn(async () => ({ v: 2 }));

    const result = await createQuery({
      queryKey,
      queryFn,
      staleTime: 30,
      gcTime: 60,
    });

    expect(result).toMatchObject({ data: { v: 1 }, source: 'hit' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('refreshes a stale entry in the background and clears its marker', async () => {
    const queryKey = ['stale-refresh'];
    await seedEntry(queryKey, { v: 1 }, 10);
    const queryFn = vi.fn(async () => ({ v: 2 }));

    const result = await createQuery({
      queryKey,
      queryFn,
      staleTime: 1,
      gcTime: 60,
    });
    await settleBackground();

    expect(result).toMatchObject({ data: { v: 1 }, source: 'stale' });
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect((await readEntry(queryKey))?.data).toEqual({ v: 2 });
    expect(await isMarked(queryKey)).toBe(false);
  });

  it('skips the background refresh while another one holds the marker', async () => {
    const queryKey = ['stale-deduped'];
    await seedEntry(queryKey, { v: 1 }, 10);
    await new DedupeManager().markProcessing(queryKey);
    const queryFn = vi.fn(async () => ({ v: 2 }));

    const result = await createQuery({
      queryKey,
      queryFn,
      staleTime: 1,
      gcTime: 60,
    });
    await settleBackground();

    expect(result).toMatchObject({ data: { v: 1 }, source: 'stale' });
    expect(queryFn).not.toHaveBeenCalled();
    expect((await readEntry(queryKey))?.data).toEqual({ v: 1 });
    expect(await isMarked(queryKey)).toBe(true);
  });

  it('reports a failed background refresh and keeps the stale entry', async () => {
    const queryKey = ['stale-refresh-fails'];
    await seedEntry(queryKey, { v: 1 }, 10);
    const failure = new Error('boom');
    const onRevalidateError = vi.fn();

    await createQuery({
      queryKey,
      queryFn: async () => {
        throw failure;
      },
      staleTime: 1,
      gcTime: 60,
      onRevalidateError,
    });
    await settleBackground();

    expect(onRevalidateError).toHaveBeenCalledWith(failure, { queryKey });
    expect((await readEntry(queryKey))?.data).toEqual({ v: 1 });
    expect(await isMarked(queryKey)).toBe(false);
  });

  it('rethrows with throwOnError and clears the marker', async () => {
    const queryKey = ['throw'];
    const failure = new Error('boom');

    await expect(
      createQuery({
        queryKey,
        queryFn: async () => {
          throw failure;
        },
        staleTime: 30,
        gcTime: 60,
        throwOnError: true,
      })
    ).rejects.toBe(failure);
    await settleBackground();

    expect(await isMarked(queryKey)).toBe(false);
    expect(await readEntry(queryKey)).toBeNull();
  });

  it('returns the error without throwOnError and caches nothing', async () => {
    const queryKey = ['error'];
    const failure = new Error('boom');

    const result = await createQuery({
      queryKey,
      queryFn: async () => {
        throw failure;
      },
      staleTime: 30,
      gcTime: 60,
    });
    await settleBackground();

    expect(result).toMatchObject({
      data: null,
      error: failure,
      lastModified: null,
      source: 'miss',
    });
    expect(await isMarked(queryKey)).toBe(false);
    expect(await readEntry(queryKey)).toBeNull();
  });

  it('does not cache a value the enabled predicate rejects', async () => {
    const queryKey = ['enabled-rejects'];

    const result = await createQuery<{ v: number } | undefined>({
      queryKey,
      queryFn: async () => undefined,
      staleTime: 30,
      gcTime: 60,
      enabled: (value) => value !== undefined,
    });
    await settleBackground();

    expect(result).toMatchObject({ data: undefined, source: 'miss' });
    expect(await readEntry(queryKey)).toBeNull();
    expect(await isMarked(queryKey)).toBe(false);
  });

  it('drops the entry a miss wrote when it is invalidated right after', async () => {
    const queryKey = ['invalidate'];
    const options = {
      queryKey,
      queryFn: async () => ({ v: 1 }),
      staleTime: 30,
      gcTime: 60,
    };

    const first = await createQuery(options);
    await first.invalidate();
    expect(await readEntry(queryKey)).toBeNull();

    await createQuery(options);
    await invalidateQuery({ queryKey });
    expect(await readEntry(queryKey)).toBeNull();
  });

  it('lets a concurrent miss wait for the first one instead of refetching', async () => {
    const queryKey = ['concurrent-miss'];
    const firstFn = vi.fn(
      () => new Promise<{ v: number }>((r) => setTimeout(() => r({ v: 1 }), 20))
    );
    const secondFn = vi.fn(async () => ({ v: 2 }));

    const first = createQuery({
      queryKey,
      queryFn: firstFn,
      staleTime: 30,
      gcTime: 60,
    });
    await vi.waitFor(() => expect(fake.log).toContain('put marker done'));
    const second = await createQuery({
      queryKey,
      queryFn: secondFn,
      staleTime: 30,
      gcTime: 60,
    });

    expect(await first).toMatchObject({ data: { v: 1 }, source: 'miss' });
    expect(second).toMatchObject({ data: { v: 1 }, source: 'hit' });
    expect(secondFn).not.toHaveBeenCalled();
  });

  it('streams a Response miss and caches its body in the background', async () => {
    const queryKey = ['response'];

    const result = await createQuery<Response>({
      queryKey,
      queryFn: async () =>
        new Response('hello', { status: 201, headers: { 'x-a': '1' } }),
      staleTime: 30,
      gcTime: 60,
    });

    expect(result.source).toBe('miss');
    expect(result.data?.status).toBe(201);
    expect(result.data?.headers.get('x-a')).toBe('1');
    expect(await result.data?.text()).toBe('hello');

    await settleBackground();
    const cached = await readEntry(queryKey);
    expect(await (cached?.data as Response).text()).toBe('hello');
    expect(await isMarked(queryKey)).toBe(false);
  });
});
