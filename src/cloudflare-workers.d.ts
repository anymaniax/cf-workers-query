declare module 'cloudflare:workers' {
  export function waitUntil(promise: Promise<unknown>): void;
}
