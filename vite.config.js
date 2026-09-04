import { defineConfig } from 'vite';

// The contract module and its wasm runtime are pulled in from src/, one level
// above the web root, so the fs allow-list has to reach the project root.
export default defineConfig({
  root: 'web',
  server: { fs: { allow: ['..'] } },
  optimizeDeps: { exclude: ['@midnight-ntwrk/compact-runtime'] },
  build: { outDir: '../dist', emptyOutDir: true, target: 'esnext' },
});
