import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const originOf = (u?: string) => { if (!u) return null; try { return new URL(u).origin; } catch { return null; } };

// A strict Content-Security-Policy, injected into the built index.html (production only, so
// Vite's dev server — which needs inline/eval for HMR — keeps working). The key line is
// `connect-src`: the browser BLOCKS any network request (fetch/XHR/WebSocket) to anywhere but
// this app's own origin, so no game file, save or mod can ever be uploaded, even by a bug. When
// the optional online-sharing feature is configured, connect-src is widened to exactly the
// Supabase project + the upload Worker origin (nothing else) - a bug still cannot reach an
// arbitrary host. `'unsafe-eval'` is required only because the mesh-conversion WASM
// (assimpjs/Embind) generates binding functions at runtime; it does not weaken the guarantee.
function buildCsp(env: Record<string, string>): string {
  const connect = new Set(["'self'"]);
  const sb = originOf(env.VITE_SUPABASE_URL);
  const api = originOf(env.VITE_CLOUD_API);
  if (sb) { connect.add(sb); connect.add(sb.replace(/^https:/, 'wss:')); } // Supabase realtime uses wss
  if (api) connect.add(api);
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src ${[...connect].join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ');
}
function cspPlugin(csp: string): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  };
}

// The platform-agnostic domain logic lives in ../shared (parsed, resolved, and
// parity-tested in Node). The web app imports it directly and injects browser
// implementations of the AssetSource / ImageOps / MeshConverter seams.
export default defineConfig(({ mode }) => {
  // read VITE_ vars from .env files AND the real environment (Vercel injects build env there)
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env } as Record<string, string>;
  return {
    plugins: [react(), cspPlugin(buildCsp(env))],
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
  };
});
