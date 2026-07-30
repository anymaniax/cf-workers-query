import { BaseKey, QueryKey, QueryKeyHashFn } from './cache-api';
import { createQuery, CreateQuery, QueryResult } from './create-query';
import { invalidateQuery } from './invalidate-query';
import { prefetchQuery } from './prefetch-query';

/**
 * Options every query on this client inherits. Per-query values win (most specific wins,
 * as in React Query) — except the three that decide cache IDENTITY, which are bound to the
 * client and cannot be overridden per call. See `defineQueryClient`.
 *
 * `retry` and `retryDelay` are numbers here, not their callback forms: both callbacks receive
 * the error, so they belong to a query that knows what its errors look like rather than to a
 * deployment — and typing them here would pin every query on the client to one `TError`.
 */
export type QueryClientDefaults = {
  staleTime?: number;
  gcTime?: number;
  retry?: number;
  retryDelay?: number;
  throwOnError?: boolean;
  revalidateMode?: 'default' | 'probabilistic';
  onRevalidateError?: (error: unknown, context: { queryKey: QueryKey }) => void;
};

/**
 * A query whose cache identity is already decided by the client. `baseKey`, `cacheName`
 * and `queryKeyHashFn` are omitted rather than ignored, so passing one is a type error
 * instead of a silent no-op.
 */
export type ScopedQuery<Data = unknown, TError = unknown> = Omit<
  CreateQuery<Data, TError>,
  'baseKey' | 'cacheName' | 'queryKeyHashFn'
>;

export type QueryClient = {
  /** The prefix every key on this client carries. Exposed for logging and for composing child scopes. */
  readonly baseKey: BaseKey;
  createQuery: <Data = unknown, TError = unknown>(
    options: ScopedQuery<Data, TError>
  ) => Promise<QueryResult<Data, TError>>;
  prefetchQuery: <Data = unknown, TError = unknown>(
    options: ScopedQuery<Data, TError>
  ) => void;
  invalidateQuery: (options: { queryKey: QueryKey }) => Promise<void>;
};

/**
 * Binds a cache scope and a set of defaults to the query functions, once per deployment.
 *
 * ## Why this exists
 *
 * The Cloudflare Cache API is a **zone** store. Entries are identified by
 * `(cacheName, hash(queryKey))` and nothing else — the request URL behind them is a
 * constant. So every Worker and every environment sharing a zone reads and writes the SAME
 * entries, and two deployments that happen to use the same key will serve each other's
 * data. That is not a hypothetical: it is how a staging deployment came to serve production
 * configuration, flapping between the two as each took its turn repopulating the entry.
 *
 * `baseKey` is the fix, and binding it here rather than at each call site is the point: a
 * read and its invalidation derive their key from one value, so they cannot drift.
 *
 * ```ts
 * const { createQuery, invalidateQuery } = defineQueryClient({
 *   baseKey: ['my-worker', env.DEPLOY_ENV],
 *   defaults: { staleTime: 300, gcTime: 86_400 },
 * });
 * ```
 *
 * Pick a `baseKey` that identifies **the worker and the environment**, and prefer a value
 * that already has to be set for the deployment to work at all (an API base URL, say) over
 * a variable added for this purpose: one that must be remembered in four deployment
 * configs is one that gets forgotten in one of them, and forgetting it fails silently.
 *
 * ## Migrating
 *
 * The methods carry the same names as the free functions, so adoption is an import away and
 * no call site changes:
 *
 * ```diff
 * - import { createQuery, invalidateQuery } from 'cf-workers-query';
 * + const { createQuery, invalidateQuery } = defineQueryClient({ baseKey: [...] });
 * ```
 *
 * With no `baseKey` and no `queryKeyHashFn`, keys are byte-identical to what every version
 * before 0.12 produced — upgrading never orphans a warm cache.
 *
 * ## Identity is bound here, behaviour is per query
 *
 * `baseKey`, `cacheName` and `queryKeyHashFn` all decide WHICH entry a key maps to, so all
 * three are client-level and cannot be overridden per call — an override would let one call
 * site write to a bucket its own invalidation then misses. Everything else (`staleTime`,
 * `retry`, `throwOnError`, …) is a default a query may override.
 */
export const defineQueryClient = ({
  baseKey = [],
  cacheName,
  queryKeyHashFn,
  defaults,
}: {
  baseKey?: BaseKey;
  cacheName?: string;
  /** Escape hatch under `baseKey`. Must return a URL-safe string. */
  queryKeyHashFn?: QueryKeyHashFn;
  defaults?: QueryClientDefaults;
} = {}): QueryClient => {
  // Applied AFTER the caller's options on purpose: `ScopedQuery` already makes passing one
  // a type error, and this makes it a no-op even when the object arrives untyped.
  const scope = { baseKey, cacheName, queryKeyHashFn } as const;

  return {
    baseKey,

    createQuery: <Data = unknown, TError = unknown>(
      options: ScopedQuery<Data, TError>
    ) => createQuery<Data, TError>({ ...defaults, ...options, ...scope }),

    prefetchQuery: <Data = unknown, TError = unknown>(
      options: ScopedQuery<Data, TError>
    ) => prefetchQuery<Data, TError>({ ...defaults, ...options, ...scope }),

    invalidateQuery: ({ queryKey }) =>
      invalidateQuery({ queryKey, ...scope }),
  };
};
