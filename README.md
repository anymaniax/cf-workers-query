# Cf-Workers-Query

Automatically cache and revalidate data in Cloudflare Workers. Using the [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache) and [Execution Context](https://developers.cloudflare.com/workers/runtime-apis/context/).

Example:

```ts
import { createQuery } from 'cf-workers-query';

const { data, error, invalidate } = await createQuery({
  queryKey: ['user', userId],
  queryFn: async () => {
    const user = await fetchUser(userId);
    return user;
  },
  gcTime: 60 * 1000,
});

```

## Stale revalidation

```ts
import { createQuery } from 'cf-workers-query';

export default {
  async fetch(request, env, ctx) {
    const { data } = await createQuery({
      queryKey: ['user', userId],
      queryFn: async () => {
        const user = await fetchUser(userId);
        return user;
      },
      staleTime: 30 * 1000,
      gcTime: 60 * 1000,
      executionCtx: ctx,
    });
    
    return new Response(JSON.stringify(data), {
      headers: {
        'content-type': 'application/json',
      },
    });
  },
};
```

To have revalidation automatically when the stale time is reached, you need to provide the `executionCtx` to the `createQuery` function.


You can also use the `defineCFExecutionContext` function to define a custom execution context for the query. Can be useful if you are using a something like [hono](https://github.com/honojs/hono) or [remix](https://remix.run/).

Example using `defineCFExecutionContext`:


### Hono example

In this case you don't need to use `defineCFExecutionContext` as the execution context is provided automatically.

```ts
import { cache } from 'cf-workers-query/hono';


app.get('/user/:id', cache({
  handler: async (ctx, next) => {
    const user = await fetchUser(ctx.req.param('id'));
    return ctx.json(user)
  },
  cacheKey: (ctx) => ['user', ctx.req.param('id')], 
  cacheTime: 60 * 60,
  staleTime: 60
}));

```


## API Reference

###  queryKey
Type: QueryKey | null

Description: An optional key that uniquely identifies the query. This can be used to cache and retrieve query results more effectively. If set to null, the query may not be cached.

### queryFn
Type: () => Promise<Data>

Description: A function that returns a promise resolving with the data for the query. It is the primary function that runs to fetch the data.

### staleTime
Type: number

Description: Optional. The amount of time in milliseconds before the query data is considered stale. Default is 0.

### gcTime
Type: number

Description: Optional. The amount of time in milliseconds to keep unused data in the cache before garbage collection.

### revalidate
Type: boolean

Description: Optional. If true, the query will directly revalidate data.

### retry
Type: number | ((failureCount: number, error: Error) => boolean)

Description: Optional. Specifies the number of retry attempts in case of a query failure. Alternatively, a function that receives the failure count and error and returns a boolean indicating whether to retry the query.

### retryDelay
Type: RetryDelay<Error>

Description: Optional. Specifies the delay between retry attempts. This can be a number indicating milliseconds or a function returning the delay based on the failure count and error.

### executionCtx
Type: ExecutionContext

Description: Optional. The execution context to use.

### cacheName
Type: string

Description: Optional. The name of the cache to use. Default is `cf-workers-query-cache`.


## Credits

Inspired by [tanstack query](https://tanstack.com/query/latest)  but for Cloudflare Workers.
