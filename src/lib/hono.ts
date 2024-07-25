import { Context, Handler, MiddlewareHandler } from 'hono';
import { createQuery, CreateQuery, QueryFnOptions } from './create-query';
import { QueryKey } from './cache-api';
import { HTTPException } from 'hono/http-exception';

type CacheKey = QueryKey | ((ctx: Context) => QueryKey);

type CacheOptions = Omit<
  CreateQuery,
  'queryKey' | 'queryFn' | 'executionCtx' | 'throwOnError'
> & {
  cacheKey: CacheKey;
  handler?: Handler;
};

export const cache =
  ({ cacheKey, handler, ...options }: CacheOptions): MiddlewareHandler =>
  async (ctx, next) => {
    const defaultHandler = async (options: QueryFnOptions) => {
      if (!options.isStale) {
        await next();
      }

      return ctx.res.clone();
    };

    const { data: response, error } = await createQuery<Response>({
      ...options,
      queryKey: typeof cacheKey === 'function' ? cacheKey(ctx) : cacheKey,
      queryFn: (options) =>
        handler ? handler(ctx, next) : defaultHandler(options),
      executionCtx: ctx.executionCtx,
      throwOnError: true,
      raw: true,
    });

    if (!response || error) {
      throw new HTTPException(500);
    }

    return new Response(response.body, response);
  };
