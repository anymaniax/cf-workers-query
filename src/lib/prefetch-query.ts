import { createQuery, CreateQuery } from './create-query';
import { waitUntil } from './wait-until';

/**
 * Warms an entry without blocking the response, and without ever throwing.
 *
 * Returns `void` synchronously: the query is handed to `waitUntil`, so it runs after the
 * response is sent and its result only ever lands in the cache. Use it when you know the
 * next request will want a key that this one does not — priming a colo on the way out.
 *
 * NOTE this diverges from React Query's `prefetchQuery`, which awaits the fetch on a cache
 * miss (it is `fetchQuery().then(noop).catch(noop)`). Awaiting is what you want in a
 * browser, where the point is to have the data before the component renders. In a Worker
 * the point is the opposite: never make the current request pay for the next one's data.
 * If you need the value now, call `createQuery` and await it.
 *
 * Off the Worker runtime `waitUntil` is a no-op, so this does nothing at all — see
 * `wait-until.ts`.
 */
export const prefetchQuery = <Data = unknown, TError = unknown>(
  options: CreateQuery<Data, TError>
): void => {
  waitUntil(
    createQuery<Data, TError>({ ...options, throwOnError: false })
      .then(() => undefined)
      // `throwOnError: false` already routes failures into the returned `error`, so this
      // only catches a cache-layer surprise. Either way a warm-up must never surface as an
      // unhandled `waitUntil` rejection, which the runtime logs as a request exception.
      .catch(() => undefined)
  );
};
