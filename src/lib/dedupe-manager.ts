import { CacheApiAdaptor, QueryKey } from './cache-api';

/**
 * Best-effort deduplication manager for query execution.
 *
 * Uses a short-lived "processing" marker in Cache API to signal
 * that a query is already being fetched. This is not atomic
 * (CF Cache API has no CAS operations) but dramatically reduces
 * redundant work in practice.
 */
export class DedupeManager {
  private cache: CacheApiAdaptor;

  constructor(cacheName = 'cf-workers-query-dedup') {
    this.cache = new CacheApiAdaptor({ cacheName, maxAge: 10 });
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
