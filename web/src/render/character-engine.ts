// Imperative character engine: renderer + scene + rigs, plus dress/arm/animate. Faithful
// browser port of src/characterApp/character.js's equip logic, driven by the async
// resolve* fns (which return glb/png BYTES) and the Canvas body compositor. The React
// viewer creates one of these and calls its methods; all Three.js lives here.
import { resolveBody, resolveClip, resolveClothing, resolveHeldItem, resolveHairStyle } from '@shared/character-core.js';
import { THREE, makeSkinnedMaterial, makeMaterial, CHAR_LIGHTING, partMatrix, makeOrbit } from './three-core';
import { glbToGltf, bytesToTexture, sourceToTexture } from './loaders';
import { normaliseClip, boneRestMap, normalizeClothingRig } from './anim';
import { composeBody } from './canvas-image-ops';
import { RigSet } from './rigset';

export interface Ctx { resolver: unknown; converter: unknown; }
type Clip = { id: string; name: string; format: string; rel: string };

interface Equip { kind: string; maskTextures: Uint8Array[]; baseTextures: Uint8Array[]; tint: number[] | null; hatCategory: string | null; }

export class CharacterEngine {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  orbit: ReturnType<typeof makeOrbit>;
  rigs = new RigSet(this.scene);
  clock = new THREE.Clock();
  ctx: Ctx;
  gender: 'male' | 'female' = 'male';
  playing = true;
  speed = 1;

  private raf = 0;
  private disposed = false;
  private bodyRest = new Map<string, THREE.Quaternion>();
  private currentBody: { skinTexture: Uint8Array } | null = null;
  private equipped = new Map<string, Equip>();
  private statics = new Map<string, THREE.Object3D>();
  private held = new Map<string, { holder: THREE.Object3D }>();
  private whiteTex: THREE.Texture | null = null;
  onClipName?: (s: string) => void;

  constructor(canvas: HTMLCanvasElement, ctx: Ctx) {
    this.ctx = ctx;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x14141a, 1);
    this.scene.add(new THREE.GridHelper(4, 16, 0x2b2b34, 0x24242c));
    this.orbit = makeOrbit(() => this.camera, canvas);
    this.fit();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = this.clock.getDelta();
      if (this.rigs.clip && this.playing) this.rigs.update(dt * this.speed);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  fit() {
    const canvas = this.renderer.domElement;
    const wrap = canvas.parentElement!;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.orbit.apply();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.orbit.dispose();
    this.renderer.dispose();
  }

  private white() {
    if (!this.whiteTex) {
      this.whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
      this.whiteTex.needsUpdate = true;
    }
    return this.whiteTex;
  }

