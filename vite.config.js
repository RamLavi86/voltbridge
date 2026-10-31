import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  // ponytail: unminified with sourcemaps, so crash reports name real functions; size doesn't matter on localhost.
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true, minify: false, sourcemap: true },
  plugins: [react()],
});
