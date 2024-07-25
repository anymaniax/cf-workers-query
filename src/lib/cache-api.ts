export const CACHE_URL = 'INTERNAL_CF_WORKERS_QUERY_CACHE_HOSTNAME.local';

const CACHE_LAST_MODIFIED_HEADER = 'cf-workers-query-cache-last-modified';

type CachePayload<Data = unknown> = {
  data: Data;
  lastModified: number;
  maxAge: number;
};

export type QueryKey = Array<string | boolean | number>;

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
    const cache = await caches.open(this.cacheName);

    const cacheKey = key instanceof URL ? key : this.buildCacheKey(key);

    const response = await cache.match(cacheKey);

    if (!response) {
      return null;
    }

    const data = await response.json();

    const lastModifiedHeader = response.headers.get(CACHE_LAST_MODIFIED_HEADER);
    const cacheControlHeader = response.headers.get('cache-control');

    const lastModified = Number(lastModifiedHeader);
    const cacheControl = cacheControlHeader?.split('=')[1];
    const maxAge = Number(cacheControl);

    return {
      data,
      lastModified: !isNaN(lastModified) ? lastModified : 0,
      maxAge: !isNaN(maxAge) ? maxAge : 0,
    };
  }

  public async update<Data = unknown>(
    key: QueryKey,
    value: Data | Response,
    options?: { maxAge?: number }
  ) {
    const cache = await caches.open(this.cacheName);

    const maxAge = options?.maxAge ?? this.maxAge;

    const cacheKey = key instanceof URL ? key : this.buildCacheKey(key);

    if (value instanceof Response) {
      value.headers.set('cache-control', `max-age=${maxAge}`);
      value.headers.set(CACHE_LAST_MODIFIED_HEADER, Date.now().toString());

      await cache.put(cacheKey, value);
      return;
    }

    const headers = new Headers();

    headers.set('cache-control', `max-age=${maxAge}`);
    headers.set(CACHE_LAST_MODIFIED_HEADER, Date.now().toString());

    const response = new Response(JSON.stringify(value), {
      headers,
    });

    await cache.put(cacheKey, response);
  }

  public async delete(key: QueryKey) {
    const cache = await caches.open(this.cacheName);

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
  public buildCacheKey(key: QueryKey) {
    return `https://${CACHE_URL}/entry/${key.join('/')}`;
  }
}
