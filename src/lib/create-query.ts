import { CacheApiAdaptor, QueryKey } from './cache-api';
import { DedupeManager } from './dedupe-manager';

/**
 * `waitUntil` (from the `cloudflare:workers` builtin) keeps background work —
 * SWR revalidation and dedupe-marker cleanup — alive after the response is sent.
 * That builtin only exists in the Worker runtime, so a *static* top-level
 * `import { waitUntil } from 'cloudflare:workers'` forces every consumer bundle
 * that transitively imports `createQuery` — including browser/client bundles — to
 * resolve the specifier, which fails outside a Worker (e.g. Vite/Rolldown:
 * "failed to resolve import 'cloudflare:workers'").
 *
 * We resolve it lazily through a dynamic import with a non-statically-analysable
 * specifier, pre-warmed at module load: bundlers leave it as a runtime import, so
 * non-Worker bundles build cleanly. The Worker resolves the real,
 * request-context-aware implementation; off-Worker the import rejects and we fall
 * back to a no-op (background revalidation simply does not run there).
 */
type WaitUntil = (promise: Promise<unknown>) => void;

let waitUntilImpl: WaitUntil = () => {};

// Built from parts so neither the library build (tsup/esbuild) nor a consumer
// bundler can fold this back into a static `cloudflare:workers` import.
const cloudflareWorkersModule = ['cloudflare', 'workers'].join(':');

void import(/* @vite-ignore */ cloudflareWorkersModule)
  .then((mod: { waitUntil?: WaitUntil }) => {
    if (typeof mod?.waitUntil === 'function') {
      waitUntilImpl = mod.waitUntil;
    }
  })
  .catch(() => {
    // Off-Worker (browser/Node): keep the no-op.
  });

const waitUntil: WaitUntil = (promise) => {
  waitUntilImpl(promise);
};

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
