import { waitUntil } from 'cloudflare:workers';
import { CacheApiAdaptor, QueryKey } from './cache-api';
import { DedupeManager } from './dedupe-manager';

export type RetryDelay<TError = unknown> =
  | number
  | ((failureCount: number, error: TError) => number);

export type CreateQuery<Data = unknown, TError = unknown> = {
  queryKey?: QueryKey | null;
  queryFn: () => Promise<Data>;
  staleTime?: number;
  gcTime?: number;
  revalidate?: boolean;
  retry?: number | ((failureCount: number, error: TError) => boolean);
  retryDelay?: RetryDelay<TError>;
  cacheName?: string;
  throwOnError?: boolean;
  enabled?: boolean | ((data: Data) => boolean);
  revalidateMode?: 'default' | 'probabilistic';
};

const dedupeManager = new DedupeManager();

export const createQuery = async <Data = unknown, TError = unknown>({
  queryKey,
  queryFn,
  gcTime,
  staleTime,
  revalidate,
  retry,
  retryDelay,
  cacheName,
  throwOnError,
  enabled = true,
  revalidateMode = 'default',
}: CreateQuery<Data, TError>): Promise<{
  data: Data | null;
  error: TError | null;
  invalidate: () => Promise<void> | void;
  lastModified: number | null;
}> => {
  try {
    if (!queryKey || !enabled || !gcTime) {
      const { data, error } = await handleQueryFnWithRetry<Data, TError>({
        queryFn,
        retry,
        retryDelay,
        throwOnError,
      });

      return { data, error, invalidate: () => undefined, lastModified: null };
    }

    const cache = new CacheApiAdaptor({ maxAge: gcTime, cacheName });

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

    const { data: fetchedData, error } = await handleQueryFnWithRetry<
      Data,
      TError
    >({
      queryFn,
      retry,
      retryDelay,
      throwOnError,
    });

    let data: Data | null = fetchedData;

    if (error) {
      waitUntil(dedupeManager.clearProcessing(cacheKey).catch(() => {}));
      return {
        data: null,
        error,
        invalidate: () => undefined,
        lastModified: null,
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
              } catch {
                reader.releaseLock();
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

    return { data, error: null, invalidate, lastModified: null };
  } catch (e) {
    if (throwOnError) {
      throw e;
    }

    return {
      data: null,
      error: e as TError,
      invalidate: () => undefined,
      lastModified: null,
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
