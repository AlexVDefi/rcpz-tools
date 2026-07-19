// Imperative character engine: renderer + scene + rigs, plus dress/arm/animate. Faithful
// browser port of src/characterApp/character.js's equip logic, driven by the async
// resolve* fns (which return glb/png BYTES) and the Canvas body compositor. The React
// viewer creates one of these and calls its methods; all Three.js lives here.
import { resolveBody, resolveClip, resolveClothing, resolveHeldItem, resolveHairStyle } from '@shared/character-core.js';
import { THREE, makeSkinnedMaterial, makeMaterial, CHAR_LIGHTING, partMatrix, makeOrbit } from './three-core';
import { glbToGltf, bytesToTexture, sourceToTexture } from './loaders';
import { normaliseClip, boneRestMap, normalizeClothingRig, captureSkeletonBind, type SkeletonBind } from './anim';
import { composeBody } from './canvas-image-ops';
import { RigSet } from './rigset';

export interface Ctx { resolver: unknown; converter: unknown; }
type Clip = { id: string; name: string; format: string; rel: string };

interface Equip { kind: string; maskTextures: Uint8Array[]; baseTextures: Uint8Array[]; tint: number[] | null; hatCategory: string | null; }

type IsoCam = THREE.OrthographicCamera & { __aspect?: number };

export class CharacterEngine {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  perspCam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  isoCam: IsoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  camera: THREE.Camera = this.perspCam;
  camMode: 'orbit' | 'iso' = 'orbit';
  orbit: ReturnType<typeof makeOrbit>;
  rigs = new RigSet(this.scene);
  clock = new THREE.Clock();
  ctx: Ctx;
  gender: 'male' | 'female' = 'male';
  playing = true;
  speed = 1;
  // live-adjustable lighting (matches the desktop app's defaults)
  light = { ambient: CHAR_LIGHTING.ambient[0], keyBright: CHAR_LIGHTING.keyColour[0], keyDir: [...CHAR_LIGHTING.keyDir] as number[] };

  private grid: THREE.GridHelper;
  private shadow: THREE.Mesh | null = null;
  private floorMat: THREE.MeshBasicMaterial | null = null;
  private raf = 0;
  private disposed = false;
  // viewfinder: when exportAspect is set, the live view renders into a centered rect of that
  // aspect (letterboxed), so what you see is exactly what exports. In drawing-buffer pixels.
  private vw = 1; private vh = 1;
  private viewRect: { x: number; y: number; w: number; h: number } | null = null;
  private exportAspect: number | null = null;
  private bodyBounds: { minY: number; maxY: number; cx: number; cz: number } | null = null;
  private turntable = false;
  private spin = 0; // live turntable angle (rad)
  private preset: 'orbit' | 'iso' | 'front' | 'portrait' = 'orbit';
  private paused = false; // while an export drives the frames itself
  onViewfinder?: (rect: { left: number; top: number; width: number; height: number } | null) => void;
  private bodyRest = new Map<string, THREE.Quaternion>();
  private bodySkel: SkeletonBind | null = null;
  private currentBody: { skinTexture: Uint8Array } | null = null;
  private equipped = new Map<string, Equip>();
  private statics = new Map<string, THREE.Object3D>();
  private held = new Map<string, { holder: THREE.Object3D }>();
  private hidden = new Set<string>(); // equipped-but-temporarily-hidden clothing/held names
  private whiteTex: THREE.Texture | null = null;
  onClipName?: (s: string) => void;
  onFrame?: (time: number, duration: number) => void;
  onCamMode?: (mode: 'orbit' | 'iso') => void;