  private async loadSkinnedRoot(glb: Uint8Array, tex: THREE.Texture, tint: number[] | null, normalize: boolean) {
    const gltf = await glbToGltf(glb);
    const root = gltf.scene;
    if (normalize) normalizeClothingRig(root);
    const mat = makeSkinnedMaterial(tex, CHAR_LIGHTING);
    if (tint) mat.uniforms.tint.value.set(tint[0], tint[1], tint[2]);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; }
    });
    return root;
  }

  async loadBody(gender: 'male' | 'female' = this.gender) {
    this.gender = gender;
    const body = await resolveBody(this.ctx, { gender });
    this.currentBody = { skinTexture: body.skinTexture };
    const tex = await bytesToTexture(body.skinTexture, false);
    const root = await this.loadSkinnedRoot(body.meshGlb, tex, null, false);
    this.bodyRest = boneRestMap(root);
    const hadBody = !!this.rigs.bodyRig();
    this.rigs.removeKind('body');
    this.rigs.add('body', root);
    root.updateMatrixWorld(true);
    if (!hadBody) {
      const box = new THREE.Box3().setFromObject(root);
      const c = box.getCenter(new THREE.Vector3());
      const s = box.getSize(new THREE.Vector3());
      this.orbit.setTarget(new THREE.Vector3(0, c.y, 0));
      this.orbit.state.radius = Math.max(s.y, 1) * 1.9;
      this.orbit.apply();
    }
    await this.recompositeBody();
  }

  async playClip(clip: Clip) {
    const r = await resolveClip(this.ctx, clip);
    if (r.error) throw new Error(r.error);
    const gltf = await glbToGltf(r.glb);
    if (!gltf.animations?.length) throw new Error('no animation in ' + clip.name);
    const norm = normaliseClip(gltf.animations[0], clip.format, { clipRest: boneRestMap(gltf.scene), bodyRest: this.bodyRest });
    this.rigs.setLoop(true);
    this.rigs.setClip(norm);
    this.playing = true;
    const tag = norm.best ? '' : (clip.format === 'fbx' ? ' (fbx, best-effort)' : ` (${clip.format}, retargeted)`);
    this.onClipName?.(clip.name + tag);
  }

  togglePlay() { this.playing = !this.playing; return this.playing; }

  private setBodyTexture(tex: THREE.Texture) {
    const body = this.rigs.bodyRig();
    body?.root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh & { material: THREE.ShaderMaterial };
      if (sm.isSkinnedMesh && sm.material?.uniforms?.map) sm.material.uniforms.map.value = tex;
    });
  }

  private async recompositeBody() {
    if (!this.currentBody) return;
    const layers: { bytes: Uint8Array; tint: number[] | null }[] = [];
    const masks: Uint8Array[] = [];
    for (const e of this.equipped.values()) {
      for (const b of e.baseTextures) layers.push({ bytes: b, tint: e.tint });
      for (const m of e.maskTextures) masks.push(m);
    }
    const canvas = await composeBody(this.currentBody.skinTexture, layers, masks);
    this.setBodyTexture(sourceToTexture(canvas, false));
  }

  isEquipped(name: string) { return this.equipped.has(name); }
  equippedNames() { return [...this.equipped.keys()]; }

  async toggleClothing(item: { name: string }) {
    if (this.equipped.has(item.name)) { await this.unequipClothing(item.name); return false; }
    const r = await resolveClothing(this.ctx, item, this.gender);
    if (r.error) throw new Error(r.error);
    const entry: Equip = { kind: r.kind, maskTextures: r.maskTextures || [], baseTextures: r.baseTextures || [], tint: null, hatCategory: r.hatCategory || null };
    if (r.kind === 'mesh') {
      const tex = r.texture ? await bytesToTexture(r.texture, false) : this.white();
      const root = await this.loadSkinnedRoot(r.meshGlb, tex, null, true);
      this.rigs.add('cloth:' + item.name, root);
    } else if (r.kind === 'static') {
      await this.attachStatic(item.name, r);
    }
    this.equipped.set(item.name, entry);
    await this.recompositeBody();
    return true;
  }

  async unequipClothing(name: string) {
    const e = this.equipped.get(name);
    if (!e) return;
    if (e.kind === 'mesh') this.rigs.removeKind('cloth:' + name);
    else if (e.kind === 'static') this.detachStatic(name);
    this.equipped.delete(name);
    await this.recompositeBody();
  }

  private async attachStatic(name: string, r: { meshGlb: Uint8Array; texture: Uint8Array | null; attachBone?: string | null }) {
    const body = this.rigs.bodyRig();
    if (!body) return;
    let skeleton: THREE.Skeleton | null = null;
    body.root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && !skeleton) skeleton = sm.skeleton; });
    if (!skeleton) throw new Error('no body skeleton to attach to');
    const bone = (skeleton as THREE.Skeleton).bones.find((b) => b.name === (r.attachBone || 'Bip01_Head'));
    if (!bone) throw new Error(`attach bone not found: ${r.attachBone}`);
    const gltf = await glbToGltf(r.meshGlb);
    const obj = gltf.scene;
    const tex = r.texture ? await bytesToTexture(r.texture, false) : this.white();
    const mat = makeMaterial(tex, CHAR_LIGHTING, true);
    obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
    bone.add(obj);
    this.statics.set(name, obj);
  }

  private detachStatic(name: string) {
    const obj = this.statics.get(name);
    if (obj?.parent) obj.parent.remove(obj);
    this.statics.delete(name);
  }

  isHeld(name: string) { return this.held.has(name); }

  async toggleHeld(item: { name: string }, prop = 'Bip01_Prop1') {
    if (this.held.has(item.name)) { this.unequipHeld(item.name); return false; }
    const body = this.rigs.bodyRig();
    if (!body) return false;
    const r = await resolveHeldItem(this.ctx, item);
    if (r.error) throw new Error(r.error);
    const bone = body.root.getObjectByName(prop);
    if (!bone) throw new Error(`hand bone not found: ${prop}`);
    const att = (r.attachments && r.attachments[prop]) || null;
    const gltf = await glbToGltf(r.meshGlb);
    const obj = gltf.scene;
    const tex = r.texture ? await bytesToTexture(r.texture, true) : this.white();
    const mat = makeMaterial(tex, CHAR_LIGHTING, true);
    obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
    if (r.scale && r.scale !== 1) obj.scale.setScalar(r.scale);
    const holder = new THREE.Object3D();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(partMatrix(null, att));
    holder.add(obj);
    bone.add(holder);
    this.held.set(item.name, { holder });
    return true;
  }

  unequipHeld(name: string) {
    const h = this.held.get(name);
    if (h?.holder.parent) h.holder.parent.remove(h.holder);
    this.held.delete(name);
  }

  /** kind = 'hair' | 'beard'. style=null or {name:'None'} removes the part. */
  async applyPart(kind: 'hair' | 'beard', style: { name: string } | null, color: number[] | null) {
    this.rigs.removeKind(kind);
    if (!style || style.name === 'None') return;
    const r = await resolveHairStyle(this.ctx, style);
    if (!r.hasMesh) return;
    const tex = await bytesToTexture(r.texture, false);
    const root = await this.loadSkinnedRoot(r.meshGlb, tex, color, true);
    this.rigs.add(kind, root);
  }
}
