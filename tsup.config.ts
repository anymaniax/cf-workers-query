import { copyFile } from 'fs/promises';
import { join } from 'path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/lib/hono.ts'],
  format: ['cjs', 'esm'],
  outDir: 'dist/src',
  dts: true,
  clean: true,
  onSuccess: async () => {
    const files = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
    for (const file of files) {
      await copyFile(file, join('dist', file));
      console.log(`Copied ${file} to dist/`);
    }
  },
});
