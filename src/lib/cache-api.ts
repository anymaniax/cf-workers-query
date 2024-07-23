export const CACHE_URL = 'INTERNAL_CF_WORKERS_QUERY_CACHE_HOSTNAME.local';

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

    const response = await cache.match(this.buildCacheKey(key));
    return response ? response.json() : null;
  }

  public async update<Data = unknown>(
    key: QueryKey,
    value: Data,
    options?: { maxAge?: number }
  ) {
    const cache = await caches.open(this.cacheName);

    const maxAge = options?.maxAge ?? this.maxAge;

    const payload: CachePayload = {
      data: value,
      lastModified: Date.now(),
      maxAge,
    };

    const response = new Response(JSON.stringify(payload), {
      headers: new Headers({
        'cache-control': `max-age=${maxAge}`,
      }),
    });
    await cache.put(this.buildCacheKey(key), response);
  }

  public async delete(key: QueryKey) {
    const cache = await caches.open(this.cacheName);

    const response = new Response(null, {
      headers: new Headers({
        'cache-control': `max-age=0`,
      }),
    });

    await cache.put(this.buildCacheKey(key), response);
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
