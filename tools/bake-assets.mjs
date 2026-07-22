#!/usr/bin/env node
// Phase 1 of "hosted assets": bake the vanilla character-studio asset set out of a local
// Project Zomboid install into a self-contained, versioned bundle that a future
// HostedAssetSource can serve from a CDN, so the web app works on any device with no
// PZ install.
//
// The trick that keeps this honest: we DRIVE THE SAME CODE the app runs. buildAssetIndex
// (asset-index.js) builds the catalog; the character-core resolvers turn each pickable
// thing (body, clothing, hair, held items, weapon attachments, animation clips) into the
// binaries the renderer loads. We capture every binary the resolvers actually read at the
// AssetSource.readBytes seam - that set IS the closure the studio can load, nothing more,
// nothing less - then pre-convert meshes/clips .x/.fbx -> .glb (the WASM converter's glb
// path is a passthrough, so the browser loads them with no assimp) and copy textures.
//
// Output is a VIRTUAL FILESYSTEM manifest: for each media/-relative path, either inline
// text (scripts, clothing xml, hair xml) or a content-hashed binary asset. Because the app
// addresses everything through AssetSource + the case-insensitive resolver, a hosted source
// that faithfully answers listDir/readText/readBytes over this manifest makes the entire
// existing pipeline work unchanged - one code path, local and hosted.
//
//   node tools/bake-assets.mjs --install "D:/Steam/steamapps/common/ProjectZomboid" --version 42.13.0
//   node tools/bake-assets.mjs --limit-clips 20        # fast smoke test
//
// Vanilla only. Modded assets are not ours to redistribute; those stay local/desktop.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createNodeAssetSource } from '../shared/asset-source.js';
import { buildAssetIndex } from '../shared/asset-index.js';
import { createMeshConverter } from '../shared/mesh-converter.js';
import { optimizeGlb } from './glb-optimize.mjs';
import {
  listClothing, listHair, listHeldItems, listClips,
  resolveBody, resolveClothing, resolveHairStyle, resolveHeldItem, resolveAttachmentPart, resolveClip,
  SKIN_TONES, MASK_PART,
} from '../shared/character-core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const MESH_EXTS = new Set(['.x', '.fbx', '.glb', '.gltf']);
const ext = (p) => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i).toLowerCase(); };
const sha16 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// --- args ---
function parseArgs(argv) {
  const a = { install: null, version: 'unknown', out: null, limitClips: 0, compress: true, level: 'medium' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--install') a.install = argv[++i];
    else if (v === '--version') a.version = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--limit-clips') a.limitClips = parseInt(argv[++i], 10) || 0;
    else if (v === '--level') a.level = argv[++i];
    else if (v === '--no-compress') a.compress = false;
    else if (v === '-h' || v === '--help') a.help = true;
  }
  return a;
}

