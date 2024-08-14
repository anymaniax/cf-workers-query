import { Context, Handler, MiddlewareHandler } from 'hono';
import { createQuery, CreateQuery } from './create-query';
import { QueryKey } from './cache-api';
import { HTTPException } from 'hono/http-exception';

type CacheKey = QueryKey | ((ctx: Context) => QueryKey);

type CacheOptions = Omit<
  CreateQuery,
  'queryKey' | 'queryFn' | 'executionCtx' | 'throwOnError' | 'revalidate'
> & {
  cacheKey: CacheKey;
  handler: Handler;
  revalidate?: boolean | ((ctx: Context) => boolean);
};

export const cache =
  ({
    cacheKey,
    handler,
    revalidate,
    ...options
  }: CacheOptions): MiddlewareHandler =>
  async (ctx, next) => {
    const { data: response, error } = await createQuery<Response>({
      ...options,
      queryKey: typeof cacheKey === 'function' ? cacheKey(ctx) : cacheKey,
      queryFn: () => handler(ctx, next),
      executionCtx: ctx.executionCtx,
      throwOnError: true,
      raw: true,
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
