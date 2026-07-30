/**
 * `waitUntil` (from the `cloudflare:workers` builtin) keeps background work —
 * SWR revalidation, dedupe-marker cleanup, `prefetchQuery` warming — alive after
 * the response is sent. That builtin only exists in the Worker runtime, so a
 * *static* top-level `import { waitUntil } from 'cloudflare:workers'` forces every
 * consumer bundle that transitively imports it — including browser/client bundles —
 * to resolve the specifier, which fails outside a Worker (e.g. Vite/Rolldown:
 * "failed to resolve import 'cloudflare:workers'").
 *
 * We resolve it lazily through a dynamic import with a non-statically-analysable
 * specifier, pre-warmed at module load: bundlers leave it as a runtime import, so
 * non-Worker bundles build cleanly. The Worker resolves the real,
 * request-context-aware implementation; off-Worker we never attempt the import and
 * keep a no-op (background revalidation simply does not run there) — merely
 * attempting it in a browser makes it fetch the literal URL `cloudflare:workers`
 * and log a CORS error ("CORS request not http") even when the rejection is caught.
 *
 * Lives in its own module so every caller shares ONE probe. Duplicating it would
 * mean two dynamic imports and two chances to get the guard wrong.
 */
type WaitUntilFn = (promise: Promise<unknown>) => void;

let waitUntilImpl: WaitUntilFn = () => {};

// Built from parts so neither the library build (tsup/esbuild) nor a consumer
// bundler can fold this back into a static `cloudflare:workers` import.
const cloudflareWorkersModule = ['cloudflare', 'workers'].join(':');

// `WebSocketPair` only exists in workerd (independent of compatibility date),
// so browsers and Node skip the probe entirely.
if ('WebSocketPair' in globalThis) {
  void import(/* @vite-ignore */ cloudflareWorkersModule)
    .then((mod: { waitUntil?: WaitUntilFn }) => {
      if (typeof mod?.waitUntil === 'function') {
        waitUntilImpl = mod.waitUntil;
      }
    })
    .catch(() => {
      // Runtimes without the `cloudflare:workers` builtin: keep the no-op.
    });
}

export const waitUntil: WaitUntilFn = (promise) => {
  waitUntilImpl(promise);
};
