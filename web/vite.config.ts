import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The platform-agnostic domain logic lives in ../shared (parsed, resolved, and
// parity-tested in Node). The web app imports it directly and injects browser
// implementations of the AssetSource / ImageOps / MeshConverter seams.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    // allow importing ../shared (outside the web/ root)
    fs: { allow: ['..'] },
  },
  // assimpjs ships a prebuilt .wasm loaded at runtime; keep it an emitted asset.
  assetsInclude: ['**/*.wasm'],
  build: { target: 'es2022' },
});
