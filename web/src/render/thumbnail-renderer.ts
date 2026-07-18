// Offscreen thumbnail renderer: one shared WebGL context renders a reference body (loaded
// once per gender) wearing a single garment, in bind (T) pose, to a small transparent PNG.
// Bind pose is fine here — body + garment share the skeleton's bind, so they align without
// a clip, and a T-pose reads clearly as a catalog thumbnail. Renders are serialized (one
// GL context) and the results are cached by the provider, so this is a cold-path cost.
import { resolveBody, resolveClothing, resolveHeldItem } from '@shared/character-core.js';
import { THREE, makeSkinnedMaterial, makeMaterial, CHAR_LIGHTING } from './three-core';
import { glbToGltf, bytesToTexture, sourceToTexture } from './loaders';
import { normalizeClothingRig } from './anim';
import { composeBody } from './canvas-image-ops';

export interface Ctx { resolver: unknown; converter: unknown; }
const SIZE = 160;

export class ThumbnailRenderer {
  private ctx: Ctx;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  private target = new THREE.WebGLRenderTarget(SIZE, SIZE);
  private buf = new Uint8Array(SIZE * SIZE * 4);
  private canvas = document.createElement('canvas');
  private c2d: CanvasRenderingContext2D;
  private queue: Promise<unknown> = Promise.resolve();

