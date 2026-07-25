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
import { buildMinimalFloorPack, FLOOR_PACK_VPATH, FLOOR_TILES } from './floor-pack.mjs';
import {
  listClothing, listHair, listHeldItems, listClips, listZombieSkins,
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
  const a = { install: null, version: 'unknown', out: null, limitClips: 0, compress: true, mod: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--install') a.install = argv[++i];
    else if (v === '--version') a.version = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--limit-clips') a.limitClips = parseInt(argv[++i], 10) || 0;
    else if (v === '--mod') a.mod = argv[++i]; // bake ONE mod's new character assets (layered over --install)
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

// A mod's asset roots: its highest version dir + common/ (each containing media/), like the game.
function modRoots(modDir) {
  const abs = path.resolve(modDir);
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch {}
  const hasMedia = (d) => { try { return fs.statSync(path.join(d, 'media')).isDirectory(); } catch { return false; } };
  const versions = entries.map((e) => e.name).filter((n) => /^\d+(\.\d+)*$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const roots = [];
  const top = versions[versions.length - 1]; // highest version dir
  if (top && hasMedia(path.join(abs, top))) roots.push(path.join(abs, top));
  const common = entries.find((e) => e.name.toLowerCase() === 'common');
  if (common && hasMedia(path.join(abs, common.name))) roots.push(path.join(abs, common.name));
  if (!roots.length && hasMedia(abs)) roots.push(abs);
  return roots;
}

// Read a mod's id + name from its mod.info (the dir itself, common/, or a version dir).
function readModInfo(modDir) {
  const abs = path.resolve(modDir);
  const dirs = [abs];
  try { for (const e of fs.readdirSync(abs, { withFileTypes: true })) if (e.isDirectory()) dirs.push(path.join(abs, e.name)); } catch {}
  for (const dir of dirs) {
    try {
      const txt = fs.readFileSync(path.join(dir, 'mod.info'), 'utf8');
      const id = (txt.match(/^\s*id\s*=\s*(.+)$/mi) || [])[1]?.trim();
      const name = (txt.match(/^\s*name\s*=\s*(.+)$/mi) || [])[1]?.trim();
      if (id || name) return { id: id || path.basename(abs), name: name || id || path.basename(abs) };
    } catch { /* keep looking */ }
  }
  return { id: path.basename(abs), name: path.basename(abs) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('usage: node tools/bake-assets.mjs --install <PZ dir> [--version 42.13.0] [--out dir] [--limit-clips N]'); return; }

  const modBake = !!args.mod;
  // Vanilla install is required for a vanilla bake; for a mod bake it is optional - if present it
  // resolves vanilla assets the mod reuses (so they are found, not baked); if absent, those
  // references simply miss (they live in the vanilla bundle at runtime anyway).
  let install = null;
  try { install = resolveInstall(args.install); } catch (e) { if (!modBake) throw e; }
  const modInfo = modBake ? readModInfo(args.mod) : null;
  const outRoot = args.out ? path.resolve(args.out) : path.join(REPO_ROOT, 'asset-bake');
  const outVer = modBake ? path.join(outRoot, 'mods', modInfo.id) : path.join(outRoot, args.version);
  const assetsDir = path.join(outVer, 'assets');
  fs.rmSync(outVer, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  console.log(`Install : ${install || '(none - mod-only, vanilla refs resolve at runtime)'}`);
  if (modBake) console.log(`Mod     : ${modInfo.name} (${modInfo.id})`);
  else console.log(`Version : ${args.version}`);
  console.log(`Output  : ${outVer}${args.limitClips ? `  (smoke test: ${args.limitClips} clips)` : ''}\n`);

  // Capture every binary the resolvers read, so we bake exactly the referenced closure. In mod mode
  // ONLY the mod's sources are wrapped: vanilla assets a mod reuses resolve to the (unwrapped)
  // install and stay in the vanilla bundle - never duplicated into the mod bundle.
  const refs = new Map(); // lowerRealPath -> { realPath, bytes }
  const capture = (base) => ({
    ...base,
    async readBytes(rel) {
      const bytes = await base.readBytes(rel);
      const key = rel.toLowerCase();
      if (!refs.has(key)) refs.set(key, { realPath: rel, bytes });
      return bytes;
    },
  });

  let sources;
  if (modBake) {
    const roots = modRoots(args.mod);
    if (!roots.length) throw new Error(`no media/ found under the mod: ${args.mod}`);
    const modSrcs = roots.map((r, i) => capture(createNodeAssetSource(r, { id: `mod:${i}`, isMod: true, modName: modInfo.name })));
    sources = [...modSrcs, ...(install ? [createNodeAssetSource(install, { id: 'pz-install' })] : [])]; // mod wins; vanilla (if any) for resolution only
  } else {
    sources = [capture(createNodeAssetSource(install, { id: 'pz-install' }))];
  }

  console.log('Indexing scripts / clothing / hair / anims ...');
  const index = await buildAssetIndex(sources);
  const resolver = index.resolver;

  const onlyMod = (arr) => (modBake ? arr.filter((x) => x.isMod) : arr);
  const clothing = onlyMod(listClothing(index));
  const { hair, beards } = listHair(index);
  const held = onlyMod(listHeldItems(index));
  const clips = onlyMod(listClips(index));
  const clipsToBake = args.limitClips ? clips.slice(0, args.limitClips) : clips;
  console.log(`Catalog : ${clothing.length} clothing, ${modBake ? 0 : hair.male.length + hair.female.length} hair, ${held.length} held, ${clips.length} clips${modBake ? '  (mod-provided only)' : ' human'}\n`);

  // --- discover the binary closure by exercising the real resolvers (stub converter = fast) ---
  const stub = { ready: async () => {}, convertToGlb: async (b, f) => (f === 'glb' || f === 'gltf' ? b : new Uint8Array(0)) };
  const ctx = { resolver, converter: stub };
  const errors = [];
  const tryEach = async (label, fn) => { try { const r = await fn(); if (r && r.error) errors.push(`${label}: ${r.error}`); } catch (e) { errors.push(`${label}: ${e.message}`); } };

  console.log('Tracing referenced assets ...');
  // Body, hair and masks are vanilla - they belong to the vanilla bundle, never a mod bundle.
  if (!modBake) {
    for (const g of ['male', 'female']) for (const skin of SKIN_TONES[g]) await tryEach(`body ${g}/${skin}`, () => resolveBody(ctx, { gender: g, skin }));
    for (const g of ['male', 'female']) for (const s of hair[g]) await tryEach(`hair ${s.name}`, () => resolveHairStyle(ctx, s));
    for (const s of beards) await tryEach(`beard ${s.name}`, () => resolveHairStyle(ctx, s));
  }
  for (const item of clothing) for (const g of ['male', 'female']) await tryEach(`clothing ${item.name}/${g}`, () => resolveClothing(ctx, item, g));
  for (const it of held) {
    await tryEach(`held ${it.name}`, () => resolveHeldItem(ctx, it));
    for (const slot of it.attachSlots || []) for (const opt of slot.options || []) await tryEach(`part ${opt.partName}`, () => resolveAttachmentPart(ctx, opt));
  }
  for (const c of clipsToBake) await tryEach(`clip ${c.name}`, () => resolveClip(ctx, c));
  if (!modBake) for (let m = 0; m < 16; m++) { const nm = MASK_PART[m]; if (!nm) continue; const hit = await resolver.resolveMediaPath(`media/textures/body/masks/${nm.toLowerCase()}.png`); if (hit) await hit.src.readBytes(hit.realPath); }
  // Zombie body skins: the rot-staged M_/F_ZedBody0X_levelN + human skeletons the game applies at
  // runtime (nothing else references them, so bake them explicitly or the studio's zombie picker is empty).
  if (!modBake) {
    const zed = new Set();
    for (const gg of ['male', 'female']) for (const nm of await listZombieSkins(ctx, gg)) zed.add(nm);
    for (const nm of zed) { const hit = await resolver.resolveTexture(`Body/${nm}`); if (hit) await hit.src.readBytes(hit.realPath); }
  }
  console.log(`Referenced ${refs.size} binaries; ${errors.length} entries could not resolve locally.\n`);

  // --- bake: convert meshes/clips to glb (once each), copy textures, content-hash everything ---
  const converter = createMeshConverter(); // real WASM converter, byte-identical to the browser's
  const files = {};                        // virtualPath -> { kind:'bin', hash, ext, size } | { kind:'text', text }
  const written = new Set();
  const stat = { mesh: 0, clip: 0, texture: 0, other: 0, bytes: 0, failed: 0, glbRaw: 0, glbOut: 0, uncompressed: 0 };
  console.log(args.compress ? 'Converting + compressing (meshopt FILTER, lossless rig) ...' : 'Converting (no compression) ...');

  let done = 0;
  for (const { realPath, bytes } of refs.values()) {
    const e = ext(realPath);
    const isClip = realPath.toLowerCase().includes('/anims_x/');
    try {
      let outBytes, outExt, virtualPath, kind;
      // Meshes (models_x) -> glb + meshopt. Animation CLIPS stay in their native format:
      // the app routes clips by extension, and only the native (.x) path plays vanilla clips
      // upright - a pre-converted .glb clip takes the foreign-skeleton retarget path and
      // mis-orients. Clips convert to glb in-browser on play, exactly like a local install.
      if (MESH_EXTS.has(e) && !isClip) {
        const glb = await converter.convertToGlb(bytes, e.slice(1));
        stat.glbRaw += glb.length;
        if (args.compress) {
          const r = await optimizeGlb(glb);
          outBytes = r.bytes; if (!r.compressed) stat.uncompressed++;
        } else outBytes = glb;
        stat.glbOut += outBytes.length;
        outExt = 'glb';
        virtualPath = realPath.slice(0, realPath.length - e.length) + '.glb';
        kind = 'mesh';
      } else {
        outBytes = bytes; outExt = e.slice(1) || 'bin'; virtualPath = realPath;
        kind = isClip ? 'clip' : (e === '.png' ? 'texture' : 'other');
      }
      // Normalise to a typed array before hashing/writing: crypto.update and writeFileSync reject a
      // plain Array (some converter/optimizer paths hand one back), which used to kill the whole bake.
      const buf = ArrayBuffer.isView(outBytes) ? outBytes : Buffer.from(outBytes);
      const hash = sha16(buf);
      const fname = `${hash}.${outExt}`;
      if (!written.has(hash)) { fs.writeFileSync(path.join(assetsDir, fname), buf); written.add(hash); stat.bytes += buf.length; }
      files[virtualPath] = { kind: 'bin', hash, ext: outExt, size: buf.length };
      stat[kind]++;
    } catch (err) { stat.failed++; errors.push(`convert ${realPath}: ${err.message}`); continue; }
    if (++done % 100 === 0) process.stdout.write(`  converted ${done}/${refs.size}\r`);
  }
  process.stdout.write(`  converted ${done}/${refs.size}\n`);
  if (stat.failed) console.warn(`  ${stat.failed} asset(s) skipped:\n    ${errors.slice(-Math.min(stat.failed, 8)).join('\n    ')}`);

  // --- inline the small text trees the browser's buildAssetIndex parses ---
  // Prune scripts to those the character catalog actually reads (same guards listHeldItems /
  // buildClothingLocations use), so the manifest carries model/clothing/weapon defs only.
  const scriptWanted = (t) => t.includes('ClothingItem') || t.includes('model ') || t.includes('DisplayCategory') || t.includes('WeaponSprite');
  let textBytes = 0;
  const addText = (rel, text) => { files[rel] = { kind: 'text', text }; textBytes += Buffer.byteLength(text); };
  for (const f of index.scriptFiles) if ((!modBake || f.isMod) && scriptWanted(f.text)) addText(f.rel, f.text);
  for (const f of index.clothingFiles) if (!modBake || f.isMod) addText(f.rel, f.text);
  // hairXml/beardXml are now per-source arrays ([{ text, isMod, modName }], mods first); the vanilla
  // bundle inlines the raw vanilla file so the hosted app's buildAssetIndex re-parses it. (Older index
  // builds returned a bare string, so accept both.)
  const xmlText = (v) => (Array.isArray(v) ? (v.find((e) => !e.isMod) || v[0])?.text : v);
  if (!modBake) { const t = xmlText(index.hairXml); if (t) addText('media/hairstyles/hairstyles.xml', t); }
  if (!modBake) { const t = xmlText(index.beardXml); if (t) addText('media/hairstyles/beardstyles.xml', t); }

  // --- per-language item-name translations (media/lua/shared/Translate/<LANG>/ItemName.json | .txt) ---
  // Added as hashed binaries, not inline: all languages total a few MB, so the browser fetches only
  // the one it needs (via the hosted source's readText, which falls through to a CDN fetch). This is
  // what lets the built-in-assets version show localized clothing/item names + offer a language picker.
  const transRoots = modBake ? modRoots(args.mod) : (install ? [install] : []);
  let transCount = 0;
  for (const root of transRoots) {
    const tRoot = path.join(root, 'media', 'lua', 'shared', 'Translate');
    let langDirs = [];
    try { langDirs = fs.readdirSync(tRoot, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const ld of langDirs) {
      const langDir = path.join(tRoot, ld.name);
      let inner = [];
      try { inner = fs.readdirSync(langDir); } catch { continue; }
      const file = inner.find((n) => /^itemname\.json$/i.test(n)) || inner.find((n) => /^itemname_.*\.txt$/i.test(n));
      if (!file) continue;
      const virtualPath = `media/lua/shared/Translate/${ld.name}/${file}`;
      if (files[virtualPath.toLowerCase?.() ?? virtualPath] || files[virtualPath]) continue; // vanilla wins if a mod re-ships a language
      const bytes = fs.readFileSync(path.join(langDir, file));
      const outExt = ext(file).slice(1) || 'bin';
      const hash = sha16(bytes);
      const fname = `${hash}.${outExt}`;
      if (!written.has(hash)) { fs.writeFileSync(path.join(assetsDir, fname), bytes); written.add(hash); stat.bytes += bytes.length; }
      files[virtualPath] = { kind: 'bin', hash, ext: outExt, size: bytes.length };
      transCount++;
    }
  }
  if (transCount) console.log(`Translations : ${transCount} language ItemName files`);

  // --- scene-view floor tiles (media/texturepacks/tiles2x.floor.pack, minimal) ---
  // Only the ~30 sprites the six floor presets use, repacked into one sub-MB atlas (see floor-pack.mjs),
  // registered as an on-demand binary so the hosted app's Scene > Floor options work with tile blending.
  if (!modBake && install) {
    try {
      const packBytes = await buildMinimalFloorPack(install);
      const hash = sha16(packBytes);
      const fname = `${hash}.pack`;
      if (!written.has(hash)) { fs.writeFileSync(path.join(assetsDir, fname), packBytes); written.add(hash); stat.bytes += packBytes.length; }
      files[FLOOR_PACK_VPATH] = { kind: 'bin', hash, ext: 'pack', size: packBytes.length };
      console.log(`Floor pack   : ${FLOOR_TILES.length} preset tiles (${(packBytes.length / 1048576).toFixed(2)} MB)`);
    } catch (e) { console.warn(`Floor pack   : skipped (${e.message})`); }
  }

  const manifest = {
    schema: 1,
    game: 'ProjectZomboid',
    version: args.version,
    generatedAt: new Date().toISOString(),
    assetBase: 'assets/',
    kind: modBake ? 'mod' : 'vanilla',
    mod: modBake ? { id: modInfo.id, name: modInfo.name } : null,
    vanillaOnly: !modBake,
    // glbs are EXT_meshopt_compression when compression is on: the browser GLTFLoader needs
    // a MeshoptDecoder to parse them (plain glbs still load without it).
    meshopt: args.compress,
    meshoptMethod: args.compress ? 'filter' : null,
    counts: {
      clothing: clothing.length, hair: modBake ? 0 : hair.male.length + hair.female.length, beards: modBake ? 0 : beards.length,
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
  console.log(`  meshes        ${stat.mesh}  (glb + meshopt)`);
  console.log(`  clips         ${stat.clip}  (native .x, in-browser convert)`);
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

main().catch((e) => { console.error('\nbake failed:', e.stack || e.message); process.exit(1); });
