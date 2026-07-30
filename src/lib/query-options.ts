import { QueryKey } from './cache-api';
import { CreateQuery } from './create-query';

/**
 * A query's key, its function and its options, as one value.
 *
 * `queryKey` is required here (it is optional on `CreateQuery`, where omitting it means
 * "skip the cache"): the whole point of this shape is that the same object can be handed
 * to `createQuery` and to `invalidateQuery`, and an invalidation without a key is nothing.
 */
export type QueryOptions<Data = unknown, TError = unknown> = Omit<
  CreateQuery<Data, TError>,
  'queryKey'
> & {
  queryKey: QueryKey;
};

/**
 * Bundles a query's key, function and options so the read and its invalidation cannot
 * drift apart.
 *
 * An identity function — it returns exactly what you give it, and every bit of its value
 * is in the types. Without it, code that reads a key and code that invalidates it derive
 * that key separately, and nothing checks that the two agree; the only thing holding them
 * together is a developer remembering. Define it once, pass the object around:
 *
 * ```ts
 * const missionConfigs = (lang: string) =>
 *   queryOptions({
 *     queryKey: ['mission-configs', lang],
 *     queryFn: () => db.selectFrom('MissionChatbotConfig')…execute(),
 *     staleTime: 300,
 *     gcTime: 86_400,
 *   });
 *
 * await client.createQuery(missionConfigs('en_GB'));
 * await client.invalidateQuery(missionConfigs('en_GB'));   // same object, same key
 * ```
 *
 * Note the type-level payoff is smaller here than in React Query, which brands the key
 * with the data type so `getQueryData` can infer it. There is no in-memory cache to read
 * back from, so nothing needs that branding — the win is that key, function and options
 * live in one place.
 */
export const queryOptions = <Data = unknown, TError = unknown>(
  options: QueryOptions<Data, TError>
): QueryOptions<Data, TError> => options;
