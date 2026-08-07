// Probe how an .x translation-key delta shows up as an app-space bone position delta,
// so the bake can convert the editor's app-space offset back to .x units (basis + scale).
import { readFileSync } from 'node:fs';
import { createMeshConverter } from '../../../shared/mesh-converter.js';
import { applyTranslationDelta } from './xedit.ts';

const src = process.argv[2];
const bone = process.argv[3] || 'Bip01_R_UpperArm';
const text = readFileSync(src, 'utf8');
const conv = createMeshConverter();

function firstBonePos(glb: Uint8Array, boneName: string): [number, number, number] | null {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  let off = 12, json: any = null, binStart = 0;
  while (off < glb.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true), start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(glb.subarray(start, start + len)));
    else if (type === 0x004e4942) binStart = start;
    off = start + len;
  }
  const nodeIdx = json.nodes.findIndex((n: any) => n.name && n.name.includes(boneName));
  const anim = json.animations[0];
  const ch = anim.channels.find((c: any) => c.target.node === nodeIdx && c.target.path === 'translation');
  if (!ch) { const t = json.nodes[nodeIdx].translation; return t ? [t[0], t[1], t[2]] : null; } // fall back to node base
  const acc = json.accessors[anim.samplers[ch.sampler].output];
  const bv = json.bufferViews[acc.bufferView];
  const b = binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0);
  return [dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)];
}

const to = firstBonePos(await conv.convertToGlb(readFileSync(src), 'x'), bone)!;
async function dPos(d: [number, number, number]): Promise<[number, number, number]> {
  const baked = applyTranslationDelta(text, bone, d, null).text;
  const tb = firstBonePos(await conv.convertToGlb(new TextEncoder().encode(baked), 'x'), bone)!;
  return [tb[0] - to[0], tb[1] - to[1], tb[2] - to[2]];
}

console.log(`bone ${bone}, orig glb translation: [${to.map((v) => v.toFixed(4)).join(', ')}]`);
for (const [name, d] of [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]] as [string, [number, number, number]][]) {
  const da = await dPos(d);
  console.log(`.x T-delta ${name}=1  ->  app pos delta [${da.map((v) => v.toFixed(4)).join(', ')}]  |mag ${Math.hypot(...da).toFixed(4)}`);
}
