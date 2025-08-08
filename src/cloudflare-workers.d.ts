declare module 'cloudflare:workers' {
  export function waitUntil(promise: Promise<any>): void;
}
