// Port of pz-anim-forge's x_edit.py: edit PZ DirectX .x animation clips by pure
// text surgery. We locate one bone's AnimationKey R/S/T body and splice new
// numbers in, leaving every other byte (other bones, the skinned mesh, CRLF,
// even malformed lone-';' lines) verbatim, so the game loads the clip exactly as
// vanilla plus the nudge. See ANIMATION_EDITOR_PLAN.md.

export type Quat = [number, number, number, number]; // w, x, y, z
export type Vec3 = [number, number, number];

// ---- quaternion helpers (w, x, y, z) ---------------------------------------

export function qmul(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function qnorm(q: Quat): Quat {
  const [w, x, y, z] = q;
  const n = Math.sqrt(w * w + x * x + y * y + z * z) || 1.0;
  return [w / n, x / n, y / n, z / n];
}

export function qconj(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

/** Shortest-arc spherical interpolation between two unit quats. */
export function qslerp(a: Quat, b: Quat, f: number): Quat {
  a = qnorm(a);
  b = qnorm(b);
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0.0) { b = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; } // q and -q are the same rotation
  if (dot > 0.9995) return qnorm([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]);
  const th0 = Math.acos(Math.max(-1.0, Math.min(1.0, dot)));
  const th = th0 * f;
  const s0 = Math.sin(th0);
  const w1 = Math.sin(th0 - th) / s0;
  const w2 = Math.sin(th) / s0;
  return qnorm([w1 * a[0] + w2 * b[0], w1 * a[1] + w2 * b[1], w1 * a[2] + w2 * b[2], w1 * a[3] + w2 * b[3]]);
}

/** Intrinsic euler (degrees) -> quaternion, applied in `order` (default XYZ). */
export function eulerToQuat(rxDeg: number, ryDeg: number, rzDeg: number, order = 'XYZ'): Quat {
  const axisQ = (angleDeg: number, ax: number, ay: number, az: number): Quat => {
    const h = (angleDeg * Math.PI) / 180 / 2;
    const s = Math.sin(h);
    return [Math.cos(h), ax * s, ay * s, az * s];
  };
  const qmap: Record<string, Quat> = {
    X: axisQ(rxDeg, 1, 0, 0),
    Y: axisQ(ryDeg, 0, 1, 0),
    Z: axisQ(rzDeg, 0, 0, 1),
  };
  let q: Quat = [1, 0, 0, 0];
  for (const ch of order.toUpperCase()) q = qmul(q, qmap[ch]);
  return qnorm(q);
}

// ---- app <-> .x bone-delta calibration -------------------------------------
// The app loads .x through assimpjs, which applies a fixed axis basis change from PZ
// .x local space to glTF/three local space: a 180deg rotation about Z. Empirically
// derived and verified (dot 1.0000) across R/L arms, spine and thigh for arbitrary
// axes - see xedit.basis.mts. A bake delta d (.x space, post) shows in the app as
// d_app = P * d * conj(P). The editor lets the author pose a bone directly in app
// space (exact preview) and converts that delta back to an .x delta to bake.
export const ASSIMP_BASIS: Quat = [0, 0, 0, 1]; // 180deg about Z (w,x,y,z)
/** App-space bone delta (local post-multiply the author dialled) -> .x delta to bake. */
export function appDeltaToX(a: Quat): Quat { return qnorm(qmul(qmul(qconj(ASSIMP_BASIS), a), ASSIMP_BASIS)); }
/** .x delta -> the app-space delta it renders as (for previewing an imported/keyframed edit). */
export function xDeltaToApp(d: Quat): Quat { return qnorm(qmul(qmul(ASSIMP_BASIS, d), qconj(ASSIMP_BASIS))); }
/** App-space bone position offset <-> .x translation-key offset. assimpjs flips Z (no scale);
 *  the map is its own inverse. Empirically verified across bones - see xedit.pos.mts. */
export function appPosToX(p: Vec3): Vec3 { return [p[0], p[1], -p[2]]; }

// ---- .x text surgery -------------------------------------------------------

const NUM = '-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const f6 = (v: number) => v.toFixed(6);

// One rotation key "<keyType>;4;w,x,y,z;;" (group 1 = preamble, 2-5 = w,x,y,z, 6 = trailing ;;).
const KEY_RE_SRC = `(\\d+\\s*;\\s*4\\s*;\\s*)(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})(\\s*;;)`;
// One translation/scale key "<keyType>;3;x,y,z;;".
const TKEY_RE_SRC = `(\\d+\\s*;\\s*3\\s*;\\s*)(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})(\\s*;;)`;
// Tick-capturing variants (group 1 = tick).
const R_KEY_FULL_SRC = `(\\d+)\\s*;\\s*4\\s*;\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*;;`;
const T_KEY_FULL_SRC = `(\\d+)\\s*;\\s*3\\s*;\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*;;`;
const TPS_RE = /AnimTicksPerSecond\s*\{\s*(\d+)\s*;/;
const BODY_HEAD_RE = /^(\s*)(\d+)\s*;(\s*)(\d+)\s*;/;
export const DEFAULT_TICKS_PER_SECOND = 4800;

type Span = [number, number];

/** Char span of `AnimationSet <name> { ... }`, or the whole text when animSet is null. */
function findSetSpan(text: string, animSet: string | null): Span {
  if (animSet == null) return [0, text.length];
  const m = new RegExp(`AnimationSet\\s+${escapeRe(animSet)}\\s*\\{`).exec(text);
  if (!m) throw new Error(`AnimationSet '${animSet}' not found`);
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) { // start at the opening brace
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return [m.index, i + 1]; }
  }
  throw new Error(`Unterminated AnimationSet '${animSet}'`);
}

