export const CACHE_URL = 'INTERNAL_CF_WORKERS_QUERY_CACHE_HOSTNAME.local';

type CachePayload<Data = unknown> = {
  data: Data;
  lastModified: number;
  maxAge: number;
};

export type QueryKey = ReadonlyArray<unknown> | URL;

const getVoidCache = () => {
  console.warn('No caches API available');

  return {
    put: async (key: URL | string, value: unknown) => {
      return;
    },
    match: async (key: URL | string): Promise<Response | undefined> => {
      return undefined;
    }
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

  constructor(ctx: { cacheName?: string; maxAge?: number } = {}) {
    this.cacheName = ctx.cacheName ?? 'cf-workers-query-cache';
    this.maxAge = ctx.maxAge ?? 60;
  }

  public async retrieve<Data = unknown>(
    key: QueryKey,
    options?: { raw?: boolean }
  ): Promise<CachePayload<Data> | null> {
    try {
      const { raw = false } = options ?? {};
      const cache = await getCache(this.cacheName);

      const cacheKey = key instanceof URL ? key : this.buildCacheKey(key);

      const response = await cache.match(cacheKey);

      if (!response) {
        return null;
      }

      const data = (raw ? response : await response.json()) as Data;

      const cacheControlHeader = response.headers.get('cache-control');
      const dateHeader = response.headers.get('date');

      const lastModified = dateHeader ? new Date(dateHeader).getTime() : 0;
      const cacheControl = cacheControlHeader?.split('=')[1];
      const maxAge = Number(cacheControl);

      return {
        data,
        lastModified,
        maxAge: !isNaN(maxAge) ? maxAge : 0
      };
    } catch {
      return null;
    }
  }

  public async update<Data = unknown>(
    key: QueryKey,
    value: Data | Response,
    options?: { maxAge?: number }
  ) {
    const cache = await getCache(this.cacheName);

    const maxAge = options?.maxAge ?? this.maxAge;

    const cacheKey = key instanceof URL ? key : this.buildCacheKey(key);

    if (value instanceof Response) {
      const response = value.clone();

      response.headers.append('cache-control', `max-age=${maxAge}`);

      await cache.put(cacheKey, response);
      return;
    }

    const headers = new Headers();

    headers.append('cache-control', `max-age=${maxAge}`);

    const response = new Response(JSON.stringify(value), {
      headers
    });

    await cache.put(cacheKey, response);
  }

  public async delete(key: QueryKey) {
    const cache = await getCache(this.cacheName);

    const response = new Response(null, {
      headers: new Headers({
        'cache-control': `max-age=0`
      })
    });

    const cacheKey = key instanceof URL ? key : this.buildCacheKey(key);

    await cache.put(cacheKey, response);
  }

  /**
   * Builds the full cache key for the suspense cache.
   *
   * @param key Key for the item in the suspense cache.
   * @returns The fully-formed cache key for the suspense cache.
   */
  public buildCacheKey(key: ReadonlyArray<unknown>) {
    return `https://${CACHE_URL}/entry?key=${hashKey(key)}`;
  }
}

// Copied from: https://github.com/jonschlinkert/is-plain-object
export function isPlainObject(o: any): o is Object {
  if (!hasObjectPrototype(o)) {
    return false;
  }

  // If has no constructor
  const ctor = o.constructor;
  if (ctor === undefined) {
    return true;
  }

  // If has modified prototype
  const prot = ctor.prototype;
  if (!hasObjectPrototype(prot)) {
    return false;
  }

  // If constructor does not have an Object-specific method
  if (!prot.hasOwnProperty('isPrototypeOf')) {
    return false;
  }

  // Handles Objects created by Object.create(<arbitrary prototype>)
  if (Object.getPrototypeOf(o) !== Object.prototype) {
    return false;
  }

  // Most likely a plain Object
  return true;
}

function hasObjectPrototype(o: any): boolean {
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
        }, {} as any)
      : val
  );
}
