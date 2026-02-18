# Cf-Workers-Query

Automatically cache and revalidate data in Cloudflare Workers. Using the [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache) and [`waitUntil`](https://developers.cloudflare.com/workers/runtime-apis/context/) from `cloudflare:workers`.

## Example

```ts
import { createQuery } from 'cf-workers-query';

const { data, error, invalidate } = await createQuery({
  queryKey: ['user', userId],
  queryFn: async () => {
    const user = await fetchUser(userId);
    return user;
  },
  gcTime: 60, // 60 seconds
});
```

## Stale Revalidation

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
      staleTime: 30, // 30 seconds
      gcTime: 60, // 60 seconds
    });

    return new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
```

Background revalidation uses `waitUntil` from `cloudflare:workers` to keep the worker alive after responding.

### Hono Example

```ts
import { cache } from 'cf-workers-query/hono';

app.get(
  '/user/:id',
  cache({
    handler: async (ctx) => {
      const user = await fetchUser(ctx.req.param('id'));
      return ctx.json(user);
    },
    cacheKey: (ctx) => ['user', ctx.req.param('id')],
    gcTime: 3600, // 1 hour in seconds
    staleTime: 60, // 60 seconds
  })
);
```

## Deduplication

By default, `cf-workers-query` uses a best-effort deduplication strategy via Cache API "processing markers". When multiple concurrent requests hit the same query key:

- **Initial fetches**: A brief (50ms) check is performed to see if another request already wrote the result to cache. If found, the cached result is returned instead of re-fetching.
- **SWR background refreshes**: If a refresh is already in progress for a key, additional refresh attempts are skipped entirely.

This is **best-effort** because CF Cache API has no atomic compare-and-swap operations. In practice, it reduces N concurrent executions to ~1-3.

### Guaranteed Single-Flight with Durable Objects (Optional)

For use cases that require **guaranteed** single-flight execution, an optional Durable Object class is provided:

```ts
// worker entry
export { QueryDeduper } from 'cf-workers-query/durable-object';
```

```toml
# wrangler.toml
[[durable_objects.bindings]]
name = "QUERY_DEDUPER"
class_name = "QueryDeduper"
```

This requires Durable Objects billing and is opt-in.

## API Reference

### queryKey

Type: `QueryKey | null`

An optional key that uniquely identifies the query. Can be an array of values or a `URL`. If set to `null`, the query is not cached.

### queryFn

Type: `() => Promise<Data>`

A function that returns a promise resolving with the data for the query.

### staleTime

Type: `number`

Optional. The amount of time **in seconds** before the query data is considered stale. Default is `0`.

### gcTime

Type: `number`

Optional. The amount of time **in seconds** to keep data in the cache. Maps to `Cache-Control: max-age`. If `0` or falsy, caching is skipped entirely.

### revalidate

Type: `boolean`

Optional. If `true`, the query will directly revalidate data (bypass stale check).

### revalidateMode

Type: `'default' | 'probabilistic'`

Optional. If `'probabilistic'`, uses a probability function to decide whether to revalidate stale data. Based on [Cloudflare's cache stampede prevention](https://blog.cloudflare.com/sometimes-i-cache).

### retry

Type: `number | ((failureCount: number, error: Error) => boolean)`

Optional. Number of retry attempts on failure, or a function that receives the failure count and error and returns whether to retry.

### retryDelay

Type: `number | ((failureCount: number, error: Error) => number)`

Optional. Delay between retries in **milliseconds** (note: unlike `staleTime` and `gcTime` which are in seconds, `retryDelay` is in milliseconds). Can be a fixed number or a function. Defaults to exponential backoff: `Math.min(1000 * 2^attempt, 30000)`.

### cacheName

Type: `string`

Optional. The name of the cache to use. Default is `cf-workers-query-cache`.

### throwOnError

Type: `boolean`

Optional. If `true`, errors from `queryFn` are thrown instead of returned in the `error` field. Useful with Hono's error handling or when you want try/catch control flow.

### enabled

Type: `boolean | ((data: Data) => boolean)`

Optional. Controls whether the query executes and/or caches. If `false`, the query is skipped. If a function, receives the fetched data and returns whether to cache it.

## Credits

Inspired by [TanStack Query](https://tanstack.com/query/latest) but for Cloudflare Workers.
