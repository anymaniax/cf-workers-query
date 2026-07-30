import {
  BaseKey,
  CacheApiAdaptor,
  QueryKey,
  QueryKeyHashFn,
} from './cache-api';

/**
 * Drops one entry, by exact key.
 *
 * Singular on purpose: the Cache API cannot enumerate its keys, so there is no way to
 * invalidate by partial-key filter the way React Query's `invalidateQueries` does. It
 * deletes the entry whose key hashes to exactly this one, or nothing.
 *
 * `baseKey` / `queryKeyHashFn` MUST match the ones the entry was written with — which
 * is the whole reason `defineQueryClient` exists: it binds both sides to one value so
 * a read and its invalidation cannot drift apart.
 *
 * Deletion is COLO-LOCAL. It takes effect instantly in the data center that served
 * the call; every other colo keeps serving its own copy until that copy goes stale.
 * So invalidation is an optimisation, never the mechanism you rely on for correctness.
 */
export const invalidateQuery = ({
  queryKey,
  cacheName,
  baseKey,
  queryKeyHashFn,
}: {
  queryKey: QueryKey;
  cacheName?: string;
  baseKey?: BaseKey;
  queryKeyHashFn?: QueryKeyHashFn;
}) => {
  const cache = new CacheApiAdaptor({ cacheName, baseKey, queryKeyHashFn });

  return cache.delete(queryKey);
};
