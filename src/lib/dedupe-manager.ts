import { CacheApiAdaptor, QueryKey } from './cache-api';

/**
 * Global deduplication manager for query execution
 * 
 * This module provides a two-tier deduplication strategy:
 * 1. In-memory Map for same-request deduplication (within a single worker instance)
 * 2. CacheApiAdaptor for cross-request/cross-worker deduplication
 * 
 * Benefits:
 * - Prevents multiple concurrent identical queries in the same worker instance
 * - Prevents redundant queries across multiple worker instances via distributed cache
 * - Automatically cleans up completed promises from memory
 * - Short-lived cache entries (5s) minimize storage while providing effective deduplication
 * - Uses CacheApiAdaptor for consistent cache management across the library
 */

type PendingPromise<T = unknown> = {
  promise: Promise<T>;
  timestamp: number;
};

class DedupeManager {
  private pendingPromises = new Map<string, PendingPromise>();
  private readonly PENDING_CLEANUP_INTERVAL = 5000; // 5 seconds
  private readonly CACHE_LOCK_TTL = 5; // 5 seconds
  private cleanupTimer: NodeJS.Timeout | number | null = null;
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
    this.startCleanup();
  }

  /**
   * Deduplicate async function execution
   * 
   * If the same key is requested multiple times concurrently:
   * 1. First request executes the function
   * 2. Subsequent requests wait for the first request to complete
   * 
   * @param key - Unique identifier for the operation (QueryKey or string)
   * @param fn - Async function to deduplicate
   * @returns Result of the function execution
   */
  async dedupe<T>(
    key: QueryKey | string,
    fn: () => Promise<T>
  ): Promise<T> {
    const stringKey = this.normalizeKey(key);
    
    // Check in-memory pending promises first (fastest)
    const pending = this.pendingPromises.get(stringKey);
    if (pending) {
      return pending.promise as Promise<T>;
    }

    // Try to acquire distributed lock via cache
    const lockAcquired = await this.tryAcquireLock(key);
    
    if (!lockAcquired) {
      // Another worker/request is handling this, poll for result
      return this.waitForResult<T>(key, fn);
    }

    // We acquired the lock, execute the function
    const promise = this.executeWithLock<T>(key, fn);
    
    this.pendingPromises.set(stringKey, {
      promise: promise as Promise<unknown>,
      timestamp: Date.now(),
    });

    try {
      const result = await promise;
      return result;
    } finally {
      // Clean up this specific promise
      this.pendingPromises.delete(stringKey);
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
   * Normalize a key to a string for in-memory map
   */
  private normalizeKey(key: QueryKey | string): string {
    if (typeof key === 'string') {
      return key;
    }
    if (key instanceof URL) {
      return key.toString();
    }
    return JSON.stringify(key);
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

  /**
   * Periodically clean up old pending promises from memory
   */
  private startCleanup(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const toDelete: string[] = [];

      for (const [key, pending] of this.pendingPromises.entries()) {
        if (now - pending.timestamp > this.PENDING_CLEANUP_INTERVAL) {
          toDelete.push(key);
        }
      }

      toDelete.forEach(key => this.pendingPromises.delete(key));
    }, this.PENDING_CLEANUP_INTERVAL) as any;
  }

  /**
   * Stop cleanup timer (for testing or shutdown)
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer as any);
      this.cleanupTimer = null;
    }
  }

  /**
   * Clear all pending promises (for testing)
   */
  clear(): void {
    this.pendingPromises.clear();
  }

  /**
   * Get current pending count (for debugging/testing)
   */
  getPendingCount(): number {
    return this.pendingPromises.size;
  }
}

// Export singleton instance
export const dedupeManager = new DedupeManager();
