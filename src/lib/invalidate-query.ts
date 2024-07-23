import { CacheApiAdaptor, QueryKey } from './cache-api';

export const invalidateQuery = ({
  queryKey,
  cacheName,
}: {
  queryKey: QueryKey;
  cacheName?: string;
}) => {
  const cache = new CacheApiAdaptor({ cacheName });

  return cache.delete(queryKey);
};
