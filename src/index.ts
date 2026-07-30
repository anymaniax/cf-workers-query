export type { BaseKey, QueryKey, QueryKeyHashFn } from './lib/cache-api';
export { CacheApiAdaptor } from './lib/cache-api';
export type {
  CreateQuery,
  QueryResult,
  QuerySource,
  RetryDelay,
} from './lib/create-query';
export { createQuery } from './lib/create-query';
export { DedupeManager } from './lib/dedupe-manager';
export type {
  QueryClient,
  QueryClientDefaults,
  ScopedQuery,
} from './lib/define-query-client';
export { defineQueryClient } from './lib/define-query-client';
export { invalidateQuery } from './lib/invalidate-query';
export { prefetchQuery } from './lib/prefetch-query';
export type { QueryOptions } from './lib/query-options';
export { queryOptions } from './lib/query-options';