/** [bodyStart, bodyEnd] for every `{ bone } ... AnimationKey <L> { }` in the span (full-text coords). */
function* iterBoneKeyBlocks(text: string, span: Span, bone: string, keyLetter: string): Generator<Span> {
  const [lo, hi] = span;
  const boneRe = new RegExp(`\\{\\s*${escapeRe(bone)}\\s*\\}`, 'g');
  const keyRe = new RegExp(`AnimationKey\\s+${keyLetter}\\s*\\{`, 'g');
  let pos = lo;
  for (;;) {
    boneRe.lastIndex = pos;
    const bm = boneRe.exec(text);
    if (!bm || bm.index >= hi) return;
    keyRe.lastIndex = bm.index + bm[0].length;
    const rm = keyRe.exec(text);
    if (!rm || rm.index >= hi) return;
    const bodyStart = rm.index + rm[0].length;
    const close = text.indexOf('}', bodyStart); // key body has no nested braces
    if (close < 0 || close > hi) return;
    yield [bodyStart, close];
    pos = close + 1;
  }
}

function transformBody(body: string, deltaQ: Quat, mode: 'post' | 'pre'): [string, number] {
  let n = 0;
  const d = qconj(deltaQ);
  // The .x rotation keys are NOT in the runtime frame: the game loads .x through jassimp with
  // MAKE_LEFT_HANDED and assimp conjugates rotation keys on read, reversing composition order. So
  // conj(delta) on the OPPOSITE side reproduces the engine's live bone-override rotation (verified
  // in-game 2026-07-27). See x_edit.py:_transform_body.
  const out = body.replace(new RegExp(KEY_RE_SRC, 'g'), (_m, g1, g2, g3, g4, g5, g6) => {
    n++;
    const q: Quat = [parseFloat(g2), parseFloat(g3), parseFloat(g4), parseFloat(g5)];
    const res = qnorm(mode === 'post' ? qmul(d, q) : qmul(q, d));
    return `${g1}${f6(res[0])},${f6(res[1])},${f6(res[2])},${f6(res[3])}${g6}`;
  });
  return [out, n];
}

export interface EditResult { text: string; keys: number; sets: number; }

/** Rotate every R key of `bone` by a constant delta. mode 'post' = q*d in the bone-local frame. */
export function applyDelta(text: string, bone: string, deltaQ: Quat, animSet: string | null = null, mode: 'post' | 'pre' = 'post'): EditResult {
  const span = findSetSpan(text, animSet);
  const blocks = [...iterBoneKeyBlocks(text, span, bone, 'R')];
  if (!blocks.length) throw new Error(`bone '${bone}' has no AnimationKey R in the target set(s)`);
  let keys = 0;
  for (let i = blocks.length - 1; i >= 0; i--) { // splice last-to-first so earlier offsets stay valid
    const [bs, be] = blocks[i];
    const [nb, n] = transformBody(text.slice(bs, be), deltaQ, mode);
    text = text.slice(0, bs) + nb + text.slice(be);
    keys += n;
  }
  return { text, keys, sets: blocks.length };
}

