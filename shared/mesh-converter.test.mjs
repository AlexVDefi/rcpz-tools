// Node smoke test for the shared MeshConverter against real PZ assets.
// Run: node shared/mesh-converter.test.mjs  (requires a PZ install at PZ_DIR below)
import fs from 'node:fs';
import { createMeshConverter } from './mesh-converter.js';

const PZ = process.env.PZ_DIR || 'D:/Games/Steam/steamapps/common/ProjectZomboid';
const CASES = [
  { label: 'body',  file: `${PZ}/media/models_x/skinned/MaleBody.x`,          fmt: 'x', wantSkin: true,  wantAnim: true },
  { label: 'cloth', file: `${PZ}/media/models_x/skinned/Clothes/Bob_Apron.x`, fmt: 'x', wantSkin: true,  wantAnim: true },
  { label: 'anim',  file: `${PZ}/media/anims_x/Bob/Bob_ActionToSitIdle_2h.x`, fmt: 'x', wantSkin: true,  wantAnim: true },
];

function glbJson(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('bad glb magic');
  const total = buf.readUInt32LE(8); let off = 12;
  while (off < total) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) return JSON.parse(new TextDecoder().decode(buf.slice(off + 8, off + 8 + len)));
    off += 8 + len;
  }
  throw new Error('no JSON chunk');
}

const conv = createMeshConverter();
let fail = 0;
for (const c of CASES) {
  try {
    const src = fs.readFileSync(c.file);
    const glb = Buffer.from(await conv.convertToGlb(new Uint8Array(src), c.fmt));
    const j = glbJson(glb);
    const joints = (j.skins?.[0]?.joints || []).length;
    const anims = (j.animations || []).length;
    const skinned = (j.meshes || []).some((m) => m.primitives.some((p) => p.attributes?.JOINTS_0 != null));
    const ok = glb.length > 0 && (!c.wantSkin || (joints > 0 && skinned)) && (!c.wantAnim || anims > 0);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(6)} glb=${glb.length}b joints=${joints} anims=${anims} skinned=${skinned}`);
    if (!ok) fail++;
  } catch (e) { console.log(`FAIL  ${c.label.padEnd(6)} ${e.message}`); fail++; }
}
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