// Resolve the PZ install: explicit flag > the icon-maker's saved gameDir > common Steam paths.
function resolveInstall(explicit) {
  const isGame = (p) => { try { return !!p && fs.statSync(path.join(p, 'media')).isDirectory(); } catch { return false; } };
  if (explicit) { const abs = path.resolve(explicit); if (!isGame(abs)) throw new Error(`not a PZ install (no media/): ${abs}`); return abs; }
  try { const saved = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pz-icon-maker.json'), 'utf8')).gameDir; if (isGame(saved)) return path.resolve(saved); } catch {}
  const cand = [
    'C:/Program Files (x86)/Steam/steamapps/common/ProjectZomboid',
    'C:/Program Files/Steam/steamapps/common/ProjectZomboid',
    'D:/Steam/steamapps/common/ProjectZomboid', 'E:/Steam/steamapps/common/ProjectZomboid',
    path.join(os.homedir(), '.steam/steam/steamapps/common/ProjectZomboid'),
  ].filter(isGame);
  if (cand.length === 1) return path.resolve(cand[0]);
  throw new Error('No PZ install found. Pass --install <path> (or set one in the icon maker).');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('usage: node tools/bake-assets.mjs --install <PZ dir> [--version 42.13.0] [--out dir] [--limit-clips N]'); return; }

  const install = resolveInstall(args.install);
  const outRoot = args.out ? path.resolve(args.out) : path.join(REPO_ROOT, 'asset-bake');
  const outVer = path.join(outRoot, args.version);
  const assetsDir = path.join(outVer, 'assets');
  fs.rmSync(outVer, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  console.log(`Install : ${install}`);
  console.log(`Version : ${args.version}`);
  console.log(`Output  : ${outVer}${args.limitClips ? `  (smoke test: ${args.limitClips} clips)` : ''}\n`);

  // One vanilla source, wrapped so every binary the resolvers read is captured (realPath -> bytes).
  const refs = new Map(); // lowerRealPath -> { realPath, bytes }
  const base = createNodeAssetSource(install, { id: 'pz-install' });
  const source = {
    ...base,
    async readBytes(rel) {
      const bytes = await base.readBytes(rel);
      const key = rel.toLowerCase();
      if (!refs.has(key)) refs.set(key, { realPath: rel, bytes });
      return bytes;
    },
  };

  console.log('Indexing scripts / clothing / hair / anims ...');
  const index = await buildAssetIndex([source]);
  const resolver = index.resolver;

  const clothing = listClothing(index);
  const { hair, beards } = listHair(index);
  const held = listHeldItems(index);
  const clips = listClips(index);
  const clipsToBake = args.limitClips ? clips.slice(0, args.limitClips) : clips;
  console.log(`Catalog : ${clothing.length} clothing, ${hair.male.length + hair.female.length} hair, ${beards.length} beards, ${held.length} held, ${clips.length} human clips\n`);

  // --- discover the binary closure by exercising the real resolvers (stub converter = fast) ---
  const stub = { ready: async () => {}, convertToGlb: async (b, f) => (f === 'glb' || f === 'gltf' ? b : new Uint8Array(0)) };
  const ctx = { resolver, converter: stub };
  const errors = [];
  const tryEach = async (label, fn) => { try { const r = await fn(); if (r && r.error) errors.push(`${label}: ${r.error}`); } catch (e) { errors.push(`${label}: ${e.message}`); } };

  console.log('Tracing referenced assets ...');
  for (const g of ['male', 'female']) for (const skin of SKIN_TONES[g]) await tryEach(`body ${g}/${skin}`, () => resolveBody(ctx, { gender: g, skin }));
  for (const item of clothing) for (const g of ['male', 'female']) await tryEach(`clothing ${item.name}/${g}`, () => resolveClothing(ctx, item, g));
  for (const g of ['male', 'female']) for (const s of hair[g]) await tryEach(`hair ${s.name}`, () => resolveHairStyle(ctx, s));
  for (const s of beards) await tryEach(`beard ${s.name}`, () => resolveHairStyle(ctx, s));
  for (const it of held) {
    await tryEach(`held ${it.name}`, () => resolveHeldItem(ctx, it));
    for (const slot of it.attachSlots || []) for (const opt of slot.options || []) await tryEach(`part ${opt.partName}`, () => resolveAttachmentPart(ctx, opt));
  }
  for (const c of clipsToBake) await tryEach(`clip ${c.name}`, () => resolveClip(ctx, c));
  // Body masks (all 16 regions) - safety net beyond whatever the exercised clothing referenced.
  for (let m = 0; m < 16; m++) { const nm = MASK_PART[m]; if (!nm) continue; const hit = await resolver.resolveMediaPath(`media/textures/body/masks/${nm.toLowerCase()}.png`); if (hit) await hit.src.readBytes(hit.realPath); }
  console.log(`Referenced ${refs.size} binaries; ${errors.length} entries could not resolve locally.\n`);

  // --- bake: convert meshes/clips to glb (once each), copy textures, content-hash everything ---
  const converter = createMeshConverter(); // real WASM converter, byte-identical to the browser's
  const files = {};                        // virtualPath -> { kind:'bin', hash, ext, size } | { kind:'text', text }
  const written = new Set();
  const stat = { mesh: 0, clip: 0, texture: 0, other: 0, bytes: 0, failed: 0, glbRaw: 0, glbOut: 0, uncompressed: 0 };
  console.log(args.compress ? `Converting + compressing (meshopt level=${args.level}) ...` : 'Converting (no compression) ...');

  let done = 0;
  for (const { realPath, bytes } of refs.values()) {
    const e = ext(realPath);
    let outBytes, outExt, virtualPath, kind;
    try {
      if (MESH_EXTS.has(e)) {
        const glb = await converter.convertToGlb(bytes, e.slice(1));
        stat.glbRaw += glb.length;
        if (args.compress) {
          const r = await optimizeGlb(glb, { level: args.level });
          outBytes = r.bytes; if (!r.compressed) stat.uncompressed++;
        } else outBytes = glb;
        stat.glbOut += outBytes.length;
        outExt = 'glb';
        virtualPath = realPath.slice(0, realPath.length - e.length) + '.glb';
        kind = realPath.toLowerCase().includes('/anims_x/') ? 'clip' : 'mesh';
      } else {
        outBytes = bytes; outExt = e.slice(1) || 'bin'; virtualPath = realPath;
        kind = e === '.png' ? 'texture' : 'other';
      }
    } catch (err) { stat.failed++; errors.push(`convert ${realPath}: ${err.message}`); continue; }

    const hash = sha16(outBytes);
    const fname = `${hash}.${outExt}`;
    if (!written.has(hash)) { fs.writeFileSync(path.join(assetsDir, fname), outBytes); written.add(hash); stat.bytes += outBytes.length; }
    files[virtualPath] = { kind: 'bin', hash, ext: outExt, size: outBytes.length };
    stat[kind]++;
    if (++done % 100 === 0) process.stdout.write(`  converted ${done}/${refs.size}\r`);
  }
  process.stdout.write(`  converted ${done}/${refs.size}\n`);

  // --- inline the small text trees the browser's buildAssetIndex parses ---
  // Prune scripts to those the character catalog actually reads (same guards listHeldItems /
  // buildClothingLocations use), so the manifest carries model/clothing/weapon defs only.
  const scriptWanted = (t) => t.includes('ClothingItem') || t.includes('model ') || t.includes('DisplayCategory') || t.includes('WeaponSprite');
  let textBytes = 0;
  const addText = (rel, text) => { files[rel] = { kind: 'text', text }; textBytes += Buffer.byteLength(text); };
  for (const f of index.scriptFiles) if (scriptWanted(f.text)) addText(f.rel, f.text);
  for (const f of index.clothingFiles) addText(f.rel, f.text);
  if (index.hairXml) addText('media/hairstyles/hairstyles.xml', index.hairXml);
  if (index.beardXml) addText('media/hairstyles/beardstyles.xml', index.beardXml);

  const manifest = {
    schema: 1,
    game: 'ProjectZomboid',
    version: args.version,
    generatedAt: new Date().toISOString(),
    assetBase: 'assets/',
    vanillaOnly: true,
    // glbs are EXT_meshopt_compression when compression is on: the browser GLTFLoader needs
    // a MeshoptDecoder to parse them (plain glbs still load without it).
    meshopt: args.compress,
    meshoptLevel: args.compress ? args.level : null,
    counts: {
      clothing: clothing.length, hair: hair.male.length + hair.female.length, beards: beards.length,
      held: held.length, clips: clipsToBake.length,
      meshes: stat.mesh, clipMeshes: stat.clip, textures: stat.texture, other: stat.other,
      files: Object.keys(files).length,
    },
    files,
  };
  const manifestPath = path.join(outVer, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(outVer, 'errors.log'), errors.join('\n') + '\n');

  const manifestSize = fs.statSync(manifestPath).size;
  console.log('\nBaked:');
  console.log(`  meshes        ${stat.mesh}`);
  console.log(`  clip meshes   ${stat.clip}`);
  console.log(`  textures      ${stat.texture}`);
  if (args.compress) {
    const cut = stat.glbRaw ? (1 - stat.glbOut / stat.glbRaw) * 100 : 0;
    console.log(`  glb meshopt   ${mb(stat.glbRaw)} -> ${mb(stat.glbOut)}  (${cut.toFixed(1)}% smaller${stat.uncompressed ? `, ${stat.uncompressed} left plain` : ''})`);
  }
  console.log(`  unique assets ${written.size}  (${mb(stat.bytes)} on disk)`);
  console.log(`  inline text   ${manifest.counts.files - stat.mesh - stat.clip - stat.texture - stat.other} files (${mb(textBytes)})`);
  console.log(`  manifest.json ${mb(manifestSize)}`);
  console.log(`  resolve/convert misses: ${errors.length} (see errors.log)`);
  console.log(`\nDone -> ${outVer}`);
}

main().catch((e) => { console.error('\nbake failed:', e.message); process.exit(1); });
