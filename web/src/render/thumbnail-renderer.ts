// Offscreen thumbnail renderer: one shared WebGL context. The reference body is posed by
// the IDLE clip (same as the live rig), not the raw bind pose — otherwise bone-attached
// static items (hats/helmets) and skinned garments seat wrong, because a mod authors them
// against the posed head, and bind vs idle differ. Idle also reads better (arms down) than
// a T-pose. Two modes per clothing item: on-body, or the garment mesh alone. Held items
// render at an iso icon angle. Renders serialize (one context); results are cached by the
// provider, so this is a cold-path cost.
import { resolveBody, resolveClothing, resolveHeldItem, resolveClip } from '@shared/character-core.js';
import { THREE, makeSkinnedMaterial, makeMaterial, CHAR_LIGHTING } from './three-core';
import { glbToGltf, bytesToTexture, sourceToTexture } from './loaders';
import { normaliseClip, normalizeClothingRig } from './anim';
import { RigSet } from './rigset';
import { composeBody } from './canvas-image-ops';

export interface Ctx { resolver: unknown; converter: unknown; }
export interface IdleClip { rel: string; format: string; name?: string }
const SIZE = 512;

export class ThumbnailRenderer {
  private ctx: Ctx;
  private idleClip?: IdleClip;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  private target = new THREE.WebGLRenderTarget(SIZE, SIZE);
  private buf = new Uint8Array(SIZE * SIZE * 4);
  private canvas = document.createElement('canvas');
  private c2d: CanvasRenderingContext2D;
  private queue: Promise<unknown> = Promise.resolve();
  private rigs = new RigSet(this.scene);

  private bodyGender: 'male' | 'female' | null = null;
  private bodyRoot: THREE.Object3D | null = null;
  private bodyBox: THREE.Box3 | null = null;
  private bodySkeleton: THREE.Skeleton | null = null;
  private skinBytes: Uint8Array | null = null;
  private skinTex: THREE.Texture | null = null;
  private idleNorm: ReturnType<typeof normaliseClip> | null = null;

  constructor(ctx: Ctx, idleClip?: IdleClip) {
    this.ctx = ctx; this.idleClip = idleClip;
    const gl = document.createElement('canvas');
    gl.width = SIZE; gl.height = SIZE;
    this.renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.canvas.width = SIZE; this.canvas.height = SIZE;
    this.c2d = this.canvas.getContext('2d')!;
  }

  dispose() { this.renderer.dispose(); this.target.dispose(); }

