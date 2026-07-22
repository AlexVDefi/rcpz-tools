#!/usr/bin/env node
// Headless proof that a baked bundle is fully consumable end to end: build the same index
// the app builds from a manifest-backed AssetSource, run the real character-core resolvers,
// and read every resulting glb back with the meshopt decoder to confirm the compressed
// geometry and animation survived intact. This is the structural gate; visual fidelity is
// the browser check.
//
//   node tools/verify-hosted.mjs --bundle asset-bake/42

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAssetIndex } from '../shared/asset-index.js';
import { createMeshConverter } from '../shared/mesh-converter.js';
import {
  listClothing, listHair, listHeldItems, listClips,
  resolveBody, resolveClothing, resolveClip, resolveHeldItem, resolveHairStyle,
} from '../shared/character-core.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { stripExternalRefs } from './glb-optimize.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const every = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);

// A Node AssetSource over the local bundle - the same virtual-FS logic as the browser's
// hosted-source.ts, reading assets from disk instead of fetch.
function manifestSource(bundleDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
  const assetsDir = path.join(bundleDir, manifest.assetBase);
  const dirs = new Map(), files = new Map();
  const ensure = (l) => { let m = dirs.get(l); if (!m) { m = new Map(); dirs.set(l, m); } return m; };
  ensure('');
  for (const [key, entry] of Object.entries(manifest.files)) {
    files.set(key.toLowerCase(), entry);
    const parts = key.split('/'); let cur = '';
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      ensure(cur.toLowerCase()).set(parts[i].toLowerCase(), { name: parts[i], kind: isFile ? 'file' : 'dir' });
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      if (!isFile) ensure(cur.toLowerCase());
    }
  }
  const norm = (r) => r.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const bin = (e) => fs.readFileSync(path.join(assetsDir, `${e.hash}.${e.ext}`));
  return {
    manifest,
    source: {
      id: 'hosted-local', isMod: false,
      async listDir(d) { const m = dirs.get(norm(d).toLowerCase()); return m ? [...m.values()] : []; },
      async readText(p) { const e = files.get(norm(p).toLowerCase()); if (!e) throw new Error(`nf ${p}`); return e.kind === 'text' ? e.text : bin(e).toString('utf8'); },
      async readBytes(p) { const e = files.get(norm(p).toLowerCase()); if (!e) throw new Error(`nf ${p}`); if (e.kind === 'text') return new TextEncoder().encode(e.text); const b = bin(e); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); },
      async stat(p) { const e = files.get(norm(p).toLowerCase()); if (!e) return null; return { size: e.kind === 'text' ? Buffer.byteLength(e.text) : e.size, mtimeMs: 0 }; },
    },
  };
}

async function main() {
  const bundle = path.resolve(REPO_ROOT, arg('--bundle', 'asset-bake/42'));
  const { manifest, source } = manifestSource(bundle);
  console.log(`Bundle ${bundle} (v${manifest.version}, meshopt=${manifest.meshopt})\n`);

  const index = await buildAssetIndex([source]);
  const ctx = { resolver: index.resolver, converter: createMeshConverter() };
  const clothing = listClothing(index), { hair, beards } = listHair(index), held = listHeldItems(index), clips = listClips(index);
  console.log(`Index: ${clothing.length} clothing, ${hair.male.length + hair.female.length} hair, ${held.length} held, ${clips.length} clips\n`);

  await MeshoptDecoder.ready; await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

  // Read a glb back through the meshopt decoder and summarise its structure.
  async function inspect(glb) {
    // Clips are converted from .x in the resolver and still carry assimp's external image
    // refs (the app's GLTFLoader redirects them to a blank pixel); strip so the reader can
    // load them, same as the meshes' bake-time optimize does.
    const doc = await io.readBinary(stripExternalRefs(glb instanceof Uint8Array ? glb : new Uint8Array(glb)));
    const root = doc.getRoot();
    let verts = 0;
    for (const m of root.listMeshes()) for (const p of m.listPrimitives()) { const a = p.getAttribute('POSITION'); if (a) verts += a.getCount(); }
    const channels = root.listAnimations().reduce((s, a) => s + a.listChannels().length, 0);
    return { meshes: root.listMeshes().length, verts, skins: root.listSkins().length, anims: root.listAnimations().length, channels };
  }

  let pass = 0, fail = 0; const problems = [];
  const check = async (label, fn, want) => {
    try {
      const r = await fn();
      if (r && r.error) { fail++; problems.push(`${label}: ${r.error}`); return null; }
      const glb = r.meshGlb || r.glb;
      if (!glb) { fail++; problems.push(`${label}: no glb`); return null; }
      const info = await inspect(glb);
      const ok = want === 'anim' ? info.channels > 0 : info.verts > 0;
      if (!ok) { fail++; problems.push(`${label}: ${JSON.stringify(info)}`); return null; }
      pass++; return info;
    } catch (e) { fail++; problems.push(`${label}: ${e.message}`); return null; }
  };

  const body = await check('body/male', () => resolveBody(ctx, { gender: 'male' }), 'mesh');
  console.log('body/male       ', JSON.stringify(body));
  const exClothing = await check(`clothing/${clothing[0]?.name}`, () => resolveClothing(ctx, clothing.find((c) => c.kind !== 'composite'), 'male'), 'mesh');
  console.log('sample clothing ', JSON.stringify(exClothing));
  const exClip = await check(`clip/${clips[0]?.name}`, () => resolveClip(ctx, clips[0]), 'anim');
  console.log('sample clip     ', JSON.stringify(exClip), '<- channels>0 means animation survived meshopt\n');

  for (const c of every(clothing.filter((x) => x.kind !== 'composite'), 40)) await check(`clothing/${c.name}`, () => resolveClothing(ctx, c, 'male'), 'mesh');
  for (const c of every(clips, 40)) await check(`clip/${c.name}`, () => resolveClip(ctx, c), 'anim');
  for (const h of every([...hair.male, ...hair.female, ...beards].filter((s) => s.model), 15)) await check(`hair/${h.name}`, () => resolveHairStyle(ctx, h), 'mesh');
  for (const it of every(held, 15)) await check(`held/${it.name}`, () => resolveHeldItem(ctx, it), 'mesh');

  console.log(`Decoded OK: ${pass}   failed: ${fail}`);
  if (problems.length) console.log('Problems:\n  ' + problems.slice(0, 15).join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('verify failed:', e.stack || e.message); process.exit(1); });
