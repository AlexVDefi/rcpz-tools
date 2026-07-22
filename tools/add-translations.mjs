// Add per-language item-name translations to an ALREADY-BAKED bundle, in place, without a full
// re-bake (which would re-convert + re-hash every mesh). PZ keeps them at
// media/lua/shared/Translate/<LANG>/ItemName.json (B42) or ItemName_<LANG>.txt (B41). We copy each
// into assets/ as a content-hashed binary and register it in manifest.json, so the hosted app can
// localize clothing/item names and offer a language picker. Fetched on demand (only the chosen lang).
//
// Usage: node tools/add-translations.mjs [--bundle asset-bake/42] [--install <PZ dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const sha16 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const ext = (p) => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i).toLowerCase(); };

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

const tRoot = path.join(install, 'media', 'lua', 'shared', 'Translate');
let langDirs = [];
try { langDirs = fs.readdirSync(tRoot, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { throw new Error(`no Translate dir at ${tRoot}`); }

let added = 0, bytesAdded = 0;
for (const ld of langDirs) {
  const langDir = path.join(tRoot, ld.name);
  let inner = [];
  try { inner = fs.readdirSync(langDir); } catch { continue; }
  const file = inner.find((n) => /^itemname\.json$/i.test(n)) || inner.find((n) => /^itemname_.*\.txt$/i.test(n));
  if (!file) continue;
  const bytes = fs.readFileSync(path.join(langDir, file));
  const outExt = ext(file).slice(1) || 'bin';
  const hash = sha16(bytes);
  const dst = path.join(assetsDir, `${hash}.${outExt}`);
  if (!fs.existsSync(dst)) { fs.writeFileSync(dst, bytes); bytesAdded += bytes.length; }
  manifest.files[`media/lua/shared/Translate/${ld.name}/${file}`] = { kind: 'bin', hash, ext: outExt, size: bytes.length };
  added++;
}

manifest.counts = manifest.counts || {};
manifest.counts.files = Object.keys(manifest.files).length;
manifest.counts.translations = added;
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`Install: ${install}`);
console.log(`Bundle : ${bundle}`);
console.log(`Added  : ${added} language ItemName files (${(bytesAdded / 1048576).toFixed(2)} MB new to assets/)`);
console.log(`Manifest now lists ${manifest.counts.files} files. Re-upload with: node tools/upload-r2.mjs --bundle ${path.relative(REPO_ROOT, bundle)}`);
