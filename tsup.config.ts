import { copyFile } from 'fs/promises';
import { join } from 'path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/lib/hono.ts', 'src/lib/durable-object-deduper.ts'],
  format: ['cjs', 'esm'],
  outDir: 'dist/src',
  dts: {
    resolve: true,
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  clean: true,
  external: ['cloudflare:workers'],
  tsconfig: 'tsconfig.lib.json',
  onSuccess: async () => {
    const files = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
    for (const file of files) {
      await copyFile(file, join('dist', file));
      console.log(`Copied ${file} to dist/`);
    }
  },
});
