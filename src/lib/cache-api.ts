export const CACHE_URL = 'INTERNAL_CF_WORKERS_QUERY_CACHE_HOSTNAME.local';

const HEADER = 'cf-workers-query';
const HEADER_DATE = 'cf-workers-query-date';
const HEADER_CURRENT_CACHE_CONTROL = 'cf-workers-query-current-cache-control';

type CachePayload<Data = unknown> = {
  data: Data;
  lastModified: number;
  maxAge: number;
};

export type QueryKey = ReadonlyArray<unknown> | URL;

/**
 * Turns a query key into the string that identifies its cache entry. Defaults to
 * `hashKey`, the same stable JSON hash React Query uses.
 *
 * The returned string is interpolated into a URL (see `buildCacheKey`), so a custom
 * implementation MUST return a URL-safe string. `hashKey`'s raw JSON survives only
 * because `new Request()` percent-encodes it on the way in — do not rely on that
 * for your own output.
 *
 * Prefer `baseKey` for the common case of scoping a keyspace; reach for this only
 * when a prefix cannot express what you need.
 */
export type QueryKeyHashFn = (queryKey: ReadonlyArray<unknown>) => string;

/**
 * Prepended to every query key before hashing. See `baseKey` on `defineQueryClient`
 * for why this exists at all: the Cache API is a ZONE store, so entries are shared
 * by every Worker and every deployment on the zone.
 *
 * Restricted to primitives on purpose — a `baseKey` is meant to be readable in a log,
 * and an object's hash stability would depend on `hashKey`'s key sorting.
 */
export type BaseKey = ReadonlyArray<string | number>;

const getVoidCache = () => {
  console.warn('No caches API available');

  return {
    put: async (_key: URL | string, _value: unknown) => {
      return;
    },
    match: async (_key: URL | string): Promise<Response | undefined> => {
      return undefined;
    },
    delete: async (_key: URL | string): Promise<boolean> => {
      return false;
    },
  };
};

const getCache = async (cacheName: string) => {
  if (!globalThis.caches) {
    return getVoidCache();
  }

  return caches.open(cacheName);
};

export class CacheApiAdaptor {
  private cacheName: string;
  private maxAge: number;
  private baseKey: BaseKey;
  private queryKeyHashFn: QueryKeyHashFn;

  constructor(
    ctx: {
      cacheName?: string;
      maxAge?: number;
      baseKey?: BaseKey;
      queryKeyHashFn?: QueryKeyHashFn;
    } = {}
  ) {
    this.cacheName = ctx.cacheName ?? 'cf-workers-query-cache';
    this.maxAge = ctx.maxAge ?? 60;
    this.baseKey = ctx.baseKey ?? [];
    this.queryKeyHashFn = ctx.queryKeyHashFn ?? hashKey;

    // `buildCacheKey` reads instance state as of 0.12, where it used to close over nothing.
    // A detached reference — `const f = cache.buildCacheKey`, `keys.map(cache.buildCacheKey)`,
    // destructuring off the instance — used to work and would now throw on `this`. Bind it so
    // it keeps working, without turning it into an own arrow property (that would stop
    // subclasses overriding it on the prototype).
    this.buildCacheKey = this.buildCacheKey.bind(this);
  }

  public async retrieve<Data = unknown>(
    key: QueryKey
  ): Promise<CachePayload<Data> | null> {
    try {
      const cache = await getCache(this.cacheName);

      const cacheKey = key instanceof URL ? key : this.buildCacheKey(key);

      const response = await cache.match(cacheKey);

      if (!response) {
        return null;
      }

      const createdResponse = response.headers.get(HEADER) === 'true';
      const cacheControlHeader = response.headers.get('cache-control');
      const dateHeader = response.headers.get(HEADER_DATE);

      const data = (
        !createdResponse
          ? new Response(response.body, response)
          : await response.json()
      ) as Data;

      if (!createdResponse) {
        (data as Response).headers.delete(HEADER_DATE);
        (data as Response).headers.delete('cache-control');

        const currentCacheControl = response.headers.get(
          HEADER_CURRENT_CACHE_CONTROL
        );
        if (currentCacheControl) {
          (data as Response).headers.set('cache-control', currentCacheControl);
          (data as Response).headers.delete(HEADER_CURRENT_CACHE_CONTROL);
        }
      }

      const lastModified = Number(dateHeader);
      const cacheControl = cacheControlHeader?.split('=')[1];
      const maxAge = Number(cacheControl);

      return {
        data,
        lastModified: !isNaN(lastModified) ? lastModified : 0,
        maxAge: !isNaN(maxAge) ? maxAge : 0,
      };
    } catch {
      return null;
    }
  }