/** Add dpos to every T key of `bone`. */
export function applyTranslationDelta(text: string, bone: string, dpos: Vec3, animSet: string | null = null): EditResult {
  const span = findSetSpan(text, animSet);
  const blocks = [...iterBoneKeyBlocks(text, span, bone, 'T')];
  if (!blocks.length) throw new Error(`bone '${bone}' has no AnimationKey T in the target set(s)`);
  const [dx, dy, dz] = dpos;
  let n = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const [bs, be] = blocks[i];
    const nb = text.slice(bs, be).replace(new RegExp(TKEY_RE_SRC, 'g'), (_m, g1, g2, g3, g4, g5) => {
      n++;
      return `${g1}${f6(parseFloat(g2) + dx)},${f6(parseFloat(g3) + dy)},${f6(parseFloat(g4) + dz)}${g5}`;
    });
    text = text.slice(0, bs) + nb + text.slice(be);
  }
  return { text, keys: n, sets: blocks.length };
}

/** Rename `AnimationSet old { ... }` -> new (ship an edited clip under a fresh, gated name). */
export function renameSet(text: string, oldName: string, newName: string): { text: string; count: number } {
  const re = new RegExp(`(AnimationSet\\s+)${escapeRe(oldName)}(\\s*\\{)`, 'g');
  let count = 0;
  const out = text.replace(re, (_m, g1, g2) => { count++; return `${g1}${newName}${g2}`; });
  if (count === 0) throw new Error(`AnimationSet '${oldName}' not found to rename`);
  return { text: out, count };
}

export function ticksPerSecond(text: string): number {
  const m = TPS_RE.exec(text);
  return m ? parseInt(m[1], 10) : DEFAULT_TICKS_PER_SECOND;
}

/** Retime a set: scale every key tick (R/S/T, all bones) about the set's first tick by `factor`.
 *  factor > 1 stretches (longer), < 1 compresses (shorter). Keeps AnimTicksPerSecond, so duration scales. */
