import { ExecutionContext, getCFExecutionContext } from './context';
import { CacheApiAdaptor, QueryKey } from './cache-api';
import { nanoid } from 'nanoid';

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
  executionCtx?: ExecutionContext;
  cacheName?: string;
  throwOnError?: boolean;
  enabled?: boolean | ((data: Data) => boolean);
};

export const createQuery = async <Data = unknown, Error = unknown>({
  queryKey,
  queryFn,
  gcTime,
  staleTime,
  revalidate,
  retry,
  retryDelay,
  executionCtx,
  cacheName,
  throwOnError,
  enabled = true,
}: CreateQuery<Data, Error>): Promise<{
  data: Data | null;
  error: Error | null;
  invalidate: () => Promise<void> | void;
}> => {
  try {
    if (!queryKey || !enabled) {
      const data = await queryFn();
      return { data, error: null, invalidate: () => undefined };
    }

    const cache = new CacheApiAdaptor({ maxAge: gcTime, cacheName });

    const cacheKey = queryKey;
    const invalidate = () => cache.delete(cacheKey);

    const context = (executionCtx ?? getCFExecutionContext()) as
      | ExecutionContext
      | undefined;

    if (!context && !!staleTime) {
      console.warn('Context not found, staleTime will be ignored');
    }

    if (!revalidate && staleTime !== 0) {
      const cachedData = await cache.retrieve<Data>(cacheKey);

      if (cachedData?.data) {
        const isStale =
          staleTime && cachedData.lastModified + staleTime * 1000 < Date.now();

        if (isStale && context) {
          const staleId = nanoid();

          const dedupeKey =
            cacheKey instanceof URL
              ? new URL(cacheKey)
              : [...cacheKey, 'dedupe'];

          if (dedupeKey instanceof URL) {
            dedupeKey.searchParams.set('dedupe', 'true');
          }

          await cache.update(dedupeKey, staleId);

          const refreshFunc = async () => {
            const { data: cachedStaleId } =
              (await cache.retrieve<string>(dedupeKey)) ?? {};

            if (cachedStaleId && cachedStaleId !== staleId) {
              return;
            }

            const newData = await queryFn();
            await cache.update(cacheKey, newData);
          };

          context.waitUntil(refreshFunc());
        }

        if (!isStale || (isStale && context)) {
          return { data: cachedData.data, error: null, invalidate };
        }
      }
    }

    const { data, error } = await handleQueryFnWithRetry<Data, Error>({
      queryFn,
      retry,
      retryDelay,
      throwOnError,
    });

    if (error || !data) {
      return { data: null, error, invalidate: () => undefined };
    }

    if (typeof enabled !== 'function' || enabled(data)) {
      const cacheData = data instanceof Response ? data.clone() : data;

      if (context) {
        context.waitUntil(cache.update<Data>(cacheKey, cacheData));
      } else {
        await cache.update<Data>(cacheKey, cacheData);
      }
    }

    return { data, error: null, invalidate };
  } catch (e) {
    if (throwOnError) {
      throw e;
    }

    return { data: null, error: e as Error, invalidate: () => undefined };
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
