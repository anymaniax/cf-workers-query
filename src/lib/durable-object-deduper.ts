import { DurableObject } from 'cloudflare:workers';

/**
 * Optional Durable Object for guaranteed single-flight query execution.
 *
 * Unlike the built-in best-effort Cache API deduplication, this provides
 * true atomic deduplication using Durable Object's single-threaded model.
 *
 * Usage:
 * 1. Add to your wrangler.toml:
 *    [[durable_objects.bindings]]
 *    name = "QUERY_DEDUPER"
 *    class_name = "QueryDeduper"
 *
 * 2. Import and export from your worker entry:
 *    export { QueryDeduper } from 'cf-workers-query/durable-object';
 *
 * 3. Use in your code:
 *    const id = env.QUERY_DEDUPER.idFromName(cacheKeyString);
 *    const stub = env.QUERY_DEDUPER.get(id);
 *    const response = await stub.dedupe(new Request('https://internal', {
 *      method: 'POST',
 *      body: JSON.stringify({ url: 'https://api.example.com/data' })
 *    }));
 */
export class QueryDeduper extends DurableObject {
  private inflight = new Map<string, Promise<Response>>();

  async dedupe(request: Request): Promise<Response> {
    const key = new URL(request.url).searchParams.get('key');
    if (!key) {
      return new Response('Missing "key" query parameter', { status: 400 });
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.executeQuery(request).finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }

  private async executeQuery(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      url: string;
      init?: RequestInit;
    };
    return fetch(body.url, body.init);
  }
}
