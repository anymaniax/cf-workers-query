import {
  BaseKey,
  CacheApiAdaptor,
  QueryKey,
  QueryKeyHashFn,
} from './cache-api';

/**
 * Best-effort deduplication manager for query execution.
 *
 * Uses a short-lived "processing" marker in Cache API to signal
 * that a query is already being fetched. This is not atomic
 * (CF Cache API has no CAS operations) but dramatically reduces
 * redundant work in practice.
 *
 * The markers need the SAME scoping as the entries they guard. A marker is stored in
 * the zone-wide Cache API like anything else, so an unscoped one lets one deployment's
 * in-flight revalidation suppress another's — the second sees `isProcessing` and skips
 * its own refresh, for a key it does not even share.
 */
export class DedupeManager {
  private cache: CacheApiAdaptor;

  /**
   * `ctx` also accepts a bare cache-name string: that was the whole signature before 0.12
   * and this class is a public export, so dropping it would break callers for no gain.
   */
  constructor(
    ctx:
      | string
      | {
          cacheName?: string;
          baseKey?: BaseKey;
          queryKeyHashFn?: QueryKeyHashFn;
        } = {}
  ) {
    // `?? {}` because `typeof null === 'object'`: `new DedupeManager(null)` (or `0`, or any
    // other falsy non-string) used to fall through to the default cache name and must keep
    // doing so, not throw on a property read.
    const options = typeof ctx === 'string' ? { cacheName: ctx } : (ctx ?? {});

    this.cache = new CacheApiAdaptor({
      cacheName: options.cacheName ?? 'cf-workers-query-dedup',
      maxAge: 10,
      baseKey: 'baseKey' in options ? options.baseKey : undefined,
      queryKeyHashFn:
        'queryKeyHashFn' in options ? options.queryKeyHashFn : undefined,
    });
  }

  /**
   * Check if someone is already processing this key.
   * Best-effort: small race window exists between check and mark.
   */
  async isProcessing(key: QueryKey): Promise<boolean> {
    const markerKey = this.buildMarkerKey(key);
    const existing = await this.cache.retrieve(markerKey);
    return !!existing?.data;
  }

  async markProcessing(key: QueryKey): Promise<void> {
    const markerKey = this.buildMarkerKey(key);
    await this.cache.update(markerKey, { ts: Date.now() });
  }

  async clearProcessing(key: QueryKey): Promise<void> {
    const markerKey = this.buildMarkerKey(key);
    await this.cache.delete(markerKey);
  }

  private buildMarkerKey(key: QueryKey): ReadonlyArray<unknown> {
    if (key instanceof URL) return ['dedup-marker', key.toString()];
    return ['dedup-marker', ...key];
  }
}
