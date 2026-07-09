#!/usr/bin/env node
'use strict';

// Copy the three.js addon modules we use out of node_modules/three/examples/jsm
// into src/vendor/three-jsm/.
//
// Why: electron-builder unconditionally strips `examples/` directories out of
// node_modules when packaging, so the loaders would be missing from the built app.
// Vendoring the (small) closed set of files we actually import avoids that, and
// keeps the packaged size down -- the full jsm directory is ~14 MB.
//
// three.js is MIT licensed; its LICENSE is copied alongside.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
const DST = path.join(ROOT, 'src', 'vendor', 'three-jsm');

const ENTRIES = ['loaders/FBXLoader.js', 'loaders/GLTFLoader.js'];
const REL_IMPORT = /from\s+'(\.\.?\/[^']+)'/g;

function collect(rel, seen) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const abs = path.join(SRC, rel);
  const code = fs.readFileSync(abs, 'utf8');
  for (const m of code.matchAll(REL_IMPORT)) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    collect(dep, seen);
  }
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('three/examples/jsm not found -- run npm install first');
    process.exit(1);
  }
  const seen = new Set();
  for (const e of ENTRIES) collect(e, seen);

  fs.rmSync(DST, { recursive: true, force: true });
  for (const rel of seen) {
    const to = path.join(DST, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(SRC, rel), to);
  }
  fs.copyFileSync(path.join(ROOT, 'node_modules', 'three', 'LICENSE'), path.join(DST, 'LICENSE.three'));

  const bytes = [...seen].reduce((n, r) => n + fs.statSync(path.join(SRC, r)).size, 0);
  console.log(`vendored ${seen.size} three addon files (${Math.round(bytes / 1024)} KB) -> src/vendor/three-jsm`);
  for (const r of [...seen].sort()) console.log('  ' + r);
}

main();
