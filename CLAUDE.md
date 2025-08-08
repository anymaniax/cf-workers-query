# Cloudflare Workers Query Library

## Package Management
This project uses **Bun** as the package manager.
- Install dependencies: `bun install`
- Add packages: `bun add <package>`
- Run scripts: `bun nx <command>`

## Build System
- Uses NX for task orchestration
- Build command: `bun nx build`
- Test command: `bun nx test`
- Build tool: tsup with TypeScript

## Key Configuration
- **tsup.config.ts**: Configured to handle Cloudflare Workers runtime imports
- External modules: `cloudflare:workers` (marked as external for bundling)
- Output directory: `dist/src`
- Formats: Both CommonJS and ESM

## Cloudflare Workers Specifics
- The library uses Cloudflare Workers runtime APIs (`waitUntil` from `cloudflare:workers`)
- Type declarations for `cloudflare:workers` are defined in `src/cloudflare-workers.d.ts`
- Designed to work with Cloudflare's Cache API and execution context

## Recent Fixes
- Added `cloudflare:workers` to external dependencies in tsup config
- Removed non-existent `executionCtx` property from `createQuery` calls
- Added type declarations for Cloudflare Workers runtime APIs