  public async update<Data = unknown>(
    key: QueryKey,
    value: Data | Response,
    options?: { maxAge?: number }
  ): Promise<Data> {
    const maxAge = options?.maxAge ?? this.maxAge;

    const cacheKey = key instanceof URL ? key : this.buildCacheKey(key);

    if (value instanceof Response) {
      const body = await value.arrayBuffer();
      const init = { status: value.status, statusText: value.statusText };

      const isAlreadyCached = value.headers.get('cf-cache-status') === 'HIT';
      const currentCacheControl = value.headers.get('cache-control');

      const cacheHeaders = new Headers(value.headers);
      cacheHeaders.set('cache-control', `max-age=${maxAge}`);
      cacheHeaders.set(HEADER_DATE, Date.now().toString());

      if (!isAlreadyCached && currentCacheControl) {
        cacheHeaders.set(HEADER_CURRENT_CACHE_CONTROL, currentCacheControl);
      }

      const openCache = await getCache(this.cacheName);
      await openCache.put(
        cacheKey,
        new Response(body, { ...init, headers: cacheHeaders })
      );

      return new Response(body, {
        ...init,
        headers: new Headers(value.headers),
      }) as Data;
    }

    const headers = new Headers();

    headers.set('cache-control', `max-age=${maxAge}`);
    headers.set(HEADER, 'true');
    headers.set(HEADER_DATE, Date.now().toString());

    const openCache = await getCache(this.cacheName);
    await openCache.put(
      cacheKey,
      new Response(JSON.stringify(value), { headers })
    );

    return value as Data;
  }

  public async delete(key: QueryKey) {
    const cache = await getCache(this.cacheName);
    const cacheKey = key instanceof URL ? key : this.buildCacheKey(key);
    await cache.delete(cacheKey);
  }

  /**
   * Builds the full cache key for the suspense cache.
   *
   * The single choke point for cache identity: `retrieve`, `update`, `delete` and
   * `DedupeManager`'s markers all route through here, so `baseKey` and
   * `queryKeyHashFn` scope entries, invalidations and dedupe markers together —
   * there is no second place a key can be derived, and so no way for a read and its
   * invalidation to disagree.
   *
   * With no `baseKey` and no custom hash this is byte-identical to what every
   * version before 0.12 produced, so upgrading never orphans a warm cache.
   *
   * @param key Key for the item in the suspense cache.
   * @returns The fully-formed cache key for the suspense cache.
   */
  public buildCacheKey(key: ReadonlyArray<unknown>) {
    const scoped = this.baseKey.length ? [...this.baseKey, ...key] : key;

    return `https://${CACHE_URL}/entry?key=${this.queryKeyHashFn(scoped)}`;
  }
}

// Copied from: https://github.com/jonschlinkert/is-plain-object
export function isPlainObject(o: unknown): o is Record<string, unknown> {
  if (!hasObjectPrototype(o)) {
    return false;
  }

  const obj = o as Record<string, unknown>;

  // If has no constructor
  const ctor = obj.constructor;
  if (ctor === undefined) {
    return true;
  }

  // If has modified prototype
  const prot = (ctor as { prototype?: unknown }).prototype;
  if (!hasObjectPrototype(prot)) {
    return false;
  }

  // If constructor does not have an Object-specific method
  if (
    !Object.prototype.hasOwnProperty.call(prot, 'isPrototypeOf')
  ) {
    return false;
  }

  // Handles Objects created by Object.create(<arbitrary prototype>)
  if (Object.getPrototypeOf(o) !== Object.prototype) {
    return false;
  }

  // Most likely a plain Object
  return true;
}

function hasObjectPrototype(o: unknown): boolean {
  return Object.prototype.toString.call(o) === '[object Object]';
}

/**
 * Default query & mutation keys hash function.
 * Hashes the value into a stable hash.
 */
export function hashKey(queryKey: ReadonlyArray<unknown>): string {
  return JSON.stringify(queryKey, (_, val) =>
    isPlainObject(val)
      ? Object.keys(val)
          .sort()
          .reduce((result, key) => {
            result[key] = val[key];
            return result;
          }, {} as Record<string, unknown>)
      : val
  );
}
