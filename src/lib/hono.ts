import { Context, MiddlewareHandler } from 'hono';
import { createQuery } from './create-query';
import { QueryKey } from './cache-api';
import { CreateQuery } from './create-query';

type CacheKey = QueryKey | ((ctx: Context) => QueryKey);

type CacheOptions = Omit<
  CreateQuery,
  'queryKey' | 'queryFn' | 'executionCtx' | 'throwOnError'
> & {
  cacheKey: CacheKey;
};

export const cache =
  ({ cacheKey, ...options }: CacheOptions): MiddlewareHandler =>
  async (ctx, next) => {
    const { data: response } = await createQuery({
      ...options,
      queryKey: typeof cacheKey === 'function' ? cacheKey(ctx) : cacheKey,
      queryFn: async () => {
        await next();

        const clonedResponse = ctx.res.clone();
        return clonedResponse;
      },
      executionCtx: ctx.executionCtx,
      throwOnError: true,
    });

    return response;
  };
