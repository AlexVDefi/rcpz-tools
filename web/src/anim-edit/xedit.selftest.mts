// Node-runnable regression check for xedit.ts, ported from x_edit.py:_selftest.
// Run: node web/src/anim-edit/xedit.selftest.mts   (Node 22.18+ strips TS types)
import { eulerToQuat, qslerp, qconj, qmul, qnorm, applyRotTimeline, applyPosTimeline, _internal, type Quat } from './xedit.ts';

const { iterBoneKeyBlocks, parseBodyKeys, R_KEY_FULL_SRC, T_KEY_FULL_SRC, BODY_HEAD_RE } = _internal as {
  iterBoneKeyBlocks: (t: string, span: [number, number], bone: string, letter: string) => Generator<[number, number]>;
  parseBodyKeys: (body: string, src: string) => [number, number[]][];
  R_KEY_FULL_SRC: string; T_KEY_FULL_SRC: string; BODY_HEAD_RE: RegExp;
};

const eol = '\r\n';
const q0: Quat = [1, 0, 0, 0];
const q1 = eulerToQuat(0, 40, 0);
const f = (v: number) => v.toFixed(6);
const text = [
  'xof 0303txt 0032', 'AnimTicksPerSecond  {', ' 4800;', '}',
  'AnimationSet Test_Clip {', ' Animation {', '  { Bip01_R_UpperArm }',
  '  AnimationKey R {', '   0;', '   2;',
  `   0;4;${f(q0[0])},${f(q0[1])},${f(q0[2])},${f(q0[3])};;,`,
  `   4800;4;${f(q1[0])},${f(q1[1])},${f(q1[2])},${f(q1[3])};;;`,
  '  }', '  AnimationKey T {', '   2;', '   2;',
  '   0;3;0.000000,0.000000,0.000000;;,',
  '   4800;3;1.000000,0.000000,0.000000;;;',
  '  }', ' }', '}', ''].join(eol);

const ticks = [0, 2400, 4800];
const rots: [number, number, number][] = [[0, 0, 0], [30, 0, 0], [0, 0, 0]];
const poss: [number, number, number][] = [[0, 0, 0], [0.1, 0, 0], [0, 0, 0]];
const lerpAt = (vals: [number, number, number][], tick: number): [number, number, number] => {
  if (tick <= ticks[0]) return vals[0];
  if (tick >= ticks[ticks.length - 1]) return vals[vals.length - 1];
  for (let i = 0; i < ticks.length - 1; i++) {
    if (ticks[i] <= tick && tick <= ticks[i + 1]) {
      const fr = (tick - ticks[i]) / (ticks[i + 1] - ticks[i]);
      return [0, 1, 2].map((c) => vals[i][c] + (vals[i + 1][c] - vals[i][c]) * fr) as [number, number, number];
    }
  }
  return vals[vals.length - 1];
};

const rot = applyRotTimeline(text, 'Bip01_R_UpperArm', (tk) => eulerToQuat(...lerpAt(rots, tk)), ticks, 'Test_Clip');
const pos = applyPosTimeline(rot.text, 'Bip01_R_UpperArm', (tk) => lerpAt(poss, tk), ticks, 'Test_Clip');
const out = pos.text;

let ok = true;
const check = (label: string, cond: boolean) => { console.log(`  ${label.padEnd(48)} ${cond ? 'OK' : 'FAIL'}`); ok &&= cond; };
const firstBlock = (letter: string, src: string): Record<number, number[]> => {
  const [bs, be] = iterBoneKeyBlocks(out, [0, out.length], 'Bip01_R_UpperArm', letter).next().value as [number, number];
  return Object.fromEntries(parseBodyKeys(out.slice(bs, be), src));
};

check('rotation key inserted at the midpoint', rot.inserted === 1 && rot.keys === 3);
check('translation key inserted at the midpoint', pos.inserted === 1 && pos.keys === 3);

let countsOk = true;
for (const [letter, src] of [['R', R_KEY_FULL_SRC], ['T', T_KEY_FULL_SRC]] as const) {
  for (const [bs, be] of iterBoneKeyBlocks(out, [0, out.length], 'Bip01_R_UpperArm', letter)) {
    const body = out.slice(bs, be);
    const declared = parseInt(BODY_HEAD_RE.exec(body)![4], 10);
    countsOk &&= declared === parseBodyKeys(body, src).length;
  }
}
check('declared nKeys matches the keys written', countsOk);

const baked = firstBlock('R', R_KEY_FULL_SRC);
const base: Record<number, Quat> = { 0: q0, 2400: qslerp(q0, q1, 0.5), 4800: q1 };
let worst = 0;
for (const tick of ticks) {
  const recovered = qconj(qnorm(qmul(baked[tick] as Quat, qconj(base[tick]))));
  const want = eulerToQuat(...lerpAt(rots, tick));
  const dot = recovered[0] * want[0] + recovered[1] * want[1] + recovered[2] * want[2] + recovered[3] * want[3];
  worst = Math.max(worst, Math.abs(Math.abs(dot) - 1));
}
check(`rotation delta at each key matches (err ${worst.toExponential(2)})`, worst < 1e-5);

const endsOk = [0, 4800].every((t) => {
  const d = baked[t][0] * base[t][0] + baked[t][1] * base[t][1] + baked[t][2] * base[t][2] + baked[t][3] * base[t][3];
  return Math.abs(Math.abs(d) - 1) < 1e-5;
});
check("clip's own motion preserved where the delta is 0", endsOk);

const bakedT = firstBlock('T', T_KEY_FULL_SRC);
check('translation delta added on top of the clip T', Math.abs(bakedT[2400][0] - 0.6) < 1e-5 && Math.abs(bakedT[4800][0] - 1.0) < 1e-5);
check('CRLF line endings preserved', out.includes('\r\n') && !out.includes('\n\r'));

console.log('selftest:', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
