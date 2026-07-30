import {
  BaseKey,
  CacheApiAdaptor,
  QueryKey,
  QueryKeyHashFn,
} from './cache-api';
import { DedupeManager } from './dedupe-manager';
import { waitUntil } from './wait-until';

export type RetryDelay<TError = unknown> =
  | number
  | ((failureCount: number, error: TError) => number);

/**
 * Where the returned data came from. Cheap to log, and the difference between a
 * five-minute debugging session and a three-hour one: without it a stale value, a
 * fresh value and a value from someone else's cache entry all look identical.
 *
 * - `hit`      — served from cache, still fresh
 * - `stale`    — served from cache past `staleTime`; a refresh is running in the background
 * - `miss`     — `queryFn` ran for this request
 * - `uncached` — caching was skipped entirely (no `queryKey`, no `gcTime`, or `enabled: false`)
 */
export type QuerySource = 'hit' | 'stale' | 'miss' | 'uncached';

export type QueryResult<Data = unknown, TError = unknown> = {
  data: Data | null;
  error: TError | null;
  invalidate: () => Promise<void> | void;
  lastModified: number | null;
  /**
   * ALWAYS populated at runtime. Optional in the type only so that code written against a
   * pre-0.12 result — a test mock, a wrapper declaring this type as its return type — keeps
   * compiling: adding a required member to a type consumers may CONSTRUCT is a breaking
   * change, however additive it looks from the reading side.
   */
  source?: QuerySource;
};

export type CreateQuery<Data = unknown, TError = unknown> = {
  queryKey?: QueryKey | null;
  queryFn: () => Promise<Data>;
  staleTime?: number;
  gcTime?: number;
  revalidate?: boolean;
  retry?: number | ((failureCount: number, error: TError) => boolean);
  retryDelay?: RetryDelay<TError>;
  cacheName?: string;
  /**
   * Prepended to `queryKey` before hashing. The Cache API is a ZONE store, so every
   * Worker and every deployment sharing the zone reads the same entries — see
   * `defineQueryClient`, which is the intended way to set this once per deployment.
   */
  baseKey?: BaseKey;
  /** Escape hatch under `baseKey`. Must return a URL-safe string. */
  queryKeyHashFn?: QueryKeyHashFn;
  throwOnError?: boolean;
  /**
   * Controls CACHING, not whether the query runs.
   *
   * NOTE this differs from React Query, where `enabled: false` means the query does not
   * execute. Here `queryFn` ALWAYS runs — `false` only bypasses the cache entirely, and a
   * predicate decides whether a given value is worth storing (and whether a stored one is
   * worth returning). There is no reactive observer to defer to, so "don't run" is
   * something the caller expresses with an `if`, not with an option.
   */
  enabled?: boolean | ((data: Data) => boolean);
  revalidateMode?: 'default' | 'probabilistic';
  /**
   * Called when a background revalidation fails. The stale entry is kept and the next
   * request retries, so this is never fatal — but without a hook the failure is
   * completely invisible, and an entry that keeps failing to refresh stays stale until
   * `gcTime`, which can be hours.
   *
   * Must not throw; a throw here is swallowed.
   */
  onRevalidateError?: (
    error: unknown,
    context: { queryKey: QueryKey }
  ) => void;
};

