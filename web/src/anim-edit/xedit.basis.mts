// Derive the fixed basis change assimpjs applies to bone rotations (PZ .x local space
// -> glTF/three local space). We bake a known .x-space delta d onto a bone, reconvert
// through the app importer, and read the resulting app-space delta d_app. Fitting
// d_app = P d P^-1 (a similarity) over several deltas gives P, the calibration the bake
// needs to turn an app-space bone edit back into an .x delta.
import { readFileSync } from 'node:fs';
import { createMeshConverter } from '../../../shared/mesh-converter.js';
import { applyDelta, eulerToQuat, qmul, qconj, qnorm, type Quat } from './xedit.ts';

const src = process.argv[2];
const bone = process.argv[3] || 'Bip01_R_UpperArm';
const text = readFileSync(src, 'utf8');
const conv = createMeshConverter();

function firstBoneQuat(glb: Uint8Array, boneName: string): Quat {
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
  const ch = anim.channels.find((c: any) => c.target.node === nodeIdx && c.target.path === 'rotation');
  const acc = json.accessors[anim.samplers[ch.sampler].output];
  const bv = json.bufferViews[acc.bufferView];
  const b = binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0);
  return [dv.getFloat32(b + 12, true), dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)];
}
const axisAngle = (q: Quat) => { const w = Math.min(1, Math.abs(q[0])); const ang = 2 * Math.acos(w) * 180 / Math.PI; const s = Math.sqrt(1 - w * w) || 1; const sign = q[0] < 0 ? -1 : 1; return { ang, axis: [sign * q[1] / s, sign * q[2] / s, sign * q[3] / s] as [number, number, number] }; };

const qo = firstBoneQuat(await conv.convertToGlb(readFileSync(src), 'x'), bone);
async function dApp(d: Quat): Promise<Quat> {
  const baked = applyDelta(text, bone, d, null, 'post').text;
  const qb = firstBoneQuat(await conv.convertToGlb(new TextEncoder().encode(baked), 'x'), bone);
  return qnorm(qmul(qconj(qo), qb)); // baked_glb = qo * d_app  =>  d_app = conj(qo) * baked_glb
}

const tests: [string, Quat][] = [
  ['X+40', eulerToQuat(40, 0, 0)], ['Y+40', eulerToQuat(0, 40, 0)], ['Z+40', eulerToQuat(0, 0, 40)],
  ['compound(25,10,-15)', eulerToQuat(25, 10, -15)],
];
const measured: Record<string, Quat> = {};
for (const [name, d] of tests) { const da = await dApp(d); measured[name] = da; const aa = axisAngle(da); console.log(`${name.padEnd(20)} d_app axis=[${aa.axis.map((v) => v.toFixed(3)).join(', ')}] angle=${aa.ang.toFixed(1)}`); }

// Fit P as the rotation whose columns are how X,Y,Z map. d_app axis for X+40 = P*[1,0,0], etc.
const cx = axisAngle(measured['X+40']).axis, cy = axisAngle(measured['Y+40']).axis, cz = axisAngle(measured['Z+40']).axis;
// Build a quaternion from the 3x3 matrix with columns cx,cy,cz.
const m = [cx[0], cy[0], cz[0], cx[1], cy[1], cz[1], cx[2], cy[2], cz[2]];
const tr = m[0] + m[4] + m[8];
let P: Quat;
if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; P = [0.25 * S, (m[7] - m[5]) / S, (m[2] - m[6]) / S, (m[3] - m[1]) / S]; }
else if (m[0] > m[4] && m[0] > m[8]) { const S = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2; P = [(m[7] - m[5]) / S, 0.25 * S, (m[1] + m[3]) / S, (m[2] + m[6]) / S]; }
else if (m[4] > m[8]) { const S = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2; P = [(m[2] - m[6]) / S, (m[1] + m[3]) / S, 0.25 * S, (m[5] + m[7]) / S]; }
else { const S = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2; P = [(m[3] - m[1]) / S, (m[2] + m[6]) / S, (m[5] + m[7]) / S, 0.25 * S]; }
P = qnorm(P);
console.log('\nfitted P (wxyz):', P.map((v) => v.toFixed(4)).join(', '), `det>0 rotation; |axes| ${[cx, cy, cz].map((c) => Math.hypot(...c).toFixed(3)).join('/')}`);

const dot = (a: Quat, b: Quat) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
console.log('\nverify d_app == P * d * conj(P):');
for (const [name, d] of tests) { const pred = qnorm(qmul(qmul(P, d), qconj(P))); console.log(`  ${name.padEnd(20)} dot=${dot(pred, measured[name]).toFixed(4)} ${dot(pred, measured[name]) > 0.999 ? 'MATCH' : ''}`); }
