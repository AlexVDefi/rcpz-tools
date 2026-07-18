// Live animation preview for the clip grid: one dedicated WebGL canvas (fixed-position,
// pointer-events:none) that, on hover, is positioned over the hovered cell and plays the
// clip on a reference body. Only one cell is hovered at a time, so a single instance
// suffices. A token guards against races when the user sweeps across cells quickly.
import { resolveBody, resolveClip } from '@shared/character-core.js';
import { THREE, makeSkinnedMaterial, CHAR_LIGHTING } from './three-core';
import { glbToGltf, bytesToTexture } from './loaders';
import { normaliseClip, boneRestMap } from './anim';
import { RigSet } from './rigset';

export interface Ctx { resolver: unknown; converter: unknown; }
type Clip = { id: string; rel: string; format: string };
const SIZE = 224;

export class ClipPreview {
  readonly canvas = document.createElement('canvas');
  private ctx: Ctx;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  private rigs = new RigSet(this.scene);
  private clock = new THREE.Clock();
  private bodyRest = new Map<string, THREE.Quaternion>();
  private ready = false;
  private playing = false;
  private raf = 0;
  private token = 0;

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
    this.renderer.render(this.scene, this.camera);
  };

  /** Position the preview over a cell and start playing the clip. */
  async play(clip: Clip, rect: { left: number; top: number; width: number; height: number }) {
    const tok = ++this.token;
    const s = this.canvas.style;
    s.left = `${rect.left}px`; s.top = `${rect.top}px`; s.width = `${rect.width}px`; s.height = `${rect.height}px`; s.display = 'block';
    try {
      await this.ensureBody();
      if (tok !== this.token) return;
      const r = await resolveClip(this.ctx, clip);
      if (tok !== this.token || r.error || !r.glb) return;
      const gltf = await glbToGltf(r.glb);
      if (tok !== this.token || !gltf.animations?.length) return;
      const norm = normaliseClip(gltf.animations[0], clip.format, { clipRest: boneRestMap(gltf.scene), bodyRest: this.bodyRest });
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
    cancelAnimationFrame(this.raf);
    this.canvas.style.display = 'none';
  }

  dispose() { this.stop(); this.renderer.dispose(); this.canvas.remove(); }
}
