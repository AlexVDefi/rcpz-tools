// Live animation preview for the clip grid: one dedicated WebGL canvas (fixed-position,
// pointer-events:none) that, on hover, is positioned over the hovered cell and plays the
// clip on a reference body. Only one cell is hovered at a time, so a single instance
// suffices. A token guards against races when the user sweeps across cells quickly.
import { resolveBody, resolveClip } from '@shared/character-core.js';
import { THREE, makeSkinnedMaterial, CHAR_LIGHTING } from './three-core';
import { glbToGltf, bytesToTexture } from './loaders';
import { normaliseClip, boneRestMap, captureSkeletonBind, type SkeletonBind } from './anim';
import { RigSet } from './rigset';

export interface Ctx { resolver: unknown; converter: unknown; }
type Clip = { id: string; rel: string; format: string };
type EditKey = { tick: number; rot: number[]; pos: number[] };
export type PreviewEdit = { bones: Record<string, EditKey[]>; lo: number; hi: number }; // per-bone app-space deltas over the clip tick span [lo, hi]
const SIZE = 224;

function sampleKeys(keys: EditKey[], tick: number): { rot: THREE.Quaternion; pos: THREE.Vector3 } {
  const q = (k: EditKey) => new THREE.Quaternion(k.rot[0], k.rot[1], k.rot[2], k.rot[3]);
  const v = (k: EditKey) => new THREE.Vector3(k.pos[0], k.pos[1], k.pos[2]);
  if (keys.length === 1 || tick <= keys[0].tick) return { rot: q(keys[0]), pos: v(keys[0]) };
  const last = keys[keys.length - 1]; if (tick >= last.tick) return { rot: q(last), pos: v(last) };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (a.tick <= tick && tick <= b.tick) { const f = b.tick > a.tick ? (tick - a.tick) / (b.tick - a.tick) : 0; return { rot: q(a).slerp(q(b), f), pos: v(a).lerp(v(b), f) }; }
  }
  return { rot: q(last), pos: v(last) };
}

export class ClipPreview {
  readonly canvas = document.createElement('canvas');
  private ctx: Ctx;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  private rigs = new RigSet(this.scene);
  private clock = new THREE.Clock();
  private bodyRest = new Map<string, THREE.Quaternion>();
  private bodySkel: SkeletonBind | null = null;
  private ready = false;
  private playing = false;
  private raf = 0;
  private token = 0;
  private bonesByName = new Map<string, THREE.Bone>();
  private edit: PreviewEdit | null = null;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.canvas.width = SIZE; this.canvas.height = SIZE;
    this.canvas.style.cssText = 'position:fixed;display:none;z-index:60;pointer-events:none;border-radius:8px;';
    document.body.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x101014, 1);
  }

  private async ensureBody() {
    if (this.ready) return;
    const body = await resolveBody(this.ctx, { gender: 'male' });
    const tex = await bytesToTexture(body.skinTexture, false);
    const root = (await glbToGltf(body.meshGlb)).scene;
    const mat = makeSkinnedMaterial(tex, CHAR_LIGHTING);
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
    this.bodyRest = boneRestMap(root);
    this.bodySkel = captureSkeletonBind(root);
    root.traverse((o) => { const b = o as THREE.Bone; if (b.isBone && b.name) this.bonesByName.set(b.name, b); }); // for applying pose-edit deltas
    this.rigs.add('body', root);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!); } });
    const H = box.max.y - box.min.y || 1, mid = box.min.y + H / 2, half = 0.52 * H;
    this.camera.left = -half; this.camera.right = half; this.camera.top = half; this.camera.bottom = -half;
    this.camera.position.set(0, mid, 6); this.camera.lookAt(0, mid, 0); this.camera.updateProjectionMatrix();
    this.ready = true;
  }

  private loop = () => {
    if (!this.playing) return;
    this.raf = requestAnimationFrame(this.loop);
    this.rigs.update(this.clock.getDelta());
    this.applyEdit();
    this.renderer.render(this.scene, this.camera);
  };

  /** After the mixer poses the clean clip, ride each edited bone's delta on top (base . delta), mapping playback time onto the edit's tick span. */
  private applyEdit() {
    const e = this.edit; if (!e) return;
    const dur = this.rigs.duration(), frac = dur > 1e-6 ? Math.max(0, Math.min(1, this.rigs.time() / dur)) : 0;
    const tick = e.lo + frac * (e.hi - e.lo);
    for (const [name, keys] of Object.entries(e.bones)) {
      const bone = this.bonesByName.get(name); if (!bone || !keys.length) continue;
      const d = sampleKeys(keys, tick);
      bone.quaternion.multiply(d.rot); // clean clip pose is the base; compose the app-space delta
      bone.position.add(d.pos);
    }
  }

  /** Position the preview over a cell and start playing the clip. Pass `edit` to play the saved pose on top. */
  async play(clip: Clip, rect: { left: number; top: number; width: number; height: number }, edit?: PreviewEdit | null) {
    const tok = ++this.token;
    this.edit = edit ?? null;
    const s = this.canvas.style;
    s.left = `${rect.left}px`; s.top = `${rect.top}px`; s.width = `${rect.width}px`; s.height = `${rect.height}px`; s.display = 'block';
    try {
      await this.ensureBody();
      if (tok !== this.token) return;
      const r = await resolveClip(this.ctx, clip);
      if (tok !== this.token || r.error || !r.glb) return;
      const gltf = await glbToGltf(r.glb);
      if (tok !== this.token || !gltf.animations?.length) return;
      const norm = normaliseClip(gltf.animations[0], clip.format, { clipScene: gltf.scene, bodySkel: this.bodySkel ?? undefined, clipRest: boneRestMap(gltf.scene), bodyRest: this.bodyRest });
      this.rigs.setLoop(true);
      this.rigs.setClip(norm);
      this.playing = true;
      this.clock.getDelta(); // reset dt
      this.loop();
    } catch { /* ignore */ }
  }

  stop() {
    this.token++;
    this.playing = false;
    this.edit = null;
    cancelAnimationFrame(this.raf);
    this.canvas.style.display = 'none';
  }

  dispose() { this.stop(); this.renderer.dispose(); this.canvas.remove(); }
}
