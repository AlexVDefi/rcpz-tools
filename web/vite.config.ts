import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// A strict Content-Security-Policy, injected into the built index.html (production only, so
// Vite's dev server — which needs inline/eval for HMR — keeps working). The key line is
// `connect-src 'self'`: the browser will BLOCK any network request (fetch/XHR/WebSocket) to
// anywhere but this app's own origin, so no game file, save or mod can ever be uploaded, even
// by a bug. `'unsafe-eval'` is required only because the mesh-conversion WASM (assimpjs/Embind)
// generates binding functions at runtime; it does not weaken the no-exfiltration guarantee.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');
function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

// The platform-agnostic domain logic lives in ../shared (parsed, resolved, and
// parity-tested in Node). The web app imports it directly and injects browser
// implementations of the AssetSource / ImageOps / MeshConverter seams.
export default defineConfig({
  plugins: [react(), cspPlugin()],
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
