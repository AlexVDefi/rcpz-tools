// Add the minimal scene-view floor pack to an ALREADY-BAKED bundle, in place, without a full re-bake.
// Registers a small repacked Tiles2x floor pack (only the 30 preset tiles) as a content-hashed binary
// at media/texturepacks/tiles2x.floor.pack, so the hosted app's Scene > Floor presets work with real
// tile blending. Fetched on demand (only when the user opens the floor options).
//
// Usage: node tools/add-floors.mjs [--bundle asset-bake/42] [--install <PZ dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildMinimalFloorPack, FLOOR_PACK_VPATH, FLOOR_TILES } from './floor-pack.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const sha16 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);

function resolveInstall(explicit) {
  const isGame = (p) => { try { return !!p && fs.statSync(path.join(p, 'media')).isDirectory(); } catch { return false; } };
  if (isGame(explicit)) return path.resolve(explicit);
  try { const saved = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pz-icon-maker.json'), 'utf8')).gameDir; if (isGame(saved)) return path.resolve(saved); } catch {}
  throw new Error('could not find the Project Zomboid install; pass --install <dir>');
}

const bundle = path.resolve(REPO_ROOT, arg('--bundle', 'asset-bake/42'));
const install = resolveInstall(arg('--install'));
const manifestPath = path.join(bundle, 'manifest.json');
const assetsDir = path.join(bundle, 'assets');
if (!fs.existsSync(manifestPath)) throw new Error(`no manifest.json in ${bundle}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const packBytes = await buildMinimalFloorPack(install);
const hash = sha16(packBytes);
const dst = path.join(assetsDir, `${hash}.pack`);
if (!fs.existsSync(dst)) fs.writeFileSync(dst, packBytes);
manifest.files[FLOOR_PACK_VPATH] = { kind: 'bin', hash, ext: 'pack', size: packBytes.length };

manifest.counts = manifest.counts || {};
manifest.counts.files = Object.keys(manifest.files).length;
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`Install: ${install}`);
console.log(`Bundle : ${bundle}`);
console.log(`Floor pack: ${FLOOR_TILES.length} preset tiles -> ${(packBytes.length / 1048576).toFixed(2)} MB (${hash}.pack)`);
console.log(`Manifest now lists ${manifest.counts.files} files. Re-upload with: node tools/upload-r2.mjs --bundle ${path.relative(REPO_ROOT, bundle)}`);