export function scaleSetTicks(text: string, factor: number, animSet: string | null = null): { text: string; count: number } {
  const [lo, hi] = findSetSpan(text, animSet);
  let seg = text.slice(lo, hi);
  const srcs = [R_KEY_FULL_SRC, T_KEY_FULL_SRC]; // full R (;4;) and T/S (;3;) keys, tick = group 1 - never the keyType/nKeys header lines
  let min = Infinity;
  for (const src of srcs) for (const m of seg.matchAll(new RegExp(src, 'g'))) min = Math.min(min, parseInt(m[1], 10));
  if (!isFinite(min)) return { text, count: 0 };
  let count = 0;
  for (const src of srcs) seg = seg.replace(new RegExp(src, 'g'), (m) => { count++; const t = Math.round(min + (parseInt(m, 10) - min) * factor); return m.replace(/^\d+/, String(t)); });
  return { text: text.slice(0, lo) + seg + text.slice(hi), count };
}
/** Every AnimationKey block (R/S/T, any bone) in a span, as [bodyStart, bodyEnd, ncomp]. */
function* iterKeyBlocks(text: string, span: Span): Generator<[number, number, number]> {
  const [lo, hi] = span;
  const re = /AnimationKey\s+([RST])\s*\{/g; re.lastIndex = lo;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m.index < hi) {
    const bodyStart = m.index + m[0].length, close = text.indexOf('}', bodyStart);
    if (close < 0 || close > hi) return;
    yield [bodyStart, close, m[1] === 'R' ? 4 : 3];
    re.lastIndex = close + 1;
  }
}
/** Trim (or hold-extend) a set to end at `endTick`: drop keys past it, and hold the last pose to endTick. */
export function trimSetEnd(text: string, endTick: number, animSet: string | null = null): { text: string; count: number } {
  const span = findSetSpan(text, animSet);
  const blocks = [...iterKeyBlocks(text, span)];
  let count = 0;
  for (let i = blocks.length - 1; i >= 0; i--) { // splice last-to-first so earlier offsets stay valid
    const [bs, be, ncomp] = blocks[i], src = ncomp === 4 ? R_KEY_FULL_SRC : T_KEY_FULL_SRC;
    const body = text.slice(bs, be), keys = parseBodyKeys(body, src);
    if (!keys.length) continue;
    let kept = keys.filter((k) => k[0] <= endTick); if (!kept.length) kept = [keys[0]];
    const last = kept[kept.length - 1];
    if (last[0] < endTick) kept = [...kept, [endTick, last[1]]]; // hold the last pose out to the new end
    text = text.slice(0, bs) + rebuildKeyBody(body, src, kept, ncomp) + text.slice(be);
    count++;
  }
  return { text, count };
}
/** Every distinct key tick present in the set = the clip's own frames (for a dopesheet grid / snapping). */
export function clipFrameTicks(text: string, animSet: string | null = null): number[] {
  const [lo, hi] = findSetSpan(text, animSet);
  const seg = text.slice(lo, hi);
  const s = new Set<number>();
  for (const m of seg.matchAll(new RegExp(R_KEY_FULL_SRC, 'g'))) s.add(parseInt(m[1], 10));
  for (const m of seg.matchAll(new RegExp(T_KEY_FULL_SRC, 'g'))) s.add(parseInt(m[1], 10));
  return [...s].sort((a, b) => a - b);
}
/** (first, last) key tick across the set = the clip's duration in ticks. */
export function clipTickSpan(text: string, animSet: string | null = null): [number, number] {
  const [lo, hi] = findSetSpan(text, animSet);
  const seg = text.slice(lo, hi);
  const ticks: number[] = [];
  for (const m of seg.matchAll(new RegExp(R_KEY_FULL_SRC, 'g'))) ticks.push(parseInt(m[1], 10));
  for (const m of seg.matchAll(new RegExp(T_KEY_FULL_SRC, 'g'))) ticks.push(parseInt(m[1], 10));
  if (!ticks.length) return [0, 0];
  return [Math.min(...ticks), Math.max(...ticks)];
}

// ---- time-varying (keyframed) deltas ---------------------------------------

type TickKey = [number, number[]]; // [tick, values]

function parseBodyKeys(body: string, fullReSrc: string): TickKey[] {
  const keys: TickKey[] = [];
  for (const m of body.matchAll(new RegExp(fullReSrc, 'g'))) keys.push([parseInt(m[1], 10), m.slice(2).map((g) => parseFloat(g as string))]);
  keys.sort((a, b) => a[0] - b[0]);
  return keys;
}

/** Rewrite an AnimationKey body with a new key list, preserving indent/CRLF/keyType and the nKeys count. */
function rebuildKeyBody(body: string, fullReSrc: string, keys: TickKey[], ncomp: number): string {
  const head = BODY_HEAD_RE.exec(body);
  if (!head) throw new Error('unrecognised AnimationKey body preamble');
  const headEnd = head[0].length;
  const re = new RegExp(fullReSrc, 'g'); re.lastIndex = headEnd;
  const matches: RegExpExecArray[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(body))) matches.push(mm);
  if (!matches.length) throw new Error('AnimationKey body has no keys');
  const lead = body.slice(headEnd, matches[0].index);           // newline+indent before each key line
  const last = matches[matches.length - 1];
  const tail = body.slice(last.index + last[0].length + 1);      // +1 skips the last key's separator
  const out: string[] = [head[1], head[2], ';', head[3], String(keys.length), ';'];
  for (let i = 0; i < keys.length; i++) {
    const [tick, vals] = keys[i];
    out.push(lead, String(Math.trunc(tick)), `;${ncomp};${vals.map(f6).join(',')};;`, i < keys.length - 1 ? ',' : ';');
  }
  out.push(tail);
  return out.join('');
}