  constructor(canvas: HTMLCanvasElement, ctx: Ctx) {
    this.ctx = ctx;
    // alpha:true + transparent clear so the HTML background layer shows through (studio
    // backdrop / transparent export). autoClear off: we clear the full buffer then render
    // the (optionally letterboxed) viewfinder region ourselves.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    this.grid = new THREE.GridHelper(4, 16, 0x2b2b34, 0x24242c);
    this.scene.add(this.grid);
    this.addShadow();
    this.orbit = makeOrbit(() => this.camera as THREE.PerspectiveCamera, canvas);
    // dragging the mouse in the locked PZ-iso view drops back to free orbit
    this.orbit.onInteract = () => { if (this.camMode === 'iso') this.setCamMode('orbit'); };
    this.fit();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      if (this.paused) return; // an export is driving the frames
      const dt = this.clock.getDelta();
      if (this.turntable) { this.spin = (this.spin + dt * 0.6) % (Math.PI * 2); this.rigs.setFacing(this.spin); }
      if (this.rigs.clip && this.playing) this.rigs.update(dt * this.speed);
      if (this.rigs.clip) this.onFrame?.(this.rigs.time(), this.rigs.duration());
      this.drawFrame();
    };
    loop();
  }

  /** Clear the whole buffer (transparent), then render the scene - full-canvas, or into the
   *  centered viewfinder rect when an export aspect is active. */
  private drawFrame() {
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.vw, this.vh);
    r.clear();
    if (this.viewRect) {
      const v = this.viewRect;
      r.setViewport(v.x, v.y, v.w, v.h);
      r.setScissor(v.x, v.y, v.w, v.h);
      r.setScissorTest(true);
    }
    r.render(this.scene, this.camera);
  }

  fit() {
    const canvas = this.renderer.domElement;
    const wrap = canvas.parentElement!;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.vw = Math.round(w * pr); this.vh = Math.round(h * pr);
    const aspect = this.exportAspect;
    if (aspect) {
      // largest centered rect of `aspect` fitting the viewport (CSS px), then to buffer px
      let rw = w, rh = w / aspect;
      if (rh > h) { rh = h; rw = h * aspect; }
      const left = (w - rw) / 2, top = (h - rh) / 2;
      this.viewRect = { x: Math.round(left * pr), y: Math.round((h - top - rh) * pr), w: Math.round(rw * pr), h: Math.round(rh * pr) };
      this.perspCam.aspect = aspect; this.isoCam.__aspect = aspect;
      this.onViewfinder?.({ left, top, width: rw, height: rh });
    } else {
      this.viewRect = null;
      this.perspCam.aspect = w / h; this.isoCam.__aspect = w / h;
      this.onViewfinder?.(null);
    }
    this.perspCam.updateProjectionMatrix();
    this.orbit.apply();
  }

  /** Set the export/viewfinder aspect (w/h), or null for the full viewport. */
  setExportAspect(aspect: number | null) { this.exportAspect = aspect; this.fit(); }

  // ---- scene controls (port of character.js setCamMode / bindView / bindLighting) ----

  /** Switch between free perspective orbit and the vanilla PZ iso camera (pitch 30, yaw 45). */
  setCamMode(mode: 'orbit' | 'iso') {
    this.camMode = mode;
    this.preset = mode;
    this.camera = mode === 'iso' ? this.isoCam : this.perspCam;
    if (mode === 'iso') { this.orbit.state.theta = Math.PI / 4; this.orbit.state.phi = Math.PI / 3; }
    this.fit();
    this.onCamMode?.(mode);
  }

  /** Studio camera presets. `front` (35mm) and `portrait` (60mm) use the perspective camera at
   *  a real focal length, framed on the body from its measured bounds; `iso` is the PZ camera. */
  applyCameraPreset(preset: 'orbit' | 'iso' | 'front' | 'portrait') {
    if (preset === 'iso' || preset === 'orbit') { this.setCamMode(preset); return; }
    this.preset = preset;
    this.camMode = 'orbit';
    this.camera = this.perspCam;
    const b = this.bodyBounds;
    const H = b ? b.maxY - b.minY : 1;
    this.perspCam.setFocalLength(preset === 'portrait' ? 60 : 35); // fov from 35mm film gauge + current aspect
    const extent = preset === 'portrait' ? 0.34 * H : 1.06 * H;                  // head+shoulders vs full body
    const ty = preset === 'portrait' ? (b ? b.maxY : H) - 0.14 * H : (b ? b.minY : 0) + H / 2;
    const fovV = this.perspCam.fov * Math.PI / 180;
    this.orbit.setTarget(new THREE.Vector3(b ? b.cx : 0, ty, b ? b.cz : 0));
    this.orbit.state.radius = (extent / 2) / Math.tan(fovV / 2);
    this.orbit.state.theta = Math.PI / 2; // straight-on front
    this.orbit.state.phi = Math.PI / 2;   // eye level
    this.orbit.apply();
    this.onCamMode?.('orbit');
  }

  setTurntable(on: boolean) { this.turntable = on; }
  setSpinAngle(rad: number) { this.rigs.setFacing(rad); }

  // ---- export ----
  get webglCanvas() { return this.renderer.domElement; }
  getCurrentAspect() { return this.exportAspect ?? this.perspCam.aspect; }

  /** Resize the renderer to a full-frame (w,h) export target and pause the live loop so the
   *  caller can drive frames. Returns a restore fn that reinstates the viewport + loop. */
  beginExport(w: number, h: number): () => void {
    const prev = { vw: this.vw, vh: this.vh, rect: this.viewRect, aspect: this.perspCam.aspect, pr: this.renderer.getPixelRatio(), playing: this.playing, turntable: this.turntable };
    this.paused = true;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.vw = w; this.vh = h; this.viewRect = null;
    this.perspCam.aspect = w / h;
    if (this.preset === 'front' || this.preset === 'portrait') this.perspCam.setFocalLength(this.preset === 'portrait' ? 60 : 35);
    this.perspCam.updateProjectionMatrix();
    this.isoCam.__aspect = w / h;
    this.orbit.apply();
    return () => {
      this.renderer.setPixelRatio(prev.pr);
      this.renderer.setSize(prev.vw / prev.pr, prev.vh / prev.pr, false);
      this.perspCam.aspect = prev.aspect; this.perspCam.updateProjectionMatrix();
      this.isoCam.__aspect = prev.aspect;
      this.playing = prev.playing; this.turntable = prev.turntable;
      this.paused = false;
      this.fit();
    };
  }
  renderFrame() { this.drawFrame(); }

  // Negate: the compass degrees are mirrored east-west relative to three's Y rotation
  // (N/S sit on the axis, so they're unaffected; E/W and diagonals need the flip).
  setFacing(deg: number) { this.rigs.setFacing(-deg * Math.PI / 180); }
  setGridVisible(on: boolean) { if (!this.floorMesh) this.grid.visible = on; }

  private floorMesh: THREE.Mesh | null = null;
  /** Lay a repeating floor texture on a ground plane (hides the grid), or null to clear.
   *  `tilesAcross` = how many game tiles the texture already contains (1 for a single tile,
   *  N for a baked N×N varied preset), so each tile still lands at ~0.45 world units. */
  setFloor(tex: THREE.Texture | null, tilesAcross = 1) {
    if (this.floorMesh) {
      this.scene.remove(this.floorMesh);
      this.floorMesh.geometry.dispose();
      (this.floorMesh.material as THREE.Material).dispose(); // not the texture (cached by FloorLibrary)
      this.floorMesh = null; this.floorMat = null;
    }
    if (!tex) { this.grid.visible = true; return; }
    // The body mesh is ~0.98 units tall (~2 game tiles), so a tile ≈ 0.45 units. Large plane
    // so the floor always fills the orbit view.
    const SIZE = 40, TILE = 0.45;
    const rep = SIZE / (TILE * tilesAcross);
    tex.repeat.set(rep, rep);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    mat.color.setScalar(this.light.ambient); // floor is lit by AMBIENT only, not the key light
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0;
    this.scene.add(mesh);
    this.floorMesh = mesh; this.floorMat = mat;
    this.grid.visible = false;
  }

  // Soft blob shadow under the character (matches the game's grounding shadow): a radial
  // black gradient on a small horizontal plane just above the floor.
  private addShadow() {
    const S = 256;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.32, 'rgba(0,0,0,0.28)'); // faster falloff
    g.addColorStop(0.65, 'rgba(0,0,0,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
    const D = 0.8; // shadow diameter (~character footprint)
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(D, D), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.006; // just above the floor to avoid z-fighting
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.shadow = mesh;
  }
  setShadowVisible(on: boolean) { if (this.shadow) this.shadow.visible = on; }

  lightingObj() {
    const l = this.light;
    return { ambient: [l.ambient, l.ambient, l.ambient], keyDir: l.keyDir.slice(), keyColour: [l.keyBright, l.keyBright, l.keyBright] };
  }
  applyLighting() {
    const set = (o: THREE.Object3D) => {
      const u = (o as THREE.Mesh & { material?: THREE.ShaderMaterial }).material?.uniforms;
      if (!u) return;
      u.ambient?.value.set(this.light.ambient, this.light.ambient, this.light.ambient);
      u.keyColour?.value.set(this.light.keyBright, this.light.keyBright, this.light.keyBright);
      u.keyDir?.value.set(this.light.keyDir[0], this.light.keyDir[1], this.light.keyDir[2]);
    };
    for (const rig of this.rigs.rigs) rig.root.traverse(set);
    for (const s of this.statics.values()) s.traverse(set);
    for (const h of this.held.values()) h.holder.traverse(set);
    if (this.floorMat) this.floorMat.color.setScalar(this.light.ambient); // floor tracks ambient only
  }
  setLight(key: 'ambient' | 'keyBright' | 'kx' | 'ky' | 'kz', v: number) {
    if (key === 'kx') this.light.keyDir[0] = v; else if (key === 'ky') this.light.keyDir[1] = v; else if (key === 'kz') this.light.keyDir[2] = v;
    else this.light[key] = v;
    this.applyLighting();
  }
  resetLight() {
    this.light = { ambient: CHAR_LIGHTING.ambient[0], keyBright: CHAR_LIGHTING.keyColour[0], keyDir: [...CHAR_LIGHTING.keyDir] };
    this.applyLighting();
  }

  // ---- transport ----
  seek(frac: number) { this.rigs.setTime(frac * this.rigs.duration()); }
  getTime() { return this.rigs.time(); }
  getDuration() { return this.rigs.duration(); }
  setLoop(on: boolean) { this.rigs.setLoop(on); }
  setSpeed(s: number) { this.speed = s; }

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
    const mat = makeSkinnedMaterial(tex, this.lightingObj());
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
    this.bodySkel = captureSkeletonBind(root); // bind-pose skeleton for world-space glb retarget
    const hadBody = !!this.rigs.bodyRig();
    this.rigs.removeKind('body');
    this.rigs.add('body', root);
    root.updateMatrixWorld(true);
    // Ground the character on the grid: the PZ body's lowest point sits a hair below its
    // origin, so without this the feet clip through the y=0 floor. Lift the whole rig set so
    // the measured minY rests exactly on 0, then remeasure for framing.
    const raw = new THREE.Box3().setFromObject(root);
    this.rigs.setGroundOffset(this.rigs.groundOffset - raw.min.y);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const c = box.getCenter(new THREE.Vector3());
    this.bodyBounds = { minY: box.min.y, maxY: box.max.y, cx: c.x, cz: c.z };
    if (!hadBody) {
      const s = box.getSize(new THREE.Vector3());
      this.orbit.setTarget(new THREE.Vector3(0, c.y, 0));
      this.orbit.state.radius = Math.max(s.y, 1) * 1.9;
      this.orbit.apply();
    }
    await this.recompositeBody();
  }

  /** Swap the body skin tone (texture only, no mesh reload); recomposites so clothing stays. */
  async setSkin(tone: string) {
    if (!this.currentBody) return;
    const hit = await (this.ctx.resolver as { resolveTexture(n: string): Promise<{ src: { readBytes(p: string): Promise<Uint8Array> }; realPath: string } | null> }).resolveTexture(`Body/${tone}`);
    if (!hit) return;
    this.currentBody.skinTexture = await hit.src.readBytes(hit.realPath);
    await this.recompositeBody();
  }

  async playClip(clip: Clip) {
    const r = await resolveClip(this.ctx, clip);
    if (r.error) throw new Error(r.error);
    const gltf = await glbToGltf(r.glb);
    if (!gltf.animations?.length) throw new Error('no animation in ' + clip.name);
    const norm = normaliseClip(gltf.animations[0], clip.format, { clipScene: gltf.scene, bodySkel: this.bodySkel ?? undefined, clipRest: boneRestMap(gltf.scene), bodyRest: this.bodyRest });
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
    for (const [name, e] of this.equipped.entries()) {
      if (this.hidden.has(name)) continue; // a hidden garment drops its texture layer AND its skin mask
      for (const b of e.baseTextures) layers.push({ bytes: b, tint: e.tint });
      for (const m of e.maskTextures) masks.push(m);
    }
    const canvas = await composeBody(this.currentBody.skinTexture, layers, masks);
    this.setBodyTexture(sourceToTexture(canvas, false));
  }

  /** All currently-equipped clothing + held items, for the viewer's equipped panel. */
  equippedList(): { name: string; type: 'clothing' | 'held'; hidden: boolean }[] {
    const out: { name: string; type: 'clothing' | 'held'; hidden: boolean }[] = [];
    for (const name of this.equipped.keys()) out.push({ name, type: 'clothing', hidden: this.hidden.has(name) });
    for (const name of this.held.keys()) out.push({ name, type: 'held', hidden: this.hidden.has(name) });
    return out;
  }

  /** Temporarily show/hide an equipped item without unequipping it. Meshes/statics/held toggle
   *  their Object3D visibility; a hidden garment is also dropped from the body recomposite so
   *  its skin mask stops showing through. */
  async setItemHidden(name: string, hidden: boolean) {
    if (hidden) this.hidden.add(name); else this.hidden.delete(name);
    const rig = this.rigs.get('cloth:' + name); if (rig) rig.root.visible = !hidden;
    const st = this.statics.get(name); if (st) st.visible = !hidden;
    const h = this.held.get(name); if (h) h.holder.visible = !hidden;
    if (this.equipped.has(name)) await this.recompositeBody();
  }

  async removeEquipped(name: string, type: 'clothing' | 'held') {
    if (type === 'held') this.unequipHeld(name);
    else await this.unequipClothing(name);
  }

  isEquipped(name: string) { return this.equipped.has(name); }
  equippedNames() { return [...this.equipped.keys()]; }

  async toggleClothing(item: { name: string }, tint: number[] | null = null) {
    if (this.equipped.has(item.name)) { await this.unequipClothing(item.name); return false; }
    const r = await resolveClothing(this.ctx, item, this.gender);
    if (r.error) throw new Error(r.error);
    const entry: Equip = { kind: r.kind, maskTextures: r.maskTextures || [], baseTextures: r.baseTextures || [], tint, hatCategory: r.hatCategory || null };
    if (r.kind === 'mesh') {
      const tex = r.texture ? await bytesToTexture(r.texture, false) : this.white();
      const root = await this.loadSkinnedRoot(r.meshGlb, tex, tint, true); // tint -> shader tint uniform
      this.rigs.add('cloth:' + item.name, root);
    } else if (r.kind === 'static') {
      await this.attachStatic(item.name, r, tint);
    }
    this.equipped.set(item.name, entry);
    await this.recompositeBody();
    return true;
  }

  /** Unequip everything (used before applying an imported outfit). */
  async clearAllClothing() {
    for (const name of [...this.equipped.keys()]) await this.unequipClothing(name);
  }

  async unequipClothing(name: string) {
    const e = this.equipped.get(name);
    if (!e) return;
    if (e.kind === 'mesh') this.rigs.removeKind('cloth:' + name);
    else if (e.kind === 'static') this.detachStatic(name);
    this.equipped.delete(name);
    this.hidden.delete(name);
    await this.recompositeBody();
  }

  private async attachStatic(name: string, r: { meshGlb: Uint8Array; texture: Uint8Array | null; attachBone?: string | null }, tint: number[] | null = null) {
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
    const mat = makeMaterial(tex, this.lightingObj(), true);
    if (tint) mat.uniforms.tint.value.set(tint[0], tint[1], tint[2]);
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
    // flipY=false: the assimp glb UVs are in glTF convention (V origin at top), same as the
    // body/clothing path. flipY=true samples the transparent atlas background on both vanilla
    // (.x) and modded (.fbx) weapons -> black/see-through patches.
    const tex = r.texture ? await bytesToTexture(r.texture, false) : this.white();
    const mat = makeMaterial(tex, this.lightingObj(), true);
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
    this.hidden.delete(name);
  }

  /** kind = 'hair' | 'beard'. style=null or {name:'None'} removes the part. */
  async applyPart(kind: 'hair' | 'beard', style: { name: string; model?: string; texture?: string } | null, color: number[] | null) {
    this.rigs.removeKind(kind);
    if (!style || style.name === 'None') return;
    const r = await resolveHairStyle(this.ctx, style);
    if (!r.hasMesh) return;
    const tex = await bytesToTexture(r.texture, false);
    const root = await this.loadSkinnedRoot(r.meshGlb, tex, color, true);
    this.rigs.add(kind, root);
  }

  /** Recolour an already-loaded hair/beard rig by updating its tint uniform only - no
   *  mesh/texture reload, so colour-picker dragging stays smooth. Returns false if the
   *  part isn't currently loaded (caller should fall back to applyPart). */
  setPartTint(kind: 'hair' | 'beard', color: number[]) {
    const rig = this.rigs.get(kind);
    if (!rig) return false;
    rig.root.traverse((o) => {
      const m = o as THREE.Mesh & { material: THREE.ShaderMaterial };
      if (m.isMesh && m.material?.uniforms?.tint) m.material.uniforms.tint.value.set(color[0], color[1], color[2]);
    });
    return true;
  }
}