  private material(tex: THREE.Texture, skinned: boolean) {
    return skinned ? makeSkinnedMaterial(tex, CHAR_LIGHTING) : makeMaterial(tex, CHAR_LIGHTING, true);
  }
  private applyMat(root: THREE.Object3D, mat: THREE.Material) {
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
  }
  private disposeTree(root: THREE.Object3D) { root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); }
  private setBodyTexture(tex: THREE.Texture) {
    this.bodyRoot?.traverse((o) => { const sm = o as THREE.SkinnedMesh & { material: THREE.ShaderMaterial }; if (sm.isSkinnedMesh && sm.material?.uniforms?.map) sm.material.uniforms.map.value = tex; });
  }

  private async ensureIdle() {
    if (this.idleNorm || !this.idleClip) return;
    try {
      const r = await resolveClip(this.ctx, this.idleClip);
      if (r.error || !r.glb) return;
      const gltf = await glbToGltf(r.glb);
      if (gltf.animations?.length) this.idleNorm = normaliseClip(gltf.animations[0], this.idleClip.format, {});
    } catch { /* no idle -> bind pose fallback */ }
  }
  private idleT() { const d = this.idleNorm ? (this.idleNorm.clip.duration || 1) : 1; return d * 0.35; }
  private poseIdle() { if (this.idleNorm) { this.rigs.setTime(this.idleT()); this.bodyRoot?.updateMatrixWorld(true); } }

  private async ensureBody(gender: 'male' | 'female') {
    if (this.bodyGender === gender && this.bodyRoot) return;
    this.rigs.removeKind('thumb'); this.rigs.removeKind('body');
    if (this.bodyRoot) this.disposeTree(this.bodyRoot);
    const body = await resolveBody(this.ctx, { gender });
    this.skinBytes = body.skinTexture;
    this.skinTex = await bytesToTexture(body.skinTexture, false);
    const root = (await glbToGltf(body.meshGlb)).scene;
    this.applyMat(root, this.material(this.skinTex, true));
    this.bodyRoot = root; this.bodyGender = gender;
    this.bodySkeleton = null;
    root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && !this.bodySkeleton) this.bodySkeleton = sm.skeleton; });
    // geometry-local bounds (true Y-up body); Box3.setFromObject would be rotated by the
    // skeleton root's Rx+90
    this.bodyBox = new THREE.Box3();
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); this.bodyBox!.union(m.geometry.boundingBox!); } });
    // add + pose with idle
    await this.ensureIdle();
    this.rigs.add('body', root);
    if (this.idleNorm) { this.rigs.setClip(this.idleNorm); this.rigs.setTime(this.idleT()); }
    root.updateMatrixWorld(true);
  }

  /** Aim the shared ortho camera: whole body fits the square vertically (head near top,
   *  feet near bottom); hats/shoes zoom to a region since those items are tiny. */
  private frameGroup(group?: string) {
    const box = this.bodyBox!;
    const bot = box.min.y, H = box.max.y - box.min.y || 1, mid = box.min.y + H / 2;
    let cy = mid, half = 0.52 * H;
    switch (group) {
      case 'head': cy = bot + 0.88 * H; half = 0.15 * H; break;
      case 'feet': cy = bot + 0.07 * H; half = 0.13 * H; break;
      default: cy = mid; half = 0.52 * H; break;
    }
    this.camera.left = -half; this.camera.right = half; this.camera.top = half; this.camera.bottom = -half;
    this.camera.position.set(0, cy, 6); this.camera.lookAt(0, cy, 0); this.camera.updateProjectionMatrix();
  }

  private renderToTarget(scene: THREE.Scene, camera: THREE.Camera) {
    const r = this.renderer; r.setRenderTarget(this.target); r.clear(); r.render(scene, camera); r.setRenderTarget(null);
  }
  private toBlob(): Promise<Blob> {
    this.renderer.readRenderTargetPixels(this.target, 0, 0, SIZE, SIZE, this.buf);
    const img = this.c2d.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) { const sy = SIZE - 1 - y; for (let x = 0; x < SIZE; x++) { const di = (y * SIZE + x) * 4, si = (sy * SIZE + x) * 4; img.data[di] = this.buf[si]; img.data[di + 1] = this.buf[si + 1]; img.data[di + 2] = this.buf[si + 2]; img.data[di + 3] = this.buf[si + 3]; } }
    this.c2d.putImageData(img, 0, 0);
    return new Promise((res) => this.canvas.toBlob((b) => res(b!), 'image/png'));
  }

  private async renderAlone(root: THREE.Object3D, iso: boolean): Promise<Blob> {
    const group = new THREE.Group(); group.add(root); group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    group.position.sub(c);
    const half = (Math.max(s.x, s.y, iso ? s.z : 0) / 2) * 1.18 || 0.2;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.001, 100);
    if (iso) cam.position.set(half, half, half * 2); else cam.position.set(0, 0, 10);
    cam.lookAt(0, 0, 0);
    const scene = new THREE.Scene(); scene.add(group);
    this.renderToTarget(scene, cam);
    const blob = await this.toBlob();
    this.disposeTree(root);
    return blob;
  }

  clothingThumb(item: { name: string; kind: string; facet?: string }, gender: 'male' | 'female', onBody: boolean): Promise<Blob> {
    const run = async (): Promise<Blob> => {
      const r = await resolveClothing(this.ctx, item, gender);

      if (!onBody && r.meshGlb && (r.kind === 'mesh' || r.kind === 'static')) {
        const root = (await glbToGltf(r.meshGlb)).scene;
        if (r.kind === 'mesh') normalizeClothingRig(root);
        const tex = r.texture ? await bytesToTexture(r.texture, false) : this.skinTex ?? new THREE.Texture();
        this.applyMat(root, this.material(tex, r.kind === 'mesh'));
        return this.renderAlone(root, false);
      }

      await this.ensureBody(gender);
      this.setBodyTexture(this.skinTex!);
      let garment: THREE.Object3D | null = null;
      let garmentKind = r.kind;
      const layers: { bytes: Uint8Array; tint: number[] | null }[] = [];
      const masks: Uint8Array[] = r.maskTextures || [];
      if (r.kind === 'composite') for (const b of (r.baseTextures || [])) layers.push({ bytes: b, tint: null });

      if (r.kind === 'mesh' && r.meshGlb) {
        garment = (await glbToGltf(r.meshGlb)).scene;
        normalizeClothingRig(garment);
        this.applyMat(garment, this.material(r.texture ? await bytesToTexture(r.texture, false) : this.skinTex!, true));
        this.rigs.add('thumb', garment); // bound to idle, poses with the body
      } else if (r.kind === 'static' && r.meshGlb) {
        garment = (await glbToGltf(r.meshGlb)).scene;
        this.applyMat(garment, this.material(r.texture ? await bytesToTexture(r.texture, false) : this.skinTex!, false));
        const bone = this.bodySkeleton?.bones.find((b) => b.name === (r.attachBone || 'Bip01_Head'));
        if (bone) bone.add(garment); else this.scene.add(garment); // follows the idle-posed bone
      }
      this.poseIdle(); // re-pose so the freshly-added rig/bone reflects the idle frame
      if (layers.length || masks.length) {
        const cv = await composeBody(this.skinBytes!, layers, masks);
        this.setBodyTexture(sourceToTexture(cv, false));
      }
      this.frameGroup(item.facet);
      this.renderToTarget(this.scene, this.camera);
      const blob = await this.toBlob();
      if (garmentKind === 'mesh') this.rigs.removeKind('thumb');
      else if (garment) garment.parent?.remove(garment);
      if (garment) this.disposeTree(garment);
      this.setBodyTexture(this.skinTex!);
      return blob;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p as Promise<Blob>;
  }

  heldThumb(item: { name: string }): Promise<Blob> {
    const run = async (): Promise<Blob> => {
      const r = await resolveHeldItem(this.ctx, item);
      if (r.error || !r.meshGlb) throw new Error(r.error || 'no mesh');
      const root = (await glbToGltf(r.meshGlb)).scene;
      const tex = r.texture ? await bytesToTexture(r.texture, true) : new THREE.Texture();
      this.applyMat(root, this.material(tex, false));
      return this.renderAlone(root, true);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p as Promise<Blob>;
  }
}
