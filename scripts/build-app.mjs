import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  configFile: false, root, publicDir: false,
  input: { 'photo-rename-roster': path.join(root, 'src/photo-rename-roster.ts') },
  build: {
    target: 'es2020', outDir: path.join(root, 'dist'), emptyOutDir: true,
    sourcemap: false, modulePreload: { polyfill: false },
    rolldownOptions: { output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } },
  },
});