export const createQuery = async <Data = unknown, TError = unknown>({
  queryKey,
  queryFn,
  gcTime,
  staleTime,
  revalidate,
  retry,
  retryDelay,
  cacheName,
  baseKey,
  queryKeyHashFn,
  throwOnError,
  enabled = true,
  revalidateMode = 'default',
  onRevalidateError,
}: CreateQuery<Data, TError>): Promise<QueryResult<Data, TError>> => {
  try {
    if (!queryKey || !enabled || !gcTime) {
      const { data, error } = await handleQueryFnWithRetry<Data, TError>({
        queryFn,
        retry,
        retryDelay,
        throwOnError,
      });

      return {
        data,
        error,
        invalidate: () => undefined,
        lastModified: null,
        source: 'uncached',
      };
    }

    const cache = new CacheApiAdaptor({
      maxAge: gcTime,
      cacheName,
      baseKey,
      queryKeyHashFn,
    });

    // Scoped exactly like the entries it guards: an unscoped marker lets one
    // deployment's in-flight revalidation suppress another deployment's.
    const dedupeManager = new DedupeManager({ baseKey, queryKeyHashFn });

    const cacheKey = queryKey;
    const invalidate = () => cache.delete(cacheKey);

    if (!revalidate && staleTime !== 0) {
      const cachedData = await cache.retrieve<Data>(cacheKey);

      if (cachedData?.data) {
        const isStale =
          staleTime && cachedData.lastModified + staleTime * 1000 < Date.now();

        if (isStale) {
          const shouldRevalidate =
            revalidateMode === 'probabilistic'
              ? shouldRevalidateByProbability(
                  cachedData.lastModified,
                  cachedData.maxAge
                )
              : true;

          if (shouldRevalidate) {
            let alreadyRefreshing = false;
            try {
              alreadyRefreshing = await dedupeManager.isProcessing(cacheKey);
            } catch {
              // Best-effort dedup
            }
            if (!alreadyRefreshing) {
              waitUntil(
                (async () => {
                  await dedupeManager.markProcessing(cacheKey).catch(() => {});
                  try {
                    const newData = await queryFn();
                    await cache.update(cacheKey, newData);
                  } catch (revalidateError) {
                    // Background revalidation failed (queryFn threw, or its
                    // Response body was already consumed by the foreground
                    // response). The foreground already served the stale entry,
                    // so swallow it and keep the stale value — the next request
                    // retries. Never let this reject into `waitUntil`: the
                    // runtime logs an unhandled `waitUntil` rejection as an
                    // exception even though nothing user-facing went wrong.
                    //
                    // Swallowed is not the same as unreportable, though: hand it
                    // to the caller's hook so a key that never manages to refresh
                    // is observable instead of silently stale until `gcTime`.
                    try {
                      onRevalidateError?.(revalidateError, {
                        queryKey: cacheKey,
                      });
                    } catch {
                      // A throwing hook must not resurrect the rejection we just
                      // went out of our way to contain.
                    }
                  } finally {
                    await dedupeManager
                      .clearProcessing(cacheKey)
                      .catch(() => {});
                  }
                })()
              );
            }
          }
        }

        if (typeof enabled !== 'function' || enabled(cachedData.data)) {
          return {
            data: cachedData.data,
            error: null,
            invalidate,
            lastModified: cachedData.lastModified,
            source: isStale ? 'stale' : 'hit',
          };
        }
      }
    }

    // Initial fetch path - best-effort dedup (never blocks response on cache failures)
    try {
      const alreadyProcessing = await dedupeManager.isProcessing(cacheKey);
      if (alreadyProcessing) {
        await new Promise((r) => setTimeout(r, 50));
        const freshCache = await cache.retrieve<Data>(cacheKey);
        if (freshCache?.data) {
          return {
            data: freshCache.data,
            error: null,
            invalidate,
            lastModified: freshCache.lastModified,
            source: 'hit',
          };
        }
      }
    } catch {
      // Cache API issue - proceed with fetch
    }

    try {
      await dedupeManager.markProcessing(cacheKey);
    } catch {
      // Best-effort, proceed without marker
    }

    let fetched: { data: Data | null; error: TError | null };
    try {
      fetched = await handleQueryFnWithRetry<Data, TError>({
        queryFn,
        retry,
        retryDelay,
        throwOnError,
      });
    } catch (e) {
      // throwOnError path — clear the dedupe marker before rethrowing so
      // subsequent requests for this key don't wait on a stale marker.
      waitUntil(dedupeManager.clearProcessing(cacheKey).catch(() => {}));
      throw e;
    }
    const { data: fetchedData, error } = fetched;

    let data: Data | null = fetchedData;

    if (error) {
      waitUntil(dedupeManager.clearProcessing(cacheKey).catch(() => {}));
      return {
        data: null,
        error,
        invalidate: () => undefined,
        lastModified: null,
        source: 'miss',
      };
    }

    if (typeof enabled !== 'function' || enabled(data as Data)) {
      if (data instanceof Response && data.body) {
        const chunks: Uint8Array[] = [];
        let totalLength = 0;
        let pumpSuccess = false;
        let pumpResolve: () => void;
        const pumpDone = new Promise<void>((r) => {
          pumpResolve = r;
        });

        const reader = (data as Response).body!.getReader();

        const readable = new ReadableStream<Uint8Array>({
          start(controller) {
            (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    controller.close();
                    pumpSuccess = true;
                    break;
                  }
                  chunks.push(new Uint8Array(value));
                  totalLength += value.byteLength;
                  controller.enqueue(value);
                }
              } catch (pumpError) {
                reader.releaseLock();
                try {
                  // Propagate upstream failures so the client response aborts
                  // instead of stalling open forever.
                  controller.error(pumpError);
                } catch {
                  // Controller already closed/errored
                }
              }
              pumpResolve();
            })();
          },
          cancel() {
            reader.cancel().catch(() => {});
            pumpResolve();
          },
        });

        const responseInit = {
          status: (data as Response).status,
          statusText: (data as Response).statusText,
          headers: (data as Response).headers,
        };

        waitUntil(
          pumpDone.then(async () => {
            try {
              if (pumpSuccess) {
                const buffer = concatUint8Arrays(chunks, totalLength);
                await cache.update(
                  cacheKey,
                  new Response(buffer, responseInit)
                );
              }
            } finally {
              await dedupeManager.clearProcessing(cacheKey).catch(() => {});
            }
          })
        );

        data = new Response(readable, responseInit) as Data;
      } else {
        data = await cache.update<Data>(cacheKey, data as Data);
        waitUntil(dedupeManager.clearProcessing(cacheKey).catch(() => {}));
      }
    } else {
      waitUntil(dedupeManager.clearProcessing(cacheKey).catch(() => {}));
    }

    // `lastModified` stays NULL here even though we know the timestamp we just wrote.
    // In the wild it is read as a cache-hit predicate — `lastModified !== null` meaning
    // "there was an entry" — so putting a number on the fetch path silently inverts every
    // such check. Use `source` for that; the two would be redundant anyway, and only one
    // of them is backwards compatible.
    return { data, error: null, invalidate, lastModified: null, source: 'miss' };
  } catch (e) {
    if (throwOnError) {
      throw e;
    }

    return {
      data: null,
      error: e as TError,
      invalidate: () => undefined,
      lastModified: null,
      source: 'miss',
    };
  }
};

