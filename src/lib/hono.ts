import { Context, Handler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { QueryKey } from './cache-api';
import { createQuery, CreateQuery } from './create-query';

type CacheKey = QueryKey | ((ctx: Context) => QueryKey);

type CacheOptions = Omit<
  CreateQuery,
  'queryKey' | 'queryFn' | 'throwOnError' | 'revalidate'
> & {
  cacheKey: CacheKey;
  handler: (ctx: Context) => Response | Promise<Response>;
  revalidate?: boolean | ((ctx: Context) => boolean);
};

export const cache =
  <E = {}>({
    cacheKey,
    handler,
    revalidate,
    ...options
  }: CacheOptions): Handler<E> =>
  async (ctx) => {
    const { data: response, error } = await createQuery<Response>({
      ...options,
      queryKey: typeof cacheKey === 'function' ? cacheKey(ctx) : cacheKey,
      queryFn: () => Promise.resolve(handler(ctx)),
      throwOnError: true,
      ...(revalidate
        ? {
            revalidate:
              typeof revalidate === 'boolean' ? revalidate : revalidate(ctx),
          }
        : {}),
    });

    if (!response || error) {
      throw new HTTPException(500);
    }

    return new Response(response.body, response);
  };
