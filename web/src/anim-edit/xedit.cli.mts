// Node CLI to bake a constant per-bone edit into a .x, for verification and the
// Electron-side export path. Node 22.18+ strips TS types, so run directly:
//   node web/src/anim-edit/xedit.cli.mts --src in.x --dst out.x --bone Bip01_R_UpperArm --euler 0,40,0 [--pos 0,0.1,0] [--set NAME] [--mode post|pre] [--order XYZ] [--rename NewSet]
import { readFileSync, writeFileSync } from 'node:fs';
import { applyDelta, applyTranslationDelta, eulerToQuat, renameSet, appDeltaToX, appPosToX, type Vec3 } from './xedit.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const need = (k: string) => { const v = args.get(k); if (v == null) throw new Error(`missing --${k}`); return v; };
const nums = (s: string | undefined, n: number): number[] | null => s == null ? null : s.split(',').map(Number).concat([0, 0, 0]).slice(0, n);

const src = need('src');
const dst = need('dst');
const bone = need('bone');
const animSet = args.get('set') ?? null;
const mode = (args.get('mode') ?? 'post') as 'post' | 'pre';
const order = args.get('order') ?? 'XYZ';

const appSpace = args.get('space') === 'app'; // mirror engine.bakeEdits: euler/pos are app-space, converted via the calibration
let text = readFileSync(src, 'utf8'); // utf8 read does not translate line endings, so CRLF/LF survive
const euler = nums(args.get('euler'), 3);
const pos = nums(args.get('pos'), 3);
let rotKeys = 0, posKeys = 0;
if (euler) { const A = eulerToQuat(euler[0], euler[1], euler[2], order); const r = applyDelta(text, bone, appSpace ? appDeltaToX(A) : A, animSet, mode); text = r.text; rotKeys = r.keys; }
if (pos) { const p = pos as Vec3; const r = applyTranslationDelta(text, bone, appSpace ? appPosToX(p) : p, animSet); text = r.text; posKeys = r.keys; }
const rename = args.get('rename');
if (rename && animSet) text = renameSet(text, animSet, rename).text;
writeFileSync(dst, text, { encoding: 'utf8' });
console.log(`baked ${bone}: rotKeys=${rotKeys} posKeys=${posKeys} -> ${dst}`);
