#!/usr/bin/env node
// Tuning aid: sample the baked glbs and report the meshopt size ratio at a given level,
// without a full re-bake. Useful for comparing quantization levels or checking a new game
// version. The actual compression is the shared optimizeGlb the bake tool uses.
//
//   node tools/optimize-measure.mjs --bundle asset-bake/42 --sample 200 [--level medium|high]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimizeGlb } from './glb-optimize.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };

async function main() {
  const bundle = path.resolve(REPO_ROOT, arg('--bundle', 'asset-bake/42'));
  const sample = parseInt(arg('--sample', '200'), 10);
  const level = arg('--level', 'medium');
  const assetsDir = path.join(bundle, 'assets');

  const allGlb = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.glb'));
  const stride = Math.max(1, Math.floor(allGlb.length / sample));
  const pick = allGlb.filter((_, i) => i % stride === 0).slice(0, sample);
  console.log(`Bundle ${bundle}\nSampling ${pick.length}/${allGlb.length} glbs at level=${level}\n`);

  let before = 0, after = 0, ok = 0, plain = 0, big = 0, bigAfter = 0;
  const t0 = Date.now();
  for (const name of pick) {
    const raw = fs.readFileSync(path.join(assetsDir, name));
    const { bytes, compressed } = await optimizeGlb(raw, { level });
    before += raw.length; after += bytes.length; ok++; if (!compressed) plain++;
    if (raw.length > big) { big = raw.length; bigAfter = bytes.length; }
  }
  const ratio = before ? after / before : 0;
  console.log(`Compressed ${ok} glbs (${plain} left plain) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  ${mb(before)} -> ${mb(after)}  (${((1 - ratio) * 100).toFixed(1)}% smaller)`);
  console.log(`  avg ${kb(before / ok)} -> ${kb(after / ok)}   largest ${kb(big)} -> ${kb(bigAfter)}`);
}

main().catch((e) => { console.error('measure failed:', e.stack || e.message); process.exit(1); });
