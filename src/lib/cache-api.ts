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

const getVoidCache = () => {
  console.warn('No caches API available');

  return {
    put: async (key: URL | string, value: unknown) => {
      return;
    },
    match: async (key: URL | string): Promise<Response | undefined> => {
      return undefined;
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

  constructor(ctx: { cacheName?: string; maxAge?: number } = {}) {
    this.cacheName = ctx.cacheName ?? 'cf-workers-query-cache';
    this.maxAge = ctx.maxAge ?? 60;
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
  ) {
    const cache = await getCache(this.cacheName);

    const maxAge = options?.maxAge ?? this.maxAge;

    const cacheKey = key instanceof URL ? key : this.buildCacheKey(key);

    if (value instanceof Response) {
      const response = new Response(value.body, value);

      const isAlreadyCached = response.headers.get('cf-cache-status') === 'HIT';

      const currentCacheControl = value.headers.get('cache-control');

      response.headers.set('cache-control', `max-age=${maxAge}`);
      response.headers.set(HEADER_DATE, Date.now().toString());

      if (!isAlreadyCached && currentCacheControl) {
        response.headers.set(HEADER_CURRENT_CACHE_CONTROL, currentCacheControl);
      }

      await cache.put(cacheKey, response);
      return;
    }

    const headers = new Headers();

    headers.set('cache-control', `max-age=${maxAge}`);
    headers.set(HEADER, 'true');
    headers.set(HEADER_DATE, Date.now().toString());

    const response = new Response(JSON.stringify(value), {
      headers,
    });

    await cache.put(cacheKey, response);
  }

  public async delete(key: QueryKey) {
    const cache = await getCache(this.cacheName);

    const response = new Response(null, {
      headers: new Headers({
        'cache-control': `max-age=0`,
      }),
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