const defaultRetryDelay = (attemptIndex: number) =>
  Math.min(1000 * 2 ** attemptIndex, 30000);

function handleRetryDelay<TError = unknown>(
  failureCount: number,
  error: TError,
  retryDelay: RetryDelay<TError> = defaultRetryDelay
) {
  const timeMs =
    typeof retryDelay === 'function'
      ? retryDelay(failureCount + 1, error)
      : retryDelay;

  return new Promise((resolve) => {
    setTimeout(resolve, timeMs);
  });
}

const handleQueryFnWithRetry = async <Data = unknown, TError = unknown>({
  queryFn,
  retry = 0,
  failureCount = 0,
  retryDelay,
  throwOnError,
}: {
  queryFn: () => Promise<Data>;
  retry?: number | ((failureCount: number, error: TError) => boolean);
  failureCount?: number;
  retryDelay?: RetryDelay<TError>;
  throwOnError?: boolean;
}): Promise<{ data: Data | null; error: TError | null }> => {
  try {
    const data = await queryFn();
    return { data, error: null };
  } catch (e) {
    if (typeof retry === 'number' && retry > 0) {
      await handleRetryDelay(failureCount, e as TError, retryDelay);
      return handleQueryFnWithRetry({
        queryFn,
        retry: retry - 1,
        failureCount: failureCount + 1,
        retryDelay,
        throwOnError,
      });
    }

    if (typeof retry === 'function' && retry(failureCount + 1, e as TError)) {
      await handleRetryDelay(failureCount, e as TError, retryDelay);
      return handleQueryFnWithRetry({
        queryFn,
        retry,
        failureCount: failureCount + 1,
        retryDelay,
        throwOnError,
      });
    }

    if (throwOnError) {
      throw e;
    }

    return { data: null, error: e as TError };
  }
};

function concatUint8Arrays(
  chunks: Uint8Array[],
  totalLength: number
): ArrayBuffer {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer as ArrayBuffer;
}

// based on https://blog.cloudflare.com/sometimes-i-cache
// https://cseweb.ucsd.edu/~avattani/papers/cache_stampede.pdf
function shouldRevalidateByProbability(lastModified: number, maxAge: number) {
  const expirationDate = new Date(lastModified + maxAge * 1000);
  const remainingCacheTimeInS = (expirationDate.getTime() - Date.now()) / 1000;

  const cacheRevalidationIntervalInS = maxAge;

  if (remainingCacheTimeInS > cacheRevalidationIntervalInS) {
    return false;
  }
  if (remainingCacheTimeInS <= 0) {
    return true;
  }

  const revalidationSteepness = 1 / cacheRevalidationIntervalInS;

  // p(t) is evaluated here
  return (
    Math.random() >
    Math.exp(
      -revalidationSteepness *
        (cacheRevalidationIntervalInS - remainingCacheTimeInS)
    )
  );
}
