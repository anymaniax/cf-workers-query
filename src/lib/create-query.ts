import { waitUntil } from 'cloudflare:workers';
import { nanoid } from 'nanoid';
import { CacheApiAdaptor, QueryKey } from './cache-api';
import { DedupeManager } from './dedupe-manager';

export type RetryDelay<Error = unknown> =
  | number
  | ((failureCount: number, error: Error) => number);

export type CreateQuery<Data = unknown, Error = unknown> = {
  queryKey?: QueryKey | null;
  queryFn: () => Promise<Data>;
  staleTime?: number;
  gcTime?: number;
  revalidate?: boolean;
  retry?: number | ((failureCount: number, error: Error) => boolean);
  retryDelay?: RetryDelay<Error>;
  cacheName?: string;
  throwOnError?: boolean;
  enabled?: boolean | ((data: Data) => boolean);
  revalidateMode?: 'default' | 'probabilistic';
};

export const createQuery = async <Data = unknown, Error = unknown>({
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
}: CreateQuery<Data, Error>): Promise<{
  data: Data | null;
  error: Error | null;
  invalidate: () => Promise<void> | void;
  lastModified: number | null;
}> => {
  const dedupeManager = new DedupeManager();

  try {
    if (!queryKey || !enabled || !gcTime) {
      const { data, error } = await dedupeManager.dedupe(
        queryKey ?? nanoid(),
        () =>
          handleQueryFnWithRetry<Data, Error>({
            queryFn,
            retry,
            retryDelay,
            throwOnError,
          })
      );

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
            const refreshFunc = async () => {
              const refreshKey =
                cacheKey instanceof URL
                  ? new URL(cacheKey.toString() + ':refresh')
                  : [...cacheKey, 'refresh'];

              await dedupeManager.dedupe(refreshKey, async () => {
                const newData = await queryFn();
                await cache.update(cacheKey, newData);
                return { data: newData, error: null };
              });
            };

            waitUntil(refreshFunc());
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

    const { data, error } = await dedupeManager.dedupe(cacheKey, () =>
      handleQueryFnWithRetry<Data, Error>({
        queryFn,
        retry,
        retryDelay,
        throwOnError,
      })
    );

    if (error) {
      return {
        data: null,
        error,
        invalidate: () => undefined,
        lastModified: null,
      };
    }

    if (typeof enabled !== 'function' || enabled(data)) {
      const cacheData = data instanceof Response ? data.clone() : data;

      waitUntil(cache.update<Data>(cacheKey, cacheData));
    }

    return { data, error: null, invalidate, lastModified: null };
  } catch (e) {
    if (throwOnError) {
      throw e;
    }

    return {
      data: null,
      error: e as Error,
      invalidate: () => undefined,
      lastModified: null,
    };
  }
};

const defaultRetryDelay = (attemptIndex: number) =>
  Math.min(1000 * 2 ** attemptIndex, 30000);

function handleRetryDelay<Error = unknown>(
  failureCount: number,
  error: Error,
  retryDelay: RetryDelay<Error> = defaultRetryDelay
) {
  const timeMs =
    typeof retryDelay === 'function'
      ? retryDelay(failureCount + 1, error)
      : retryDelay;

  return new Promise((resolve) => {
    setTimeout(resolve, timeMs);
  });
}

const handleQueryFnWithRetry = async <Data = unknown, Error = unknown>({
  queryFn,
  retry = 0,
  failureCount = 0,
  retryDelay,
  throwOnError,
}: {
  queryFn: () => Promise<Data>;
  retry?: number | ((failureCount: number, error: Error) => boolean);
  failureCount?: number;
  retryDelay?: RetryDelay<Error>;
  throwOnError?: boolean;
}): Promise<{ data: Data | null; error: Error | null }> => {
  try {
    const data = await queryFn();
    return { data, error: null };
  } catch (e) {
    if (typeof retry === 'number' && retry > 0) {
      await handleRetryDelay(failureCount, e as Error, retryDelay);
      return handleQueryFnWithRetry({
        queryFn,
        retry: retry - 1,
        retryDelay,
      });
    }

    if (typeof retry === 'function' && retry(failureCount + 1, e as Error)) {
      await handleRetryDelay(failureCount, e as Error, retryDelay);
      return handleQueryFnWithRetry({
        queryFn,
        retry,
        failureCount: failureCount + 1,
        retryDelay,
      });
    }

    if (throwOnError) {
      throw e;
    }

    return { data: null, error: e as Error };
  }
};

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