  private bodyGender: 'male' | 'female' | null = null;
  private bodyRoot: THREE.Object3D | null = null;
  private skinBytes: Uint8Array | null = null;
  private skinTex: THREE.Texture | null = null;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    const gl = document.createElement('canvas');
    gl.width = SIZE; gl.height = SIZE;
    this.renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.canvas.width = SIZE; this.canvas.height = SIZE;
    this.c2d = this.canvas.getContext('2d')!;
  }

  dispose() { this.renderer.dispose(); this.target.dispose(); }

  private setBodyTexture(tex: THREE.Texture) {
    this.bodyRoot?.traverse((o) => {
      const sm = o as THREE.SkinnedMesh & { material: THREE.ShaderMaterial };
      if (sm.isSkinnedMesh && sm.material?.uniforms?.map) sm.material.uniforms.map.value = tex;
    });
  }

  private async ensureBody(gender: 'male' | 'female') {
    if (this.bodyGender === gender && this.bodyRoot) return;
    if (this.bodyRoot) { this.scene.remove(this.bodyRoot); this.bodyRoot = null; }
    const body = await resolveBody(this.ctx, { gender });
    this.skinBytes = body.skinTexture;
    this.skinTex = await bytesToTexture(body.skinTexture, false);
    const gltf = await glbToGltf(body.meshGlb);
    const root = gltf.scene;
    const mat = makeSkinnedMaterial(this.skinTex, CHAR_LIGHTING);
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
    this.scene.add(root);
    root.updateMatrixWorld(true);
    this.bodyRoot = root; this.bodyGender = gender;
    // frame the body's bind (T) pose: symmetric ortho fitting its bbox with a margin
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const half = Math.max(size.x, size.y) / 2 * 1.12;
    this.camera.left = -half; this.camera.right = half; this.camera.top = half; this.camera.bottom = -half;
    this.camera.position.set(0, center.y, 6);
    this.camera.lookAt(0, center.y, 0);
    this.camera.updateProjectionMatrix();
  }

  private renderToBlob(): Promise<Blob> {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.clear();
    r.render(this.scene, this.camera);
    r.readRenderTargetPixels(this.target, 0, 0, SIZE, SIZE, this.buf);
    r.setRenderTarget(null);
    // GL readback is bottom-up; flip into the 2D canvas
    const img = this.c2d.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      const sy = SIZE - 1 - y;
      for (let x = 0; x < SIZE; x++) {
        const di = (y * SIZE + x) * 4, si = (sy * SIZE + x) * 4;
        img.data[di] = this.buf[si]; img.data[di + 1] = this.buf[si + 1]; img.data[di + 2] = this.buf[si + 2]; img.data[di + 3] = this.buf[si + 3];
      }
    }
    this.c2d.putImageData(img, 0, 0);
    return new Promise((res) => this.canvas.toBlob((b) => res(b!), 'image/png'));
  }

  /** Render one clothing item on the reference body. Serialized. */
  clothingThumb(item: { name: string; kind: string }, gender: 'male' | 'female'): Promise<Blob> {
    const run = async (): Promise<Blob> => {
      await this.ensureBody(gender);
      this.setBodyTexture(this.skinTex!);
      const r = await resolveClothing(this.ctx, item, gender);
      let garment: THREE.Object3D | null = null;
      const layers: { bytes: Uint8Array; tint: number[] | null }[] = [];
      const masks: Uint8Array[] = r.maskTextures || [];
      if (r.kind === 'composite') for (const b of (r.baseTextures || [])) layers.push({ bytes: b, tint: null });
      if (r.kind === 'mesh' && r.meshGlb) {
        const gltf = await glbToGltf(r.meshGlb);
        garment = gltf.scene;
        normalizeClothingRig(garment);
        const tex = r.texture ? await bytesToTexture(r.texture, false) : this.skinTex!;
        const mat = makeSkinnedMaterial(tex, CHAR_LIGHTING);
        garment.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
        this.scene.add(garment); garment.updateMatrixWorld(true);
      } else if (r.kind === 'static' && r.meshGlb) {
        const gltf = await glbToGltf(r.meshGlb);
        garment = gltf.scene;
        const tex = r.texture ? await bytesToTexture(r.texture, false) : this.skinTex!;
        const mat = makeMaterial(tex, CHAR_LIGHTING, true);
        garment.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
        // static items are authored in bone-local space; without the skeleton bone we just
        // show it near the head origin — acceptable for a small thumbnail
        this.scene.add(garment); garment.updateMatrixWorld(true);
      }
      if (layers.length || masks.length) {
        const cv = await composeBody(this.skinBytes!, layers, masks);
        this.setBodyTexture(sourceToTexture(cv, false));
      }
      const blob = await this.renderToBlob();
      if (garment) this.scene.remove(garment);
      this.setBodyTexture(this.skinTex!);
      return blob;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p as Promise<Blob>;
  }

  /** Render one held item/weapon at the icon camera (no body). Serialized. */
  heldThumb(item: { name: string }): Promise<Blob> {
    const run = async (): Promise<Blob> => {
      const r = await resolveHeldItem(this.ctx, item);
      if (r.error || !r.meshGlb) throw new Error(r.error || 'no mesh');
      const gltf = await glbToGltf(r.meshGlb);
      const obj = gltf.scene;
      const tex = r.texture ? await bytesToTexture(r.texture, true) : this.skinTex || new THREE.Texture();
      const mat = makeMaterial(tex, CHAR_LIGHTING, true);
      obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
      const group = new THREE.Group();
      group.add(obj);
      // frame the item
      group.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(group);
      const c = box.getCenter(new THREE.Vector3()); const s = box.getSize(new THREE.Vector3());
      group.position.sub(c);
      const half = Math.max(s.x, s.y, s.z) / 2 * 1.2 || 1;
      const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.001, 100);
      cam.position.set(half, half, half * 2); cam.lookAt(0, 0, 0);
      const scene = new THREE.Scene(); scene.add(group);
      const r2 = this.renderer;
      r2.setRenderTarget(this.target); r2.clear(); r2.render(scene, cam);
      r2.readRenderTargetPixels(this.target, 0, 0, SIZE, SIZE, this.buf); r2.setRenderTarget(null);
      const img = this.c2d.createImageData(SIZE, SIZE);
      for (let y = 0; y < SIZE; y++) { const sy = SIZE - 1 - y; for (let x = 0; x < SIZE; x++) { const di = (y * SIZE + x) * 4, si = (sy * SIZE + x) * 4; img.data[di] = this.buf[si]; img.data[di + 1] = this.buf[si + 1]; img.data[di + 2] = this.buf[si + 2]; img.data[di + 3] = this.buf[si + 3]; } }
      this.c2d.putImageData(img, 0, 0);
      const blob: Blob = await new Promise((res) => this.canvas.toBlob((b) => res(b!), 'image/png'));
      obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); } });
      return blob;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p as Promise<Blob>;
  }
}