/** The clip's own value at `tick`, interpolated between neighbours and held flat outside the range. */
function sampleKeys(keys: TickKey[], tick: number, interp: (a: number[], b: number[], f: number) => number[]): number[] {
  if (tick <= keys[0][0]) return keys[0][1];
  if (tick >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [ta, va] = keys[i];
    const [tb, vb] = keys[i + 1];
    if (ta <= tick && tick <= tb) return interp(va, vb, tb > ta ? (tick - ta) / (tb - ta) : 0.0);
  }
  return keys[keys.length - 1][1];
}

const lerp3 = (a: number[], b: number[], f: number): number[] => a.map((x, i) => x + (b[i] - x) * f);
const slerpVals = (a: number[], b: number[], f: number): number[] => qslerp(a as Quat, b as Quat, f);

function timelineBlock(body: string, fullReSrc: string, ncomp: number, insertTicks: number[], baseInterp: (a: number[], b: number[], f: number) => number[], combine: (tick: number, base: number[]) => number[]): [string, number, number] {
  const keys = parseBodyKeys(body, fullReSrc);
  if (!keys.length) return [body, 0, 0];
  const lo = keys[0][0], hi = keys[keys.length - 1][0];
  const have = new Set(keys.map((k) => k[0]));
  const extra = [...new Set(insertTicks.map((t) => Math.round(t)).filter((t) => lo < t && t < hi && !have.has(t)))].sort((a, b) => a - b);
  const merged = [...new Set([...have, ...extra])].sort((a, b) => a - b);
  const out: TickKey[] = merged.map((tick) => [tick, combine(tick, sampleKeys(keys, tick, baseInterp))]);
  return [rebuildKeyBody(body, fullReSrc, out, ncomp), out.length, extra.length];
}

export interface TimelineResult { text: string; keys: number; sets: number; inserted: number; }

/** Rotate `bone`'s R keys by a delta that varies over the clip. sampleDelta(tick) -> author-local quat. */
export function applyRotTimeline(text: string, bone: string, sampleDelta: (tick: number) => Quat, insertTicks: number[] = [], animSet: string | null = null, mode: 'post' | 'pre' = 'post'): TimelineResult {
  const span = findSetSpan(text, animSet);
  const blocks = [...iterBoneKeyBlocks(text, span, bone, 'R')];
  if (!blocks.length) throw new Error(`bone '${bone}' has no AnimationKey R in the target set(s)`);
  const combine = (tick: number, base: number[]): number[] => {
    const d = qconj(sampleDelta(tick));
    return qnorm(mode === 'post' ? qmul(d, base as Quat) : qmul(base as Quat, d));
  };
  let keys = 0, inserted = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const [bs, be] = blocks[i];
    const [nb, n, ins] = timelineBlock(text.slice(bs, be), R_KEY_FULL_SRC, 4, insertTicks, slerpVals, combine);
    text = text.slice(0, bs) + nb + text.slice(be);
    keys += n; inserted += ins;
  }
  return { text, keys, sets: blocks.length, inserted };
}

/** Add a time-varying translation delta to `bone`'s T keys. sampleDelta(tick) -> (dx,dy,dz). */
export function applyPosTimeline(text: string, bone: string, sampleDelta: (tick: number) => Vec3, insertTicks: number[] = [], animSet: string | null = null): TimelineResult {
  const span = findSetSpan(text, animSet);
  const blocks = [...iterBoneKeyBlocks(text, span, bone, 'T')];
  if (!blocks.length) throw new Error(`bone '${bone}' has no AnimationKey T in the target set(s)`);
  const combine = (tick: number, base: number[]): number[] => { const d = sampleDelta(tick); return base.map((b, i) => b + d[i]); };
  let keys = 0, inserted = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const [bs, be] = blocks[i];
    const [nb, n, ins] = timelineBlock(text.slice(bs, be), T_KEY_FULL_SRC, 3, insertTicks, lerp3, combine);
    text = text.slice(0, bs) + nb + text.slice(be);
    keys += n; inserted += ins;
  }
  return { text, keys, sets: blocks.length, inserted };
}

// Exposed for tests (mirrors x_edit.py's _iter_bone_key_blocks / _parse_body_keys).
export const _internal = { iterBoneKeyBlocks, parseBodyKeys, R_KEY_FULL_SRC, T_KEY_FULL_SRC, BODY_HEAD_RE };
