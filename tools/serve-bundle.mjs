#!/usr/bin/env node
// Tiny CORS static server for a baked bundle, so the web dev server (a different origin) can
// load it via ?assets=http://localhost:8788/. Content-hashed assets are served immutable.
//
//   node tools/serve-bundle.mjs --dir asset-bake/42 --port 8788

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const dir = path.resolve(REPO_ROOT, arg('--dir', 'asset-bake/42'));
const port = parseInt(arg('--port', '8788'), 10);
const TYPES = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp' };

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(dir, rel === '/' ? 'manifest.json' : rel);
  if (!file.startsWith(dir)) { res.statusCode = 403; return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.end(data);
  });
}).listen(port, () => console.log(`serving ${dir}\n  http://localhost:${port}/  (manifest.json + assets/)`));
