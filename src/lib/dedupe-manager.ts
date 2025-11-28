import { CacheApiAdaptor, QueryKey } from './cache-api';

/**
 * Global deduplication manager for query execution
 *
 * Uses CacheApiAdaptor for distributed deduplication across worker requests/instances.
 * 
 * Benefits:
 * - Prevents redundant queries across multiple worker instances via distributed cache
 * - Short-lived cache entries (5s) minimize storage while providing effective deduplication
 * - Uses CacheApiAdaptor for consistent cache management across the library
 * - No global state or timers - works within Cloudflare Workers constraints
 */

export class DedupeManager {
  private readonly CACHE_LOCK_TTL = 5; // 5 seconds
  private lockCache: CacheApiAdaptor;
  private resultCache: CacheApiAdaptor;

  constructor() {
    this.lockCache = new CacheApiAdaptor({
      cacheName: 'cf-workers-query-locks',
      maxAge: this.CACHE_LOCK_TTL
    });
    this.resultCache = new CacheApiAdaptor({
      cacheName: 'cf-workers-query-results',
      maxAge: this.CACHE_LOCK_TTL
    });
  }

  /**
   * Deduplicate async function execution
   *
   * If the same key is requested by multiple workers/requests concurrently:
   * 1. First request acquires lock and executes the function
   * 2. Subsequent requests wait for the result from cache
   *
   * @param key - Unique identifier for the operation (QueryKey or string)
   * @param fn - Async function to deduplicate
   * @returns Result of the function execution
   */
  async dedupe<T>(
    key: QueryKey | string,
    fn: () => Promise<T>
  ): Promise<T> {
    // Try to acquire distributed lock via cache
    const lockAcquired = await this.tryAcquireLock(key);

    if (!lockAcquired) {
      // Another worker/request is handling this, poll for result
      return this.waitForResult<T>(key, fn);
    }

    // We acquired the lock, execute the function
    try {
      const result = await this.executeWithLock<T>(key, fn);
      return result;
    } finally {
      await this.releaseLock(key);
    }
  }

  /**
   * Try to acquire a distributed lock via CacheApiAdaptor
   */
  private async tryAcquireLock(key: QueryKey | string): Promise<boolean> {
    if (!globalThis.caches) {
      // No cache API available, allow execution
      return true;
    }

    try {
      const lockKey = this.buildLockKey(key);

      // Check if lock already exists
      const existing = await this.lockCache.retrieve<{ acquired: number; id: string }>(lockKey);
      if (existing?.data) {
        // Lock already exists
        return false;
      }

      // Try to create lock
      const lockValue = {
        acquired: Date.now(),
        id: Math.random().toString(36).substring(7),
      };

      await this.lockCache.update(lockKey, lockValue);

      // Verify we actually got the lock (handle race conditions)
      const verification = await this.lockCache.retrieve<{ acquired: number; id: string }>(lockKey);
      if (verification?.data) {
        return verification.data.id === lockValue.id;
      }

      return false;
    } catch {
      // On error, allow execution
      return true;
    }
  }

  /**
   * Release the distributed lock
   */
  private async releaseLock(key: QueryKey | string): Promise<void> {
    if (!globalThis.caches) {
      return;
    }

    try {
      const lockKey = this.buildLockKey(key);
      await this.lockCache.delete(lockKey);
    } catch {
      // Ignore errors on cleanup
    }
  }

  /**
   * Execute function with lock held
   */
  private async executeWithLock<T>(
    key: QueryKey | string,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      const result = await fn();

      // Store result briefly in cache for other workers to pick up
      await this.cacheResult(key, result);

      return result;
    } catch (error) {
      // Cache the error as well
      await this.cacheResult(key, { __error: true, error });
      throw error;
    }
  }

  /**
   * Wait for another worker/request to complete the operation
   */
  private async waitForResult<T>(
    key: QueryKey | string,
    fn: () => Promise<T>,
    attempt = 0
  ): Promise<T> {
    const MAX_ATTEMPTS = 20; // 20 * 250ms = 5 seconds max wait
    const RETRY_DELAY = 250; // 250ms

    if (attempt >= MAX_ATTEMPTS) {
      // Timeout waiting, try to execute ourselves
      return this.dedupe(key, fn);
    }

    // Check if result is available in cache
    const cachedResult = await this.getCachedResult<T>(key);
    if (cachedResult !== null) {
      if (this.isErrorResult(cachedResult)) {
        throw cachedResult.error;
      }
      return cachedResult;
    }

    // Wait and retry
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    return this.waitForResult(key, fn, attempt + 1);
  }

  /**
   * Store result in cache for other workers
   */
  private async cacheResult<T>(key: QueryKey | string, result: T): Promise<void> {
    if (!globalThis.caches) {
      return;
    }

    try {
      const resultKey = this.buildResultKey(key);
      await this.resultCache.update(resultKey, result);
    } catch {
      // Ignore cache errors
    }
  }

  /**
   * Get cached result from another worker
   */
  private async getCachedResult<T>(key: QueryKey | string): Promise<T | null> {
    if (!globalThis.caches) {
      return null;
    }

    try {
      const resultKey = this.buildResultKey(key);
      const cached = await this.resultCache.retrieve<T>(resultKey);
      return cached?.data ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a result represents an error
   */
  private isErrorResult(result: any): result is { __error: true; error: any } {
    return result && typeof result === 'object' && result.__error === true;
  }

  /**
   * Build lock key for cache
   */
  private buildLockKey(key: QueryKey | string): QueryKey {
    if (typeof key === 'string') {
      return ['dedupe-lock', key];
    }
    if (key instanceof URL) {
      const url = new URL(key);
      url.searchParams.set('_dedupe', 'lock');
      return url;
    }
    return ['dedupe-lock', ...key];
  }

  /**
   * Build result key for cache
   */
  private buildResultKey(key: QueryKey | string): QueryKey {
    if (typeof key === 'string') {
      return ['dedupe-result', key];
    }
    if (key instanceof URL) {
      const url = new URL(key);
      url.searchParams.set('_dedupe', 'result');
      return url;
    }
    return ['dedupe-result', ...key];
  }
}
