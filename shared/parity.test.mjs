// Regression anchor: prove the new async shared/ core produces the SAME results as the
// original sync src/ modules, over a real PZ install, headless. (Path resolution only -
// no glb conversion - so the old koffi/sharp deps aren't triggered.)
import { createRequire } from 'node:module';
import { createNodeAssetSource } from './asset-source.js';
import { buildAssetIndex } from './asset-index.js';
import { parseMod } from './icon-core.js';
import { listClips, listClothing, listHeldItems } from './character-core.js';

const require = createRequire(import.meta.url);
const SRC = 'C:/dev/pz-icon-maker/src';
const PZ = process.env.PZ_DIR || 'D:/Games/Steam/steamapps/common/ProjectZomboid';

const { resolveMod, resolveModLayout } = require(`${SRC}/resolve.js`);
const { buildVfs } = require(`${SRC}/vfs.js`);
const oldClothing = require(`${SRC}/character/clothing.js`);
const oldAssets = require(`${SRC}/character/assets.js`);
const oldItems = require(`${SRC}/character/items.js`);

let fail = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${detail || ''}`); if (!cond) fail++; };

// ---- OLD (sync) ----
const oldMod = resolveMod(PZ, {});
const oldRoots = resolveModLayout(PZ).roots;
const oldVfs = oldMod.vfs;
const oldClo = oldClothing.listClothing(oldVfs, oldRoots, oldClothing.buildClothingLocations(oldVfs));
const oldClips = oldAssets.listClips(oldVfs, oldRoots);
const oldHeld = oldItems.listHeldItems(oldVfs);

// ---- NEW (async) ----
const sources = [createNodeAssetSource(PZ, { id: 'install', isMod: false })];
const index = await buildAssetIndex(sources);
const { records, models, counts } = parseMod(index);
const newClo = listClothing(index);
const newClips = listClips(index);
const newHeld = listHeldItems(index);

// ---- compare lists ----
const names = (a, k) => new Set(a.map((x) => x[k]));
const setEq = (A, B) => A.size === B.size && [...A].every((x) => B.has(x));

check('model count', counts.models === oldMod.counts.models, `new=${counts.models} old=${oldMod.counts.models}`);
check('clothing names', setEq(names(newClo, 'name'), names(oldClo, 'name')), `new=${newClo.length} old=${oldClo.length}`);
check('clothing kinds match', newClo.every((c) => { const o = oldClo.find((x) => x.name === c.name); return o && o.kind === c.kind && o.location === c.location; }), 'kind+location per item');
check('clip ids', setEq(names(newClips, 'id'), names(oldClips, 'id')), `new=${newClips.length} old=${oldClips.length}`);
check('held item names', setEq(names(newHeld, 'name'), names(oldHeld, 'name')), `new=${newHeld.length} old=${oldHeld.length}`);

// ---- compare renderable icon resolution (paths only) ----
const tail = (p) => (p ? String(p).replace(/\\/g, '/').toLowerCase().replace(/^.*?media\//, '') : null);
let newRenderable = 0, meshMismatch = 0, sample = 0;
for (const rec of records) {
  const m = rec.mesh ? await index.resolver.resolveMesh(rec.mesh) : null;
  const t = rec.textureName ? await index.resolver.resolveTexture(rec.textureName) : null;
  const okMesh = m && !m.unsupported, okTex = !!t;
  if (okMesh && okTex && rec.icon) newRenderable++;
  // spot-check the resolved mesh path matches the old record's meshFile for base items
  if (rec.variant === 'base' && okMesh && sample < 400) {
    const oldRec = oldMod.records.find((r) => r.item === rec.item && r.variant === 'base');
    if (oldRec && oldRec.meshFile) { sample++; if (tail(m.realPath) !== tail(oldRec.meshFile)) meshMismatch++; }
  }
}
const oldRenderable = oldMod.counts.renderable;
check('renderable count', Math.abs(newRenderable - oldRenderable) <= 2, `new=${newRenderable} old=${oldRenderable}`);
check('mesh path parity (sampled)', meshMismatch === 0, `${sample} checked, ${meshMismatch} mismatched`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED - new shared core matches old src');
process.exit(fail ? 1 : 0);
