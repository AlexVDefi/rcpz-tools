// End-to-end async character core over a real PZ install (headless, Node).
import { createNodeAssetSource } from './asset-source.js';
import { buildAssetIndex } from './asset-index.js';
import { createMeshConverter } from './mesh-converter.js';
import { listClips, listClothing, listHair, listHeldItems, resolveBody, resolveClothing, resolveClip } from './character-core.js';

const PZ = process.env.PZ_DIR || 'D:/Games/Steam/steamapps/common/ProjectZomboid';
const isGlb = (u8) => u8 && u8.length > 4 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46; // 'glTF'

let fail = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${detail || ''}`); if (!cond) fail++; };

const t0 = Date.now();
const sources = [createNodeAssetSource(PZ, { id: 'install', isMod: false })];
const index = await buildAssetIndex(sources);
console.log(`index built in ${Date.now() - t0}ms  (scripts=${index.scriptFiles.length} clothing=${index.clothingFiles.length} anims=${index.animClips.length})\n`);

const clips = listClips(index);
const clothing = listClothing(index);
const { hair, beards } = listHair(index);
const held = listHeldItems(index);
check('listClips', clips.length > 100, `${clips.length} human clips`);
check('listClothing', clothing.length > 100, `${clothing.length} items`);
check('listHair', hair.male.length > 0 && hair.female.length > 0, `M=${hair.male.length} F=${hair.female.length} beards=${beards.length}`);
check('listHeldItems', held.length > 50, `${held.length} held models`);

const ctx = { resolver: index.resolver, converter: createMeshConverter() };

const body = await resolveBody(ctx, { gender: 'male' });
check('resolveBody -> glb', isGlb(body.meshGlb), `glb=${body.meshGlb?.length}b skin=${body.skin} tex=${body.skinTexture?.length}b`);

const meshCloth = clothing.find((c) => c.kind === 'mesh');
if (meshCloth) {
  const r = await resolveClothing(ctx, meshCloth, 'male');
  check(`resolveClothing("${meshCloth.name}")`, isGlb(r.meshGlb), r.error || `glb=${r.meshGlb?.length}b tex=${r.texture?.length}b masks=${r.maskTextures?.length}`);
} else check('resolveClothing', false, 'no mesh-kind clothing found');

if (clips.length) {
  const r = await resolveClip(ctx, clips.find((c) => c.format === 'x') || clips[0]);
  check(`resolveClip("${r.name}")`, isGlb(r.glb), r.error || `glb=${r.glb?.length}b`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
