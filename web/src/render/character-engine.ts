// Imperative character engine: renderer + scene + rigs, plus dress/arm/animate. Faithful
// browser port of src/characterApp/character.js's equip logic, driven by the async
// resolve* fns (which return glb/png BYTES) and the Canvas body compositor. The React
// viewer creates one of these and calls its methods; all Three.js lives here.
import { resolveBody, resolveSkinTexture, resolveClip, resolveClothing, resolveHeldItem, resolveHairStyle, resolveAttachmentPart } from '@shared/character-core.js';
import { THREE, makeSkinnedMaterial, makeMaterial, CHAR_LIGHTING, partMatrix, makeOrbit } from './three-core';
import { glbToGltf, isolateSubMesh, bytesToTexture, sourceToTexture } from './loaders';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { normaliseClip, retargetAttachments, boneRestMap, normalizeClothingRig, captureSkeletonBind, type SkeletonBind } from './anim';
import { applyDelta, applyTranslationDelta, renameSet, appDeltaToX, appPosToX, type Quat } from '../anim-edit/xedit';
import { composeBody } from './canvas-image-ops';
import { RigSet } from './rigset';

export interface Ctx { resolver: unknown; converter: unknown; }
type Clip = { id: string; name: string; format: string; rel: string };

interface Equip { kind: string; maskTextures: Uint8Array[]; baseTextures: Uint8Array[]; tint: number[] | null; hatCategory: string | null; layer: number; }
type Socket = { offset: number[]; rotate: number[]; scale?: number };
// A body attachment location's transform (shared/attachments.js): a target bone + the PZ-space
// offset/rotate/scale that positions the item there (bat on back, gun in holster, ...).
export type BodyTransform = { bone: string; offset: number[]; rotate: number[]; scale?: number };
// A held item descriptor as far as body-attaching needs it (what resolveHeldItem reads + its sockets).
export type BodyAttachItem = { name: string; mesh: string; texture?: string; scale?: number; prop?: string; allAttachments?: Record<string, Socket> };
// One weapon-part option from a held item's attachSlots (shared/character-core.js).
export type AttachOption = { partName: string; mesh: string; texture?: string; parentAttachment: Socket; selfAttachment: Socket | null };
type HeldEntry = { holder: THREE.Object3D; prop: string; item: { name: string }; gunObj: THREE.Object3D; parts: Map<string, THREE.Object3D>; attachSel: Map<string, AttachOption> };

type IsoCam = THREE.OrthographicCamera & { __aspect?: number };
// The scene-builder brush: a flat floor/rug (de-sheared texture) or a standing object (full sprite
// texture + its authored px size, rendered as a camera-facing billboard).
// kind 'object' covers both walls and furniture (identical billboard render); `objectSlot` decides how it
// stacks in a cell - walls accumulate (a corner is two walls) and never get displaced by furniture, which
// has its own single slot. `name` lets a re-placed wall replace its own copy instead of stacking duplicates.
// `parts` are extra standing sprites at cell offsets (dx,dy) from the anchor - a 2-tile couch or 2x2 bed
// places them all together in one action, and the ghost previews all of them.
export type TileBrushPart = { tex: THREE.Texture; fullW: number; fullH: number; dx: number; dy: number; name?: string };
export type TileBrush = { tex: THREE.Texture; kind: 'floor' | 'rug' | 'object'; objectSlot?: 'wall' | 'furniture'; name?: string; fullW?: number; fullH?: number; parts?: TileBrushPart[] };
// One grid cell's stacked contents. walls + furniture are ordered lists (a corner is two walls, a lamp
// stacks on a table). A snapshot is a shallow copy of this (mesh refs kept alive) for undo/redo.
type Cell = { floor?: THREE.Mesh; rug?: THREE.Mesh; walls: THREE.Mesh[]; furniture: THREE.Mesh[] };
// A placed 3D prop: its object, model scale, per-mesh original UVs (to re-bake a UV fix from), and its
// per-prop UV fix (flip U / flip V / rotate) for the rare mesh whose texture maps wrong.
export type PropXf = { flipU: boolean; flipV: boolean; rot: number };
// "Sticky" attachment: the prop follows a moving target each frame at a fixed target-local offset.
//  - 'bone': follows a character skeleton bone (e.g. cigarette on the head) - moves with animation/facing.
//  - 'prop': follows another placed prop (moves when that prop is moved/rotated/scaled).
// (grounded/floor = no attachment at all -> attach:null.) offset = targetWorld^-1 * propWorld at attach time.
type PropAttach = { kind: 'bone' | 'prop'; boneName?: string; targetObj?: THREE.Object3D | null; offset: THREE.Matrix4 };
type PlacedProp = {
  id: string;        // stable per-prop id (for save/load links between a prop and its sticky-target prop)
  obj: THREE.Object3D; baseScale: number; uvMeshes: { geo: THREE.BufferGeometry; orig: Float32Array }[]; uvXf: PropXf;
  sticky: boolean;   // armed: the next drag-release attaches to the surface under it
  align: boolean;    // orient to the surface normal on attach (vs keep current rotation)
  attach: PropAttach | null;
  parts?: Map<string, THREE.Object3D>;   // weapon-part attachments (scope/canon/...) mounted on this prop: slot -> holder
  attachSel?: Map<string, AttachOption>; // slot -> chosen option (for highlight + duplicate)
};
// Serialized placed prop (into a preset). The mesh is NOT stored - it's re-resolved from `item` on load, so
// presets stay small. Sticky-attach keeps the exact follow offset (16-float matrix) + a bone name / target id.
export type PropSave = {
  item: string; id: string; pos: number[]; quat: number[]; scl: number[]; uvXf: PropXf; sticky: boolean; align: boolean;
  attach: null | { kind: 'bone'; boneName: string; offset: number[] } | { kind: 'prop'; targetId: string; offset: number[] };
  attachments: { slot: string; partName: string }[];
};
// One resolved weapon-part to re-mount on load (React resolves the option from the item's slots by part name).
export type SavedPropAttachment = { slot: string; option: AttachOption };
// A serialized placed tile: cell + tile name + which slot. The texture is re-resolved from the name on load.
export type TileSave = { gx: number; gy: number; name: string; slot: 'floor' | 'rug' | 'wall' | 'furniture' };
// Everything React must hand the engine to rebuild one saved prop.
export type SavedPropInput = { glb: Uint8Array; texture: Uint8Array | null; subMesh: string | null; baseScale: number; save: PropSave; attachments: SavedPropAttachment[] };
// Full reversible state of a prop's placement (transform + attachment), for one undo entry per move/attach.
type PropState = { xform: Xform; attach: PropAttach | null };
// What the cursor is over while placing/dragging a prop: the character body, another prop, or the ground.
type SurfacePick = { point: THREE.Vector3; onBody: boolean; propRoot: THREE.Object3D | null; normal: THREE.Vector3 | null };
// A live Blender-style modal transform (grab/rotate/scale following the mouse until click/Esc). Everything is
// captured relative to the state when the key was pressed, so an axis constraint or cancel re-derives cleanly.
// One prop in a modal transform: its start transform + reversible state. Rotate/scale pivot on the shared centre.
type ModalItem = { p: PlacedProp; startPos: THREE.Vector3; startQuat: THREE.Quaternion; startScale: THREE.Vector3; before: PropState };
type ModalXform = {
  mode: 'move' | 'rotate' | 'scale'; axis: 'x' | 'y' | 'z' | null;
  items: ModalItem[]; pivot: THREE.Vector3;
  plane: THREE.Plane; planeStart: THREE.Vector3; center: { x: number; y: number };
  startAngle: number; startDist: number; axisT0: number;
};
// Two-finger touch transform of the selection: twist rotates + pinch scales around the shared centroid.
type TouchGesture = { items: ModalItem[]; pivot: THREE.Vector3; startAngle: number; startDist: number };
// A rigid transform snapshot (clones), used to undo/redo prop moves + gizmo edits.
type Xform = { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 };
// One entry on the shared undo timeline: either a tile-cell transaction (before/after cell snapshots) or a
// prop command (do/undo closures over live Object3Ds). undo()/redo() dispatch on `kind`.
type HistoryEntry =
  | { kind: 'cells'; before: Map<string, Cell | null>; after: Map<string, Cell | null> }
  | { kind: 'props'; undo: () => void; redo: () => void };

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
  private finished = false; // a non-looping clip has reached its end (so play acts as replay)
  speed = 1;
  // live-adjustable lighting (matches the desktop app's defaults)
  light = { ambient: CHAR_LIGHTING.ambient[0], keyBright: CHAR_LIGHTING.keyColour[0], keyDir: [...CHAR_LIGHTING.keyDir] as number[] };

  private grid: THREE.GridHelper;
  private shadow: THREE.Mesh | null = null;
  private fitBuf: Uint8Array | null = null; // scratch for the silhouette-based framing readback
  private floorMat: THREE.MeshBasicMaterial | null = null;
  private raf = 0;
  private disposed = false;
  // viewfinder: when exportAspect is set, the live view renders into a centered rect of that
  // aspect (letterboxed), so what you see is exactly what exports. In drawing-buffer pixels.
  private vw = 1; private vh = 1;
  private viewRect: { x: number; y: number; w: number; h: number } | null = null;
  private exportAspect: number | null = null;
  private bodyBounds: { minY: number; maxY: number; cx: number; cz: number } | null = null;
  private autoFrame = false; // when set, canvas resizes re-fit the whole body (mobile default until the user adjusts the camera)
  private bodyMeshes: THREE.SkinnedMesh[] = []; // body skinned meshes, for measuring the true posed sole
  private turntable = false;
  private spin = 0; // live turntable angle (rad)
  private preset: 'orbit' | 'iso' | 'front' | 'portrait' = 'orbit';
  private paused = false; // while an export drives the frames itself
  onViewfinder?: (rect: { left: number; top: number; width: number; height: number } | null) => void;
  private bodyRest = new Map<string, THREE.Quaternion>();
  private bodySkel: SkeletonBind | null = null;
  // --- animation editor: edit a loaded .x clip's pose (Phase 1+) ---
  private editText: string | null = null;          // raw .x source of the current clip (null unless format is .x)
  private editClipName: string | null = null;      // the loaded clip's name / AnimationSet name
  private editMode = false;                         // pose editing active: playback paused, joints pickable, overrides applied
  private boneEdits = new Map<string, { rot: THREE.Quaternion; pos: THREE.Vector3 }>(); // author's app-space per-bone deltas
  private boneBase = new Map<string, { quat: THREE.Quaternion; pos: THREE.Vector3 }>();  // the clip pose of edited bones at the current frame
  private bodyBones = new Map<string, THREE.Bone>(); // bone name -> Bone on the body rig (selection / gizmo / base capture)
  private selectedBones: string[] = [];            // current bone selection (primary = last)
  onEditState?: (info: { active: boolean; clip: string | null; editable: boolean; bones: string[] }) => void;
  onBoneSelect?: (names: string[]) => void;
  onBoneEdit?: () => void;                          // fired after a drag/gizmo changes a bone's delta
  private hoverBone: string | null = null;         // handle under the cursor (highlighted)
  private boneOverlay: THREE.Group | null = null;  // the curated IK/pose handle markers
  private drag: { mode: 'ik' | 'pole' | 'aim' | 'move'; grab: string; affected: string[]; chain?: string[]; l1: number; l2: number; twistDir?: number; handTarget?: THREE.Vector3; endQuat?: THREE.Quaternion; planePt?: THREE.Vector3; offset?: THREE.Vector3; pins?: { chain: string[]; target: THREE.Vector3; pole: THREE.Vector3; l1: number; l2: number; footQuat: THREE.Quaternion }[]; headHold?: THREE.Quaternion; lastX?: number; lastY?: number } | null = null;
  private poleTargets = new Map<string, THREE.Vector3>(); // per-limb elbow/knee pole point (keyed by the IK end bone)
  private dragBefore: Map<string, { rot: THREE.Quaternion; pos: THREE.Vector3 } | null> | null = null; // affected bones' edits at grab, for undo
  private currentBody: { skinTexture: Uint8Array } | null = null;
  private textureSource: unknown = null; // pins skin textures to a source (Vanilla vs a texture mod), or null = mod-over-vanilla
  private uvVerdictVal: { score: number; compatible: boolean } | null = null; // modded body vs vanilla UV layout; null when the body IS vanilla
  private vanillaUvSig = new Map<'male' | 'female', Set<number>>(); // cached vanilla UV-occupancy signature per gender
  private equipped = new Map<string, Equip>();
  private statics = new Map<string, THREE.Object3D>();
  private held = new Map<string, HeldEntry>();
  // body-attached items (bat on back, gun in holster, ...), keyed by slot type; one item per slot.
  private bodyAttached = new Map<string, { obj: THREE.Object3D; itemName: string; attachmentName: string; transform: BodyTransform }>();
  private static readonly RIGHT_PROP = 'Bip01_Prop1';
  private static readonly LEFT_PROP = 'Bip01_Prop2';
  private hidden = new Set<string>(); // equipped-but-temporarily-hidden clothing/held names
  private whiteTex: THREE.Texture | null = null;
  onClipName?: (s: string) => void;
  onFrame?: (time: number, duration: number) => void;
  onPlaying?: (playing: boolean) => void; // fires when playback auto-stops at the end of a one-shot clip
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
    this.orbit.onInteract = () => { this.autoFrame = false; if (this.camMode === 'iso') this.setCamMode('orbit'); };
    this.orbit.onAdjust = () => { this.autoFrame = false; }; // any pan/zoom/touch also ends auto-framing
    this.orbit.suspendTouch = (n) => this.propMode && !this.camLock && n >= 2 && this.selection.length > 0; // two fingers transform the selected prop(s), not the camera
    this.initTileInput(canvas);
    this.fit();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      if (this.paused) return; // an export is driving the frames
      const dt = this.clock.getDelta();
      if (this.turntable) { this.spin = (this.spin + dt * 0.6) % (Math.PI * 2); this.rigs.setFacing(this.spin); }
      if (this.rigs.clip && this.playing) {
        this.rigs.update(dt * this.speed);
        if (this.editMode) { this.captureBoneBase(); this.applyBoneOverrides(); } // re-base off the fresh clip pose so the edit rides the motion (no compounding)
        if (this.rigs.finishedOnce()) { this.playing = false; this.finished = true; this.onPlaying?.(false); } // one-shot done: stop, arm replay
      }
      if (this.rigs.clip) this.onFrame?.(this.rigs.time(), this.rigs.duration());
      if (this.billboards.length) { const q = this.camera.quaternion; for (const m of this.billboards) m.quaternion.copy(q); } // standing tiles face the camera
      this.updateStickyProps(); // sticky props follow their bone/prop target after the pose is updated
      if (this.outline.length) this.updateOutline(); // keep the selection rim glued to the (posed) prop
      if (this.editMode) this.updateBoneHighlight(); // keep the hover/selected markers glued to the (posed) bones
      this.drawFrame();
    };
    loop();
  }

  /** Clear the whole buffer (transparent), then render the scene - full-canvas, or into the
   *  centered viewfinder rect when an export aspect is active. vw/vh/viewRect are in drawing-buffer
   *  pixels (for readPixels), but renderer.setViewport/setScissor take CSS pixels and re-multiply by
   *  the pixelRatio internally - so divide by pr here, or the viewport is pr x too big (which zooms and
   *  shifts the whole scene on any hi-dpi / mobile display, pr>1). */
  private drawFrame() {
    const r = this.renderer, pr = r.getPixelRatio();
    r.setScissorTest(false);
    r.setViewport(0, 0, this.vw / pr, this.vh / pr);
    r.clear();
    if (this.viewRect) {
      const v = this.viewRect;
      r.setViewport(v.x / pr, v.y / pr, v.w / pr, v.h / pr);
      r.setScissor(v.x / pr, v.y / pr, v.w / pr, v.h / pr);
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

  /** Canvas resized (viewport / layout / device-mode change): re-fit the projection and, while
   *  auto-framing is on, re-frame the whole body to the new size. Called by the ResizeObserver. */
  resize() { this.fit(); if (this.autoFrame && this.bodyMeshes.length) this.frameToBody(); }

  /** Turn on/off "keep the whole body framed as the canvas resizes" (the mobile default). Framing
   *  once immediately if a body is loaded; the user adjusting the camera or picking a preset ends it. */
  setAutoFrame(on: boolean) { this.autoFrame = on; } // framing is driven explicitly / by resize(), once the body is posed

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
    this.autoFrame = false; // an explicit front/portrait framing should stick, not be re-fit on resize
    this.preset = preset;
    this.camMode = 'orbit';
    this.camera = this.perspCam;
    const b = this.bodyBounds;
    const H = b ? b.maxY - b.minY : 1;
    this.perspCam.setFocalLength(preset === 'portrait' ? 60 : 35); // fov from 35mm film gauge + current aspect
    // Frame a bit looser than the body's measured bounds and bias the target upward, so tall hats
    // and big hair (which sit ABOVE the body's maxY - bodyBounds is the bare body) aren't cropped.
    const extent = preset === 'portrait' ? 0.40 * H : 1.28 * H;                  // head+shoulders vs full body
    const ty = preset === 'portrait' ? (b ? b.maxY : H) - 0.11 * H : (b ? b.minY : 0) + 0.54 * H;
    const fovV = this.perspCam.fov * Math.PI / 180;
    this.orbit.setTarget(new THREE.Vector3(b ? b.cx : 0, ty, b ? b.cz : 0));
    this.orbit.state.radius = (extent / 2) / Math.tan(fovV / 2);
    this.orbit.state.theta = Math.PI / 2; // straight-on front
    this.orbit.state.phi = Math.PI / 2;   // eye level
    this.orbit.apply();
    this.onCamMode?.('orbit');
  }

  /** Reset the free-orbit camera to the default centred framing (whole body, straight-on) - the same
   *  view a freshly loaded body gets. Re-clicking the orbit button uses this for a quick reset after
   *  panning / zooming / rotating. On mobile (autoFrame) it finishes with the tight silhouette fit. */
  recenter() {
    this.camMode = 'orbit'; this.preset = 'orbit'; this.camera = this.perspCam;
    const b = this.bodyBounds, st = this.orbit.state;
    const cy = b ? (b.minY + b.maxY) / 2 : 0.5, h = b ? b.maxY - b.minY : 1;
    st.theta = Math.PI / 2; st.phi = Math.PI * 0.42; st.radius = Math.max(h, 1) * 1.9;
    this.orbit.setTarget(new THREE.Vector3(0, cy, 0)); // copies + applies
    this.onCamMode?.('orbit');
    if (this.autoFrame && this.bodyMeshes.length) this.frameToBody();
  }

  /** Fit the whole body in view, centered, keeping the current orbit angle. This rig's retarget
   *  skinning renders the mesh nowhere near what Box3/skeleton report (bind bounds are ~half height and
   *  the wrong centre; a plain offscreen render also mis-skins it), so we render the real frame
   *  (drawFrame), read back the character silhouette, and iterate pan+zoom until it's centred and fills
   *  the frame. Used for the mobile default; only meaningful for the perspective (orbit) camera. The
   *  intermediate frames aren't presented (all inside one JS turn), so there's no visible flicker. */
  frameToBody() {
    if (!this.bodyMeshes.length || this.camMode !== 'orbit') return;
    const cam = this.perspCam, orbit = this.orbit;
    const gl = this.renderer.getContext();
    const w = this.vw, h = this.vh, need = w * h * 4;
    if (!this.fitBuf || this.fitBuf.length < need) this.fitBuf = new Uint8Array(need);
    const buf = this.fitBuf;
    const STEP = Math.max(1, Math.floor(Math.min(w, h) / 200)); // subsample the scan for speed (~200px)
    // hide everything but the character so the alpha silhouette is the body (+ worn/held) only
    const gV = this.grid.visible, sV = this.shadow?.visible ?? false, fV = this.floorMesh?.visible ?? false;
    this.grid.visible = false; if (this.shadow) this.shadow.visible = false; if (this.floorMesh) this.floorMesh.visible = false;
    const aspect = cam.aspect || 1, fovV = cam.fov * Math.PI / 180;
    const right = new THREE.Vector3(), up = new THREE.Vector3(), tmp = new THREE.Vector3();
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    const WANT = 1.5; // target silhouette span (~75% of the frame)
    const measure = () => {
      this.drawFrame();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, cnt = 0;
      for (let y = 0; y < h; y += STEP) for (let x = 0; x < w; x += STEP) { if (buf[(y * w + x) * 4 + 3] > 40) { cnt++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
      if (!cnt) return null;
      const xL = minX / w * 2 - 1, xR = maxX / w * 2 - 1, yB = minY / h * 2 - 1, yT = maxY / h * 2 - 1; // NDC (gl y is bottom-up)
      return { cx: (xL + xR) / 2, cy: (yB + yT) / 2, span: Math.max(xR - xL, yT - yB), edge: xL < -0.95 || xR > 0.95 || yB < -0.95 || yT > 0.95 };
    };
    const panToCentre = (cx: number, cy: number, gain: number) => {
      cam.updateMatrixWorld(true);
      right.setFromMatrixColumn(cam.matrixWorld, 0); up.setFromMatrixColumn(cam.matrixWorld, 1);
      const halfH = orbit.state.radius * Math.tan(fovV / 2), halfW = halfH * aspect;
      orbit.state.target.add(tmp.copy(right).multiplyScalar(cx * halfW * gain)).add(tmp.copy(up).multiplyScalar(cy * halfH * gain));
    };
    orbit.state.radius = 12; orbit.apply(); // start wide so the body is on-screen, then converge inward
    // phase 1: pan + zoom together until the body is roughly framed
    for (let i = 0; i < 16; i++) {
      const s = measure();
      if (!s) { orbit.state.radius = clamp(orbit.state.radius * 1.5, 0.6, 25); orbit.apply(); continue; }
      panToCentre(s.cx, s.cy, 0.7);
      const zf = s.edge ? Math.max(s.span / WANT, 1.2) : s.span / WANT;
      orbit.state.radius = clamp(orbit.state.radius * clamp(zf, 0.6, 1.6), 0.6, 25);
      orbit.apply();
      if (!s.edge && Math.abs(s.span - WANT) < 0.08 && Math.abs(s.cx) < 0.04 && Math.abs(s.cy) < 0.04) break;
    }
    // phase 2: zoom is set - a few pan-only passes (higher gain) to nail the centre
    for (let i = 0; i < 6; i++) {
      const s = measure();
      if (!s) break;
      if (Math.abs(s.cx) < 0.02 && Math.abs(s.cy) < 0.02) break;
      panToCentre(s.cx, s.cy, 0.9);
      orbit.apply();
    }
    this.grid.visible = gV; if (this.shadow) this.shadow.visible = sV; if (this.floorMesh) this.floorMesh.visible = fV;
    this.drawFrame();
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

  /** One-off portrait snapshot (JPEG data-URL) from the Front-35mm preset facing the camera (S),
   *  for a saved-character preview. Restores the live camera, facing and viewport afterwards. */
  snapshotFront(w: number, h: number, bgColor: string): string {
    const cb = this.onCamMode; this.onCamMode = undefined; // don't perturb the UI's camera toggle
    const prev = {
      camera: this.camera, preset: this.preset, camMode: this.camMode, facing: this.rigs.facing,
      orbit: { radius: this.orbit.state.radius, theta: this.orbit.state.theta, phi: this.orbit.state.phi, target: this.orbit.state.target.clone() },
    };
    const restore = this.beginExport(w, h);        // sets the export aspect first...
    try {
      this.applyCameraPreset('front');             // ...so the front framing is computed for it
      this.setFacing(0);                           // S: face the camera
      this.drawFrame();
      const cap = document.createElement('canvas'); cap.width = w; cap.height = h;
      const ctx = cap.getContext('2d')!;
      ctx.fillStyle = bgColor; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(this.webglCanvas, 0, 0, w, h);
      return cap.toDataURL('image/jpeg', 0.72);
    } finally {
      this.camera = prev.camera; this.preset = prev.preset; this.camMode = prev.camMode;
      this.orbit.state.radius = prev.orbit.radius; this.orbit.state.theta = prev.orbit.theta; this.orbit.state.phi = prev.orbit.phi;
      this.orbit.setTarget(prev.orbit.target);
      this.rigs.setFacing(prev.facing);
      restore();                                   // reinstates viewport + fit() (uses the restored camera)
      this.onCamMode = cb;
    }
  }

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
    // depthWrite off + a background renderOrder: nothing is ever below the ground, so the plane must not
    // depth-occlude standing build sprites whose footprints dip below the cell origin (else it clips their
    // bottom corners). The character still writes depth and sorts over it normally.
    const mat = new THREE.MeshBasicMaterial({ map: tex, depthWrite: false });
    mat.color.setScalar(this.light.ambient); // floor is lit by AMBIENT only, not the key light
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0;
    mesh.renderOrder = -1;
    this.scene.add(mesh);
    this.floorMesh = mesh; this.floorMat = mat;
    this.grid.visible = false;
  }

  // --- scene tile builder --------------------------------------------------------------------------
  // Flat tiles (floors + rugs) placed on an iso grid of TILE-sized cells, matching setFloor's scale
  // (1 game tile ~= 0.45 world units). A brush + a click on the ground drops a de-sheared tile at the
  // snapped cell; a floor is the base layer, a rug stacks just above it (PZ's rug-on-floor order). Only
  // meaningful at the pziso camera. Standing sprites (walls/furniture) come next.
  private static readonly TILE = 0.45;
  // world units per sprite pixel. A camera-facing billboard isn't foreshortened, but the flat floor tile
  // it stands on shows its DIAGONAL (0.45*sqrt2) as its on-screen width. Matching the two on screen (the
  // game draws the 128px wall sprite over the 128px floor-tile sprite 1:1) needs the sqrt2.
  private static readonly OBJ_PX = (0.45 * Math.SQRT2) / 128;
  // PZ's object cell origin: the footprint diamond centers 32px up in the 256px (2x) cell. Anchoring
  // this fixed point (not each sprite's opaque base) to the floor pins the cell origin to the ground, so
  // every sprite shows at its authored height - a chair sits low, a fridge stands tall - none float.
  private static readonly OBJ_ANCHOR = 32 / 256;
  private tileGroup = new THREE.Group();
  // Phase 0 (3D props): a group of placed prop meshes + a live world-scale multiplier for calibration.
  private propGroup = new THREE.Group();
  private props: PlacedProp[] = [];
  private propSeq = 0;                       // monotonic source of stable prop ids
  private pendingPropLinks: { rec: PlacedProp; targetId: string }[] = []; // prop->prop sticky links to resolve after a load
  private propMult = 0.6; // calibrated: model.scale * 0.6 reads life-sized next to the character
  private pending: { obj: THREE.Object3D; uvMeshes: { geo: THREE.BufferGeometry; orig: Float32Array }[]; baseScale: number } | null = null; // prop riding the cursor
  private pendingDown: { x: number; y: number } | null = null;
  private pendingPick: SurfacePick | null = null;    // what the riding prop is currently hovering over (for auto-attach on drop)
  private propMode = false;                    // 3D Props sub-tab active: clicks select props / drag moves them
  private selectedProp: THREE.Object3D | null = null;   // the PRIMARY selection (last picked) - drives the per-prop inspector
  private selection: PlacedProp[] = [];        // full multi-selection (shift-click / marquee); primary = last
  private marquee: { x0: number; y0: number; add: boolean; hit: THREE.Object3D | null; moved: boolean } | null = null; // shift-drag box select
  private dragGroup: { p: PlacedProp; start: THREE.Vector3; before: PropState }[] | null = null; // >1 props dragged together (ground delta)
  private dragGround: THREE.Vector3 | null = null;
  private touchGesture: TouchGesture | null = null;   // active two-finger prop transform
  private propPointers = new Map<number, { x: number; y: number }>(); // live touch points while manipulating props
  private camLock = false;                             // mobile: keep two-finger gestures on the camera even with a prop selected
  private selectMode = false;                          // mobile: a tap toggles a prop, a drag draws a marquee (no move/transform)
  private gizmo: TransformControls | null = null;
  private propDown: { x: number; y: number; obj: THREE.Object3D | null } | null = null;
  private grabOffset = new THREE.Vector3();    // keeps the grab point stable while free-dragging
  private propDragging: THREE.Object3D | null = null; // prop being actively dragged (free-drag/gizmo/modal); sticky follow is suspended for it
  private dragBeforeState: PropState | null = null;   // prop placement state at the start of a free-drag (for undo)
  private gizmoBeforeState: PropState | null = null;  // prop placement state at the start of a gizmo drag (for undo)
  private showGizmo = false;                          // Blender-style: gizmo handles hidden by default (a toggle shows them)
  private stickyDefault = false;                       // new props start sticky-armed (user default)
  private alignDefault = false;                        // new props orient to the surface on attach + preview (user default)
  private lastPointer: { x: number; y: number } | null = null; // last cursor pos over the canvas, the reference point for a modal
  private modal: ModalXform | null = null;            // active G/R/S modal transform (follows the mouse, no visible gizmo)
  private static readonly MODAL_AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) } as const;
  private outline: { src: THREE.Mesh; out: THREE.Mesh }[] = []; // inverted-hull shell mirroring the selected prop
  private outlineMat: THREE.ShaderMaterial | null = null;
  onPropSelect?: (info: { name: string; count: number; texXf: PropXf; sticky: boolean; align: boolean; attached: string | null; attachments: { slot: string; partName: string }[] } | null) => void;
  onMarquee?: (rect: { x: number; y: number; w: number; h: number } | null) => void; // shift-drag selection box in client px, for React to draw
  onPlacementHint?: (target: 'character' | 'prop' | 'floor' | null) => void; // live hint while a prop rides the cursor
  onModalChange?: (label: string | null) => void; // active modal-transform label for the status readout (e.g. "Move X")
  private cells = new Map<string, Cell>();
  private billboards: THREE.Mesh[] = []; // standing sprites that face the camera each frame
  private tileGrid: THREE.GridHelper | null = null;
  private ghost: THREE.Mesh | null = null;
  private ghostParts: { mesh: THREE.Mesh; dx: number; dy: number }[] = []; // preview sprites for a multi-tile brush
  private brush: TileBrush | null = null;
  private brushDown: { x: number; y: number } | null = null;
  private painting = false;                 // left button held: paint a stroke across cells
  private strokeCells = new Set<string>();   // cells already painted this stroke (skip re-placing)
  private shiftAnchor: { gx: number; gy: number } | null = null; // hold shift mid-stroke: lock to one grid axis from here
  private lastHover: { clientX: number; clientY: number } | null = null; // last mouse position, to refresh the ghost on a brush change
  private hovering = false;                  // mouse is over the canvas (so a keyboard brush change can re-show the ghost)
  private rectAnchor: { gx: number; gy: number } | null = null; // shift+left / rect mode: first corner of a fill rectangle
  private rectPreview: THREE.Mesh | null = null; // translucent highlight of the rectangle being dragged
  private static readonly RECT_MAX = 64;     // clamp a fill rectangle so a huge drag can't spawn 1000s of meshes
  private buildMode: 'place' | 'erase' = 'place'; // touch has no right-click, so erasing is an explicit mode
  private rectMode = false;                   // touch has no shift key, so rectangle-fill is an explicit toggle
  // Touch model (Option A): one finger acts (tap = place, drag = paint), two fingers navigate (makeOrbit
  // pans/zooms). We track pointers to cancel a place the moment a 2nd finger lands, and defer touch
  // placement until we know it is a single-finger gesture.
  private activePointers = new Set<number>();
  private multiTouch = false;
  private touchTap: { x: number; y: number; cell: { gx: number; gy: number } | null } | null = null;
  private static readonly TOUCH_AIM = 44;    // lift the aim point this many px above the fingertip (beat occlusion)
  private static readonly TOUCH_PICK_R = 22;  // radius of the fingertip forgiveness ring when tapping to select a prop
  private eraseLayer = 0;                     // which stacked item (0 = top) the erase highlight/target points at
  private eraseHover: { gx: number; gy: number } | null = null; // the cell whose target is currently highlighted
  private eraseTarget: THREE.Mesh | null = null;                // the mesh tinted red (would be deleted on click)
  private eraseTargetColor = new THREE.Color();                 // its colour before the red tint, to restore
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private txBefore: Map<string, Cell | null> | null = null;     // before-snapshots for the action being recorded
  private static readonly HISTORY_CAP = 100;
  onHistory?: (canUndo: boolean, canRedo: boolean) => void;     // UI enables/disables its undo/redo affordances
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  /** Build toolbar: erasing is a mode on touch (no right-click); right-click still erases on desktop. */
  setBuildMode(mode: 'place' | 'erase') { this.buildMode = mode; if (mode !== 'erase') this.clearEraseHighlight(); this.eraseLayer = 0; if (this.hovering && this.lastHover && this.brush) this.moveGhost(this.lastHover); }
  /** Build toolbar: rectangle-fill is a toggle on touch (no shift); shift+drag still works on desktop. */
  setRectMode(on: boolean) { this.rectMode = on; if (!on && !this.painting) { this.rectAnchor = null; this.clearRectPreview(); } }
  /** Step the erase target through the stacked items on the hovered cell (desktop keys / phone stepper). */
  cycleEraseLayer(dir: number) {
    const cell = this.eraseHover && this.cells.get(`${this.eraseHover.gx},${this.eraseHover.gy}`);
    const n = cell ? this.eraseOrder(cell).length : 0;
    if (n > 0) this.eraseLayer = ((this.eraseLayer + dir) % n + n) % n;
    if (this.eraseHover) this.updateEraseHighlight(this.eraseHover.gx, this.eraseHover.gy);
  }
  /** Phone stepper (no hover): set the erase depth directly; it is clamped to the cell's stack at delete time. */
  setEraseLayer(index: number) { this.eraseLayer = Math.max(0, index); if (this.eraseHover) this.updateEraseHighlight(this.eraseHover.gx, this.eraseHover.gy); }
  eraseLayerInfo(): { index: number; count: number } {
    const cell = this.eraseHover && this.cells.get(`${this.eraseHover.gx},${this.eraseHover.gy}`);
    return { index: this.eraseLayer, count: cell ? this.eraseOrder(cell).length : 0 };
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo() { const a = this.undoStack.pop(); if (!a) return; this.clearEraseHighlight(); if (a.kind === 'cells') { for (const [k, s] of a.before) this.applyCellSnapshot(k, s); } else a.undo(); this.redoStack.push(a); this.onHistory?.(this.canUndo(), this.canRedo()); }
  redo() { const a = this.redoStack.pop(); if (!a) return; this.clearEraseHighlight(); if (a.kind === 'cells') { for (const [k, s] of a.after) this.applyCellSnapshot(k, s); } else a.redo(); this.undoStack.push(a); this.onHistory?.(this.canUndo(), this.canRedo()); }

  // --- undo/redo transactions: each user action (place, erase, paint stroke, rectangle, clear) records a
  // before/after snapshot of every cell it touched; undo/redo swap the affected cells' meshes in the scene
  // (meshes are detached, never disposed, so they can be restored). ---
  private cloneCell(c: Cell | undefined): Cell | null { return c ? { floor: c.floor, rug: c.rug, walls: [...c.walls], furniture: [...c.furniture] } : null; }
  private cellMeshes(c: Cell): THREE.Mesh[] { return [c.floor, c.rug, ...c.walls, ...c.furniture].filter(Boolean) as THREE.Mesh[]; }
  private attachMesh(m: THREE.Mesh) { this.tileGroup.add(m); if (m.userData.billboard && this.billboards.indexOf(m) < 0) this.billboards.push(m); }
  private beginAction() { if (!this.txBefore) this.txBefore = new Map(); }
  private snapshotCell(key: string) { if (this.txBefore && !this.txBefore.has(key)) this.txBefore.set(key, this.cloneCell(this.cells.get(key))); }
  private commitAction() {
    const before = this.txBefore; this.txBefore = null; if (!before || !before.size) return;
    const after = new Map<string, Cell | null>();
    let changed = false;
    for (const key of before.keys()) { const snap = this.cloneCell(this.cells.get(key)); after.set(key, snap); if (!changed && !this.sameCell(before.get(key) ?? null, snap)) changed = true; }
    if (!changed) return; // a no-op interaction (e.g. erase on an empty cell) records nothing
    this.undoStack.push({ kind: 'cells', before, after });
    if (this.undoStack.length > CharacterEngine.HISTORY_CAP) this.undoStack.shift();
    this.redoStack = [];
    this.onHistory?.(this.canUndo(), this.canRedo());
  }
  private sameCell(a: Cell | null, b: Cell | null): boolean {
    if (!a || !b) return a === b;
    return a.floor === b.floor && a.rug === b.rug && a.walls.length === b.walls.length && a.furniture.length === b.furniture.length
      && a.walls.every((m, i) => m === b.walls[i]) && a.furniture.every((m, i) => m === b.furniture[i]);
  }
  private applyCellSnapshot(key: string, snap: Cell | null) {
    const cur = this.cells.get(key); if (cur) for (const m of this.cellMeshes(cur)) this.dropMesh(m);
    if (snap) { const cell: Cell = { floor: snap.floor, rug: snap.rug, walls: [...snap.walls], furniture: [...snap.furniture] }; this.cells.set(key, cell); for (const m of this.cellMeshes(cell)) this.attachMesh(m); }
    else this.cells.delete(key);
  }

  // place, or in erase mode delete a stacked item: `cycle` picks the highlighted layer (single click/tap),
  // otherwise the top (used while dragging across many cells)
  private act(gx: number, gy: number, cycle = false) { if (this.buildMode === 'erase') this.eraseAt(gx, gy, cycle ? this.eraseLayer : 0); else this.placeBrush(gx, gy); }
  // Holding shift mid-stroke locks placement to one grid axis (from the cell where shift engaged), so a row
  // of walls stays straight instead of jittering onto the squares above/below. The dominant drag delta from
  // that anchor chooses the axis; releasing shift resumes freehand.
  private axisLock(c: { gx: number; gy: number }, shift: boolean): { gx: number; gy: number } {
    if (!shift || !this.painting) { this.shiftAnchor = null; return c; }
    if (!this.shiftAnchor) this.shiftAnchor = c;
    const a = this.shiftAnchor;
    return Math.abs(c.gx - a.gx) >= Math.abs(c.gy - a.gy) ? { gx: c.gx, gy: a.gy } : { gx: a.gx, gy: c.gy };
  }
  private initTileInput(canvas: HTMLCanvasElement) {
    this.scene.add(this.tileGroup);
    const lift = (e: PointerEvent) => e.pointerType === 'touch' ? CharacterEngine.TOUCH_AIM : 0;
    // act on the cell under the pointer, but only once per cell per stroke so wiggling within a cell
    // (or crossing back over acted ones) doesn't churn meshes
    const actAt = (e: PointerEvent, cycle = false) => {
      let c = this.cellFromClient(e, lift(e)); if (!c) return;
      c = this.axisLock(c, e.shiftKey); // hold shift mid-drag to keep the line straight along one axis
      const key = `${c.gx},${c.gy}`;
      if (this.strokeCells.has(key)) return;
      this.strokeCells.add(key);
      this.act(c.gx, c.gy, cycle);
    };
    const startRect = (c: { gx: number; gy: number }) => { this.rectAnchor = c; if (this.ghost) this.ghost.visible = false; this.updateRectPreview(c.gx, c.gy, c.gx, c.gy); };
    const startPaint = () => { this.beginAction(); this.painting = true; this.strokeCells.clear(); }; // first cell honours the cycled layer; drag cells pass cycle=false = top

    canvas.addEventListener('pointerdown', (e) => {
      if (this.modal) return; // a modal is active: a press does nothing - the RELEASE confirms (pointerup), so one click can't also deselect
      if (this.pending) { this.pendingDown = { x: e.clientX, y: e.clientY }; return; } // placing a 3D prop
      if (this.editMode) { // pose editing owns input: grab a handle to drag, right-click to reset it; empty space orbits
        const h = this.handleFromHit(e);
        if (h) {
          if (e.button === 2) { this.resetHandle(h); return; } // right-click resets this limb/bone
          this.selectBone(h.bone); this.startDrag(h, e); this.renderer.domElement.style.cursor = 'grabbing';
        }
        return;
      }
      if (this.propMode && !this.brush) { // select a prop (click) or grab it to free-drag on the ground (yields to a tile brush)
        if (this.gizmo?.axis) return; // a gizmo handle: let TransformControls own it
        const hit = this.raycastProp(e, e.pointerType === 'touch');
        if (e.shiftKey || this.selectMode) { this.orbit.enabled = false; this.marquee = { x0: e.clientX, y0: e.clientY, add: true, hit, moved: false }; return; } // shift / Select mode: drag a box (or tap a prop to toggle it)
        if (e.pointerType === 'touch') { // track fingers; a 2nd finger starts a twist/pinch transform (or hands both to the camera)
          this.propPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (this.propPointers.size >= 2) {
            if (this.selection.length && !this.camLock) { const [a, b] = [...this.propPointers.values()]; this.startTouchGesture(a, b); }
            else { this.propDown = null; this.orbit.enabled = true; } // nothing selected (or camera locked): release any 1-finger grab so both fingers pan/zoom
            return;
          }
        }
        this.propDown = { x: e.clientX, y: e.clientY, obj: hit };
        if (hit) {
          this.orbit.enabled = false;
          const rec = this.props.find((r) => r.obj === hit);
          if (rec && this.selection.length > 1 && this.selection.includes(rec)) { // grab a member of a multi-selection -> move the whole group by the ground delta
            this.dragGround = this.worldFromClient(e); // captured unlifted: on touch the group hops up to the lifted aim as the drag begins
            this.dragGroup = this.selection.map((p) => ({ p, start: p.obj.position.clone(), before: this.capturePropState(p) }));
          } else {
            this.dragBeforeState = rec ? this.capturePropState(rec) : null;
            const g = this.worldFromClient(e); this.grabOffset.copy(g ? hit.position.clone().sub(g) : new THREE.Vector3()); this.grabOffset.y = 0; // unlifted grab: the prop hops above the finger on the first move
          }
        }
        return; // no hit -> orbit stays enabled and rotates
      }
      if (!this.brush) return;
      this.activePointers.add(e.pointerId);
      if (this.activePointers.size >= 2) { // a 2nd finger = navigate (makeOrbit): commit + abort any place/paint
        this.painting = false; this.strokeCells.clear(); this.commitAction();
        this.multiTouch = true; this.rectAnchor = null; this.clearRectPreview(); this.touchTap = null;
        if (this.ghost) this.ghost.visible = false; return;
      }
      this.brushDown = { x: e.clientX, y: e.clientY };
      if (e.pointerType === 'touch') { // defer: wait to see if it is a single-finger tap or drag
        this.touchTap = { x: e.clientX, y: e.clientY, cell: this.cellFromClient(e, lift(e)) };
        this.moveGhost(e, lift(e)); // show the offset ghost / erase highlight where it will land
        return;
      }
      if (e.button !== 0) return; // mouse left only (right = erase on up)
      try { canvas.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      if (this.rectMode || e.shiftKey) { const c = this.cellFromClient(e); if (c) startRect(c); }
      else { startPaint(); actAt(e, true); } // first cell honours the cycled erase layer
    });

    canvas.addEventListener('pointermove', (e) => {
      this.lastPointer = { x: e.clientX, y: e.clientY }; // reference for a modal transform started by a keypress
      if (this.modal) { this.updateModal(e.clientX, e.clientY); return; } // grab/rotate/scale follows the mouse
      if (this.marquee && (e.buttons & 1)) { // shift-drag: grow the selection box
        if (!this.marquee.moved && Math.hypot(e.clientX - this.marquee.x0, e.clientY - this.marquee.y0) >= 4) this.marquee.moved = true;
        const r = this.renderer.domElement.getBoundingClientRect();
        this.onMarquee?.({ x: Math.min(this.marquee.x0, e.clientX) - r.left, y: Math.min(this.marquee.y0, e.clientY) - r.top, w: Math.abs(e.clientX - this.marquee.x0), h: Math.abs(e.clientY - this.marquee.y0) });
        return;
      }
      if (this.pending) { if (e.pointerType === 'touch' || !(e.buttons & 3)) this.movePending(this.aimClient(e)); return; } // prop rides the cursor
      if (this.editMode) {
        if (this.drag && (e.buttons & 1)) { this.updateDrag(e); return; } // grabbing a bone: pose it (scroll dir stays locked to the grab, so a scroll burst never reverses)
        if (!(e.buttons & 1)) this.setHoverFromPointer(e); // idle: highlight the bone under the cursor
        return;
      }
      if (this.propMode && !this.brush) {
        if (e.pointerType === 'touch' && this.propPointers.has(e.pointerId)) this.propPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touchGesture) { const [a, b] = [...this.propPointers.values()]; if (a && b) this.updateTouchGesture(a, b); return; } // two-finger twist/pinch
        if (this.dragGroup && (e.buttons & 1)) { // move every selected prop by the same ground delta
          const g = this.worldFromClient(this.aimClient(e));
          if (g && this.dragGround) { const dx = g.x - this.dragGround.x, dz = g.z - this.dragGround.z; for (const it of this.dragGroup) { it.p.obj.position.set(it.start.x + dx, it.start.y, it.start.z + dz); this.groundProp(it.p.obj); this.propDragging = it.p.obj; } }
          return;
        }
        if (this.propDown?.obj && (e.buttons & 1)) {
          const o = this.propDown.obj; this.propDragging = o;
          const rec = this.props.find((r) => r.obj === o);
          if (rec?.sticky) {
            const pick = this.pickSurface(this.aimClient(e), o);
            if (pick) {
              o.position.copy(pick.point);
              const onSurface = pick.onBody || pick.propRoot;
              if (rec.align) { if (onSurface && pick.normal) o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pick.normal); else if (this.dragBeforeState) o.quaternion.copy(this.dragBeforeState.xform.quat); } // live align preview, reverting off-surface
              if (!onSurface) this.groundProp(o); else o.updateMatrixWorld(true);
              this.onPlacementHint?.(this.pickHint(pick));
            }
          }
          else { const g = this.worldFromClient(this.aimClient(e)); if (g) { o.position.set(g.x + this.grabOffset.x, o.position.y, g.z + this.grabOffset.z); this.groundProp(o); } } // free move on the ground
        }
        return;
      }
      if (!this.brush || this.multiTouch) return;
      if (this.rectAnchor) { const c = this.cellFromClient(e, lift(e)); if (c) this.updateRectPreview(this.rectAnchor.gx, this.rectAnchor.gy, c.gx, c.gy); return; }
      // touch: promote a held finger to a drag once it moves enough (a 2nd finger would have cancelled first)
      if (e.pointerType === 'touch' && this.touchTap && !this.painting && this.activePointers.size === 1
          && Math.hypot(e.clientX - this.touchTap.x, e.clientY - this.touchTap.y) >= 8) {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
        const c = this.touchTap.cell; this.touchTap = null;
        if (this.rectMode) { if (c) startRect(c); return; }
        startPaint();
        if (c) { this.strokeCells.add(`${c.gx},${c.gy}`); this.act(c.gx, c.gy, false); }
      }
      if (e.pointerType !== 'touch') { this.lastHover = { clientX: e.clientX, clientY: e.clientY }; this.hovering = true; } // remember where the mouse is, so R / 1-9 can refresh the ghost without a move
      this.moveGhost(e, lift(e), e.shiftKey);
      if (this.painting && (e.pointerType === 'touch' ? this.activePointers.size === 1 : (e.buttons & 1))) actAt(e);
    });
    canvas.addEventListener('pointerleave', () => { this.hovering = false; if (this.ghost) this.ghost.visible = false; this.clearEraseHighlight(); this.eraseHover = null; });
    canvas.addEventListener('pointercancel', (e) => { if (this.propPointers.delete(e.pointerId) && this.touchGesture && this.propPointers.size < 2) this.endTouchGesture(); }); // a cancelled finger commits/ends the gesture cleanly

    canvas.addEventListener('pointerup', (e) => {
      if (this.modal) { if (e.button === 2) this.modalCancel(); else this.modalConfirm(); return; } // the release confirms (or right-click cancels) and nothing else, so the prop stays selected
      if (this.editMode) { // finish a pose drag (or a plain click that just selected)
        this.orbit.enabled = true;
        if (this.drag) { this.commitDrag(); this.drag = null; }
        this.renderer.domElement.style.cursor = this.hoverBone ? 'grab' : '';
        return;
      }
      if (this.pending) { // drop the prop where it sits (a click/tap), or right-click to cancel
        const d = this.pendingDown; this.pendingDown = null;
        if (e.button === 2) { this.cancelPropPlacement(); return; }
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) { if (e.pointerType === 'touch') this.movePending(this.aimClient(e)); this.commitPending(); }
        return;
      }
      if (this.marquee) { // shift-drag box selects everything inside it; a shift-click toggles the one prop under the cursor
        const mq = this.marquee; this.marquee = null; this.orbit.enabled = true; this.onMarquee?.(null);
        if (mq.moved) this.selectObjs(this.propsInRect(mq.x0, mq.y0, e.clientX, e.clientY), true); // additive: shift was held
        else if (mq.hit) this.toggleSelectProp(mq.hit);
        return;
      }
      if (this.propMode && !this.brush) { // click selects (or deselects on empty); a drag was a free-move / re-stick (keep selection)
        if (e.pointerType === 'touch') { this.propPointers.delete(e.pointerId); if (this.touchGesture) { if (this.propPointers.size < 2) this.endTouchGesture(); return; } } // a finger lifted mid twist/pinch
        const d = this.propDown; this.propDown = null; this.orbit.enabled = true; this.propDragging = null; this.onPlacementHint?.(null);
        const grp = this.dragGroup; this.dragGroup = null; this.dragGround = null;
        const moved = d ? Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 5 : false;
        if (grp) { // finish a group move (or a plain click on a member -> reselect just it)
          if (moved) {
            for (const it of grp) if (it.p.attach) { const t = this.attachTarget(it.p.attach); if (t) it.p.attach.offset.copy(this.offsetFrom(t, it.p.obj)); } // re-bake attached offsets at the new pose
            this.pushMultiState(grp.map((it) => ({ p: it.p, before: it.before, after: this.capturePropState(it.p) })));
            this.refreshSelPrimary();
          } else if (d?.obj) this.selectProp(d.obj);
          this.dragBeforeState = null;
          return;
        }
        if (d) {
          if (d.obj && moved) {
            const rec = this.props.find((r) => r.obj === d.obj);
            if (rec) { this.resolveStick(rec, this.aimClient(e)); if (this.dragBeforeState) this.pushPropStateHistory(rec, this.dragBeforeState, this.capturePropState(rec)); this.refreshSel(rec); } // one drag = one undo entry
          }
          if (!moved || d.obj) this.selectProp(d.obj);
        }
        this.dragBeforeState = null;
        return;
      }
      const wasMulti = this.multiTouch;
      this.activePointers.delete(e.pointerId);
      if (this.activePointers.size === 0) this.multiTouch = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      const down = this.brushDown; this.brushDown = null;
      const wasPainting = this.painting; this.painting = false; this.strokeCells.clear();
      const rectAnchor = this.rectAnchor; this.rectAnchor = null; this.clearRectPreview();
      const tap = this.touchTap; this.touchTap = null;
      if (!this.brush || wasMulti) { if (this.ghost) this.ghost.visible = false; return; }
      if (rectAnchor) { const c = this.cellFromClient(e, lift(e)); if (c) { this.beginAction(); this.fillRect(rectAnchor.gx, rectAnchor.gy, c.gx, c.gy); } }
      else if (e.pointerType === 'touch') { if (!wasPainting && tap?.cell) { this.beginAction(); this.act(tap.cell.gx, tap.cell.gy, true); } } // a tap honours the cycled layer
      // mouse right-click erases the highlighted layer, but not when it was a pan-drag (right-drag pans)
      else if (down && e.button === 2 && !wasPainting && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
        const c = this.cellFromClient(e); if (c) { this.beginAction(); this.eraseAt(c.gx, c.gy, this.eraseLayer); }
      }
      this.commitAction(); // finalize this interaction as one undo entry
      if (e.pointerType === 'touch' && this.ghost) this.ghost.visible = false; // no hover on touch
    });
    canvas.addEventListener('contextmenu', (e) => { if (this.brush || this.pending || this.modal || this.editMode) e.preventDefault(); }); // right-click erases / cancels / resets a handle
    canvas.addEventListener('wheel', (e) => { // scroll while dragging a bone rotates it (orbit zoom is suspended mid-drag)
      if (!this.editMode || !this.drag || !this.lastPointer) return;
      e.preventDefault();
      const step = (e.ctrlKey ? 3 : 12) * Math.PI / 180; // Ctrl = fine-tune
      this.applyTwist(this.bodyBones.get(this.drag.grab), (e.deltaY < 0 ? 1 : -1) * step * (this.drag.twistDir ?? 1)); // scroll up = tip up; dir locked so continuous scroll never bounces
      this.updateDrag({ clientX: this.lastPointer.x, clientY: this.lastPointer.y }); // re-pin feet/hand so it holds
    }, { passive: false });
  }

  // Rectangle-fill preview + commit (shift+left drag). The rect spans the anchor cell to the current one
  // inclusive, clamped to RECT_MAX per axis so a runaway drag can't spawn thousands of meshes.
  private rectBounds(x0: number, y0: number, x1: number, y1: number) {
    const M = CharacterEngine.RECT_MAX - 1;
    const minX = Math.min(x0, x1), minY = Math.min(y0, y1);
    return { minX, minY, maxX: Math.min(Math.max(x0, x1), minX + M), maxY: Math.min(Math.max(y0, y1), minY + M) };
  }
  private updateRectPreview(x0: number, y0: number, x1: number, y1: number) {
    const T = CharacterEngine.TILE, { minX, minY, maxX, maxY } = this.rectBounds(x0, y0, x1, y1);
    if (!this.rectPreview) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x5b8cff, transparent: true, opacity: 0.28, depthWrite: false });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      m.rotation.x = -Math.PI / 2; m.renderOrder = 4; // above floors/rugs (1-3), below standing sprites (5)
      this.rectPreview = m; this.tileGroup.add(m);
    }
    const p = this.rectPreview;
    p.scale.set((maxX - minX + 1) * T, (maxY - minY + 1) * T, 1);
    p.position.set(((minX + maxX) / 2) * T, 0.011, ((minY + maxY) / 2) * T);
    p.visible = true;
  }
  private clearRectPreview() { if (this.rectPreview) this.rectPreview.visible = false; }
  private fillRect(x0: number, y0: number, x1: number, y1: number) {
    const { minX, minY, maxX, maxY } = this.rectBounds(x0, y0, x1, y1);
    for (let gx = minX; gx <= maxX; gx++) for (let gy = minY; gy <= maxY; gy++) this.act(gx, gy);
  }

  /** Set the tile to paint (null clears build mode). While active: show the tile-aligned iso grid
   *  (hiding the default one so there's a single grid), and lock left-drag rotate so clicks place
   *  tiles instead of dropping to orbit (right-drag pan + wheel zoom still work). */
  setBuildBrush(brush: TileBrush | null) {
    this.brush = brush;
    this.orbit.lockRotate = !!brush;
    this.rectAnchor = null; this.clearRectPreview(); // drop any in-progress rectangle drag
    this.painting = false; this.touchTap = null; this.strokeCells.clear(); this.activePointers.clear(); this.multiTouch = false;
    this.shiftAnchor = null; this.clearEraseHighlight(); this.eraseHover = null;
    if (this.ghost) { this.dropMesh(this.ghost); this.ghost = null; } // rebuilt for the new brush on next hover
    for (const g of this.ghostParts) this.dropMesh(g.mesh); this.ghostParts = [];
    if (!this.tileGrid) {
      const g = new THREE.GridHelper(CharacterEngine.TILE * 24, 24, 0x4a6a9a, 0x30425e);
      (g.material as THREE.Material).transparent = true; (g.material as THREE.Material).opacity = 0.5;
      // shift by half a cell so grid LINES fall on tile edges (tiles fill cells, not straddle crossings)
      g.position.set(CharacterEngine.TILE / 2, 0.0015, CharacterEngine.TILE / 2); this.scene.add(g); this.tileGrid = g;
    }
    this.tileGrid.visible = !!brush;
    this.grid.visible = brush ? false : !this.floorMesh; // one grid at a time
    // if the mouse is hovering a cell, re-show the ghost for the new brush immediately (so R / 1-9 update
    // the preview without needing a mouse move)
    if (brush && this.hovering && this.lastHover) this.moveGhost(this.lastHover);
  }
  clearTiles() {
    if (!this.cells.size) return;
    this.beginAction();
    for (const [key, c] of this.cells) { this.snapshotCell(key); for (const m of this.cellMeshes(c)) this.tileGroup.remove(m); }
    this.cells.clear();
    this.billboards = this.billboards.filter((m) => m === this.ghost || this.ghostParts.some((g) => g.mesh === m)); // keep only the hover ghost(s)
    this.clearEraseHighlight();
    this.commitAction();
  }
  /** Serialise every placed tile (floor/rug/walls/furniture) for a preset; textures are re-resolved by name on load. */
  tilesState(): TileSave[] {
    const out: TileSave[] = [];
    for (const [key, cell] of this.cells) {
      const [gx, gy] = key.split(',').map(Number);
      const nm = (m: THREE.Mesh) => m.userData.tileName as string | undefined;
      if (cell.floor && nm(cell.floor)) out.push({ gx, gy, name: nm(cell.floor)!, slot: 'floor' });
      if (cell.rug && nm(cell.rug)) out.push({ gx, gy, name: nm(cell.rug)!, slot: 'rug' });
      for (const w of cell.walls) if (nm(w)) out.push({ gx, gy, name: nm(w)!, slot: 'wall' });
      for (const f of cell.furniture) if (nm(f)) out.push({ gx, gy, name: nm(f)!, slot: 'furniture' }); // array order = stack order
    }
    return out;
  }
  /** Rebuild one saved tile (React resolves the texture + size from the name). No undo entry - see resetHistory(). */
  addSavedTile(gx: number, gy: number, brush: TileBrush) {
    if (!this.tileGroup.parent) this.scene.add(this.tileGroup);
    const prev = this.brush; this.brush = brush; this.placeBrush(gx, gy); this.brush = prev; // reuse the placement path (no parts on a saved brush)
  }
  /** Wipe the whole undo/redo timeline (tiles + props) - used after a preset load so it starts fresh. */
  resetHistory() { this.undoStack = []; this.redoStack = []; this.txBefore = null; this.onHistory?.(false, false); }

  // --- Phase 0: 3D prop preview + world-scale calibration (temporary, drives the browser/gizmo later) ---
  /** Load a resolved item model (glb + texture) into the scene, sitting on the ground beside the character. */
  // makeMaterial is a custom shader that samples raw UVs (it ignores texture.matrix), so a UV fix must be
  // baked into the geometry's uv attribute. Rebuild from the stored ORIGINAL uvs each time.
  private applyUvXf(uvMeshes: { geo: THREE.BufferGeometry; orig: Float32Array }[], xf: PropXf) {
    const { flipU, flipV, rot } = xf;
    const a = (rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    for (const { geo, orig } of uvMeshes) {
      const uv = geo.getAttribute('uv'); if (!uv) continue; const arr = uv.array as Float32Array;
      for (let i = 0; i < orig.length; i += 2) {
        let u = orig[i], v = orig[i + 1];
        if (flipU) u = 1 - u; if (flipV) v = 1 - v;
        if (rot) { const du = u - 0.5, dv = v - 0.5; u = 0.5 + du * cos - dv * sin; v = 0.5 + du * sin + dv * cos; }
        arr[i] = u; arr[i + 1] = v;
      }
      uv.needsUpdate = true;
    }
  }
  /** Convert glb+texture into a ready prop object (material, normals, scale, UV fix) - not yet placed. */
  private async buildProp(glb: Uint8Array, texture: Uint8Array | null, baseScale: number, subMesh?: string | null): Promise<{ obj: THREE.Object3D; uvMeshes: { geo: THREE.BufferGeometry; orig: Float32Array }[] }> {
    const obj = (await glbToGltf(glb)).scene;
    isolateSubMesh(obj, subMesh); // modular model file (e.g. one FBX of weapon parts): keep only the named part
    const tex = texture ? await bytesToTexture(texture, false) : this.white();
    const mat = makeMaterial(tex, this.lightingObj(), true);
    const uvMeshes: { geo: THREE.BufferGeometry; orig: Float32Array }[] = [];
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals();
      m.material = mat; m.frustumCulled = false;
      const uv = m.geometry.getAttribute('uv'); if (uv) uvMeshes.push({ geo: m.geometry, orig: (uv.array as Float32Array).slice() });
    });
    obj.scale.setScalar(baseScale * this.propMult);
    return { obj, uvMeshes };
  }
  private groundProp(obj: THREE.Object3D) { obj.position.y = 0; obj.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(obj); obj.position.y -= box.min.y; } // base rests on y=0
  private worldFromClient(e: { clientX: number; clientY: number }): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, hit) ? hit : null;
  }
  // --- prop undo/redo: each prop action pushes do/undo closures onto the shared history timeline ---
  private pushProp(undo: () => void, redo: () => void) {
    this.undoStack.push({ kind: 'props', undo, redo });
    if (this.undoStack.length > CharacterEngine.HISTORY_CAP) this.undoStack.shift();
    this.redoStack = [];
    this.onHistory?.(this.canUndo(), this.canRedo());
  }
  private captureXform(o: THREE.Object3D): Xform { return { pos: o.position.clone(), quat: o.quaternion.clone(), scale: o.scale.clone() }; }
  private applyXform(o: THREE.Object3D, x: Xform) { o.position.copy(x.pos); o.quaternion.copy(x.quat); o.scale.copy(x.scale); o.updateMatrixWorld(true); }
  private sameXform(a: Xform, b: Xform) { return a.pos.equals(b.pos) && a.quat.equals(b.quat) && a.scale.equals(b.scale); }
  private cloneAttach(a: PropAttach | null): PropAttach | null { return a ? { kind: a.kind, boneName: a.boneName, targetObj: a.targetObj, offset: a.offset.clone() } : null; }
  private sameAttach(a: PropAttach | null, b: PropAttach | null) { if (!a && !b) return true; if (!a || !b) return false; return a.kind === b.kind && a.boneName === b.boneName && a.targetObj === b.targetObj && a.offset.equals(b.offset); }
  private capturePropState(p: PlacedProp): PropState { return { xform: this.captureXform(p.obj), attach: this.cloneAttach(p.attach) }; }
  private applyPropState(p: PlacedProp, s: PropState) { p.attach = this.cloneAttach(s.attach); this.applyXform(p.obj, s.xform); if (this.selectedProp === p.obj) this.onPropSelect?.(this.propInfo(p)); }
  private pushPropStateHistory(p: PlacedProp, before: PropState, after: PropState) {
    if (this.sameXform(before.xform, after.xform) && this.sameAttach(before.attach, after.attach)) return; // no-op
    this.pushProp(() => this.applyPropState(p, before), () => this.applyPropState(p, after));
  }
  /** Record adding a prop (place or duplicate): undo detaches + de-lists it, redo re-attaches. Object stays alive. */
  private pushPropAdd(rec: PlacedProp) {
    this.pushProp(
      () => { this.propGroup.remove(rec.obj); const i = this.props.indexOf(rec); if (i >= 0) this.props.splice(i, 1); if (this.selectedProp === rec.obj) this.selectProp(null); },
      () => { this.propGroup.add(rec.obj); if (this.props.indexOf(rec) < 0) this.props.push(rec); },
    );
  }
  // --- sticky follow: after the pose updates, drive each attached prop from its target's world matrix ---
  private _followM = new THREE.Matrix4();
  private boneByName(name: string): THREE.Object3D | null { const skel = this.bodyMeshes[0]?.skeleton; return skel?.bones.find((b) => b.name === name) ?? null; }
  private attachTarget(a: PropAttach): THREE.Object3D | null { return a.kind === 'bone' ? this.boneByName(a.boneName || '') : (a.targetObj ?? null); }
  private updateStickyProps() {
    if (!this.props.length) return;
    for (const p of this.props) {
      const a = p.attach; if (!a || p.obj === this.propDragging || this.dragGroup?.some((d) => d.p === p) || this.modal?.items.some((it) => it.p === p) || this.touchGesture?.items.some((it) => it.p === p)) continue; // skip props the user is actively moving (drag / group-drag / modal / gesture)
      const target = this.attachTarget(a);
      if (!target) continue;
      if (a.kind === 'prop' && !this.props.some((r) => r.obj === target)) continue; // target prop was deleted: freeze until it returns
      target.updateWorldMatrix(true, false); // refresh the target's world matrix from the freshly-posed skeleton / moved prop
      this._followM.multiplyMatrices(target.matrixWorld, a.offset); // propGroup is untransformed, so target-world == prop-local
      this._followM.decompose(p.obj.position, p.obj.quaternion, p.obj.scale);
      p.obj.updateMatrixWorld(true);
    }
  }
  private isDescendantOf(o: THREE.Object3D | null, anc: THREE.Object3D): boolean { let c = o; while (c) { if (c === anc) return true; c = c.parent; } return false; }
  private nearestBone(point: THREE.Vector3): THREE.Object3D | null {
    const skel = this.bodyMeshes[0]?.skeleton; if (!skel) return null;
    let best: THREE.Object3D | null = null, bd = Infinity; const wp = new THREE.Vector3();
    for (const b of skel.bones) { b.getWorldPosition(wp); const d = wp.distanceToSquared(point); if (d < bd) { bd = d; best = b; } }
    return best;
  }
  /** Offset that reproduces the prop's current world pose relative to a target (target-local -> prop world). */
  private offsetFrom(target: THREE.Object3D, obj: THREE.Object3D): THREE.Matrix4 {
    target.updateWorldMatrix(true, false); obj.updateMatrixWorld(true);
    return new THREE.Matrix4().copy(target.matrixWorld).invert().multiply(obj.matrixWorld);
  }
  /** What the cursor is over, in priority order: character body -> another prop -> the ground plane. */
  private pickSurface(e: { clientX: number; clientY: number }, exclude: THREE.Object3D): SurfacePick | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [...this.bodyMeshes];
    for (const q of this.props) if (q.obj !== exclude) targets.push(q.obj);
    const hit = this.raycaster.intersectObjects(targets, true).find((h) => !this.isDescendantOf(h.object, exclude));
    if (hit) {
      const onBody = this.bodyMeshes.some((m) => this.isDescendantOf(hit.object, m));
      let propRoot: THREE.Object3D | null = null;
      if (!onBody) { let root: THREE.Object3D | null = hit.object; while (root && root.parent !== this.propGroup) root = root.parent; propRoot = root; }
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize() : null;
      return { point: hit.point.clone(), onBody, propRoot, normal };
    }
    const g = this.worldFromClient(e); // nothing solid under the cursor: fall back to the floor
    return g ? { point: g, onBody: false, propRoot: null, normal: new THREE.Vector3(0, 1, 0) } : null;
  }
  private pickHint(pick: SurfacePick | null): 'character' | 'prop' | 'floor' | null { return !pick ? null : pick.onBody ? 'character' : pick.propRoot ? 'prop' : 'floor'; }
  /** Position a prop at a surface pick (optionally surface-aligned) and return the attachment it implies (or null = grounded). */
  private attachFromPick(obj: THREE.Object3D, pick: SurfacePick, align: boolean): PropAttach | null {
    obj.position.copy(pick.point);
    if (align && pick.normal) obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pick.normal); // orient +Y to the surface
    if (!pick.onBody && !pick.propRoot) this.groundProp(obj); else obj.updateMatrixWorld(true);
    if (pick.onBody) { const bone = this.nearestBone(pick.point); if (bone) return { kind: 'bone', boneName: bone.name, offset: this.offsetFrom(bone, obj) }; }
    if (pick.propRoot) return { kind: 'prop', targetObj: pick.propRoot, offset: this.offsetFrom(pick.propRoot, obj) };
    return null;
  }
  /** Resolve a sticky prop's drop: attach to whatever surface it was released over, else ground + detach. */
  private resolveStick(p: PlacedProp, e: { clientX: number; clientY: number }) {
    if (!p.sticky) { p.attach = null; return; } // free move: never attaches
    const pick = this.pickSurface(e, p.obj);
    p.attach = pick ? this.attachFromPick(p.obj, pick, p.align) : null;
  }
  private attachLabel(a: PropAttach | null): string | null { return a ? (a.kind === 'bone' ? `bone: ${a.boneName}` : 'another prop') : null; }
  private propInfo(p: PlacedProp) { return { name: (p.obj.userData.propName as string) || 'prop', count: this.selection.length, texXf: { ...p.uvXf }, sticky: p.sticky, align: p.align, attached: this.attachLabel(p.attach), attachments: p.attachSel ? [...p.attachSel.entries()].map(([slot, o]) => ({ slot, partName: o.partName })) : [] }; }
  private refreshSel(p: PlacedProp) { if (this.selectedProp === p.obj) this.onPropSelect?.(this.propInfo(p)); }

  // --- selection outline: a back-face shell, expanded a hair in screen space, drawn as a thin rim ---
  private ensureOutlineMat(): THREE.ShaderMaterial {
    if (this.outlineMat) return this.outlineMat;
    this.outlineMat = new THREE.ShaderMaterial({
      uniforms: { thickness: { value: 0.006 }, color: { value: new THREE.Color(0x6ea8fe) } },
      vertexShader: 'uniform float thickness; void main(){ vec4 clip = projectionMatrix * modelViewMatrix * vec4(position,1.0); vec3 vn = normalize(normalMatrix * normal); vec2 dir = normalize((projectionMatrix * vec4(vn,0.0)).xy); clip.xy += dir * thickness * clip.w; gl_Position = clip; }',
      fragmentShader: 'uniform vec3 color; void main(){ gl_FragColor = vec4(color, 1.0); }',
      side: THREE.BackSide, depthTest: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    return this.outlineMat;
  }
  /** A geometry clone whose normals are averaged across coincident vertices, so a hard-edged mesh (a box)
   *  expands into one connected shell instead of tearing apart at the corners. */
  private smoothNormalsGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
    const g = geo.clone();
    const pos = g.getAttribute('position'), nrm = g.getAttribute('normal');
    if (!pos || !nrm) return g;
    const sum = new Map<string, [number, number, number]>();
    const key = (i: number) => `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
    for (let i = 0; i < pos.count; i++) { const k = key(i); const a = sum.get(k) || [0, 0, 0]; a[0] += nrm.getX(i); a[1] += nrm.getY(i); a[2] += nrm.getZ(i); sum.set(k, a); }
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { const a = sum.get(key(i))!; const l = Math.hypot(a[0], a[1], a[2]) || 1; out[i * 3] = a[0] / l; out[i * 3 + 1] = a[1] / l; out[i * 3 + 2] = a[2] / l; }
    g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
    return g;
  }
  private rebuildOutline() {
    this.clearOutline();
    if (!this.selection.length) return;
    const mat = this.ensureOutlineMat();
    for (const rec of this.selection) rec.obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry.getAttribute('normal')) return;
      const out = new THREE.Mesh(this.smoothNormalsGeometry(m.geometry), mat); // owns a smoothed-normal clone (disposed on clear)
      out.matrixAutoUpdate = false; out.matrixWorldAutoUpdate = false; out.matrixWorld.copy(m.matrixWorld);
      out.frustumCulled = false; out.renderOrder = -1; out.raycast = () => {}; // drawn under the prop, never picked
      this.scene.add(out);
      this.outline.push({ src: m, out });
    });
  }
  private clearOutline() { for (const { out } of this.outline) { this.scene.remove(out); out.geometry.dispose(); } this.outline = []; }
  private updateOutline() { for (const { src, out } of this.outline) out.matrixWorld.copy(src.matrixWorld); } // mirror the (possibly animated) prop each frame

  // --- Blender-style modal transforms: G/R/S grab the selected prop and it follows the mouse with no gizmo;
  //     X/Y/Z constrain to a world axis (press again to release); click / Enter confirm, right-click / Esc cancel ---
  /** Whether the interactive gizmo handles are drawn (off = Blender-style keyboard transforms only). */
  setShowGizmo(on: boolean) { this.showGizmo = on; const g = this.ensureGizmo(); if (on && this.selectedProp) g.attach(this.selectedProp); else g.detach(); }
  /** Defaults applied to newly placed props (sticky-armed / align-to-surface). */
  setStickyDefault(on: boolean) { this.stickyDefault = on; }
  setAlignDefault(on: boolean) { this.alignDefault = on; }
  private worldToScreen(v: THREE.Vector3): { x: number; y: number } {
    const p = v.clone().project(this.camera); const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
  }
  private setRayClient(cx: number, cy: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.camera);
  }
  private axisIndex(a: 'x' | 'y' | 'z') { return a === 'x' ? 0 : a === 'y' ? 1 : 2; }
  /** Parameter t of the point on the line (P + t*u) closest to the mouse ray - lets an axis-locked grab track the cursor. */
  private axisParam(P: THREE.Vector3, u: THREE.Vector3, cx: number, cy: number): number {
    this.setRayClient(cx, cy); const ray = this.raycaster.ray;
    const w0 = P.clone().sub(ray.origin), b = u.dot(ray.direction), d = u.dot(w0), eDot = ray.direction.dot(w0), denom = 1 - b * b;
    return Math.abs(denom) < 1e-6 ? d : (b * eDot - d) / denom;
  }
  private modalLabel(): string | null {
    const m = this.modal; if (!m) return null;
    const name = m.mode === 'move' ? 'Move' : m.mode === 'rotate' ? 'Rotate' : 'Scale';
    return m.axis ? `${name} ${m.axis.toUpperCase()}` : name;
  }
  startModalTransform(mode: 'move' | 'rotate' | 'scale') {
    if (this.modal || !this.propMode) return;
    const recs = this.selection; const sp = this.lastPointer; if (!recs.length || !sp) return;
    const items: ModalItem[] = recs.map((p) => ({ p, startPos: p.obj.position.clone(), startQuat: p.obj.quaternion.clone(), startScale: p.obj.scale.clone(), before: this.capturePropState(p) }));
    const pivot = new THREE.Vector3();
    for (const it of items) pivot.add(it.startPos);
    pivot.multiplyScalar(1 / items.length);
    const viewDir = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, pivot);
    this.setRayClient(sp.x, sp.y);
    const planeStart = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, planeStart)) planeStart.copy(pivot);
    const center = this.worldToScreen(pivot);
    this.modal = {
      mode, axis: null, items, pivot, plane, planeStart, center,
      startAngle: Math.atan2(sp.y - center.y, sp.x - center.x), startDist: Math.hypot(sp.x - center.x, sp.y - center.y) || 1, axisT0: 0,
    };
    this.propDragging = null; this.orbit.enabled = false; // sticky-follow is suspended for all modal items (see updateStickyProps)
    if (this.gizmo) this.gizmo.enabled = false; // don't let a gizmo handle also react to the confirming click
    this.onModalChange?.(this.modalLabel());
  }
  modalSetAxis(axis: 'x' | 'y' | 'z') {
    const m = this.modal; if (!m) return;
    m.axis = m.axis === axis ? null : axis; // pressing the same axis again clears the constraint
    if (m.axis && m.mode === 'move' && this.lastPointer) m.axisT0 = this.axisParam(m.pivot, CharacterEngine.MODAL_AXIS[m.axis], this.lastPointer.x, this.lastPointer.y);
    if (this.lastPointer) this.updateModal(this.lastPointer.x, this.lastPointer.y);
    this.onModalChange?.(this.modalLabel());
  }
  private updateModal(cx: number, cy: number) {
    const m = this.modal; if (!m) return;
    if (m.mode === 'move') {
      const delta = new THREE.Vector3();
      if (!m.axis) { this.setRayClient(cx, cy); const pt = new THREE.Vector3(); if (!this.raycaster.ray.intersectPlane(m.plane, pt)) return; delta.copy(pt).sub(m.planeStart); }
      else { const u = CharacterEngine.MODAL_AXIS[m.axis]; delta.copy(u).multiplyScalar(this.axisParam(m.pivot, u, cx, cy) - m.axisT0); }
      for (const it of m.items) { it.p.obj.position.copy(it.startPos).add(delta); it.p.obj.updateMatrixWorld(true); }
    } else if (m.mode === 'rotate') {
      const angle = Math.atan2(cy - m.center.y, cx - m.center.x) - m.startAngle;
      const viewDir = this.camera.getWorldDirection(new THREE.Vector3());
      const axisDir = m.axis ? CharacterEngine.MODAL_AXIS[m.axis] : viewDir;
      const sign = m.axis ? (Math.sign(axisDir.dot(viewDir)) || 1) : 1; // keep screen-clockwise = clockwise as seen
      const q = new THREE.Quaternion().setFromAxisAngle(axisDir, angle * sign);
      for (const it of m.items) {
        it.p.obj.position.copy(it.startPos).sub(m.pivot).applyQuaternion(q).add(m.pivot); // orbit each around the shared pivot
        it.p.obj.quaternion.copy(q).multiply(it.startQuat);
        it.p.obj.updateMatrixWorld(true);
      }
    } else {
      const f = Math.hypot(cx - m.center.x, cy - m.center.y) / m.startDist;
      const i = m.axis ? this.axisIndex(m.axis) : -1;
      for (const it of m.items) {
        const o = it.p.obj;
        if (i < 0) { o.position.copy(it.startPos).sub(m.pivot).multiplyScalar(f).add(m.pivot); o.scale.copy(it.startScale).multiplyScalar(f); }
        else { o.position.copy(it.startPos); o.position.setComponent(i, m.pivot.getComponent(i) + (it.startPos.getComponent(i) - m.pivot.getComponent(i)) * f); o.scale.copy(it.startScale); o.scale.setComponent(i, it.startScale.getComponent(i) * f); }
        o.updateMatrixWorld(true);
      }
    }
  }
  private pushMultiState(entries: { p: PlacedProp; before: PropState; after: PropState }[]) {
    const changed = entries.filter((e) => !this.sameXform(e.before.xform, e.after.xform) || !this.sameAttach(e.before.attach, e.after.attach));
    if (!changed.length) return;
    this.pushProp(() => { for (const e of changed) this.applyPropState(e.p, e.before); }, () => { for (const e of changed) this.applyPropState(e.p, e.after); });
  }
  modalConfirm() {
    const m = this.modal; if (!m) return;
    this.modal = null; this.propDragging = null; this.orbit.enabled = true; if (this.gizmo) this.gizmo.enabled = true;
    for (const it of m.items) if (it.p.attach) { const t = this.attachTarget(it.p.attach); if (t) it.p.attach.offset.copy(this.offsetFrom(t, it.p.obj)); } // re-bake offsets for attached props
    this.pushMultiState(m.items.map((it) => ({ p: it.p, before: it.before, after: this.capturePropState(it.p) })));
    this.refreshSelPrimary(); this.onModalChange?.(null);
  }
  modalCancel() {
    const m = this.modal; if (!m) return;
    this.modal = null; this.propDragging = null; this.orbit.enabled = true; if (this.gizmo) this.gizmo.enabled = true;
    for (const it of m.items) this.applyPropState(it.p, it.before);
    this.refreshSelPrimary(); this.onModalChange?.(null);
  }
  private refreshSelPrimary() { const p = this.selection[this.selection.length - 1]; if (p) this.refreshSel(p); }

  // --- Two-finger touch transform: twist rotates + pinch scales the whole selection around its centroid ---
  /** Mobile: keep two-finger gestures on the camera even while a prop is selected (frame the shot without deselecting). */
  setCameraLock(on: boolean) { this.camLock = on; }
  /** Mobile: a tap toggles a prop in/out of the selection and a drag draws a marquee, instead of moving props. */
  setSelectMode(on: boolean) { this.selectMode = on; }
  private startTouchGesture(a: { x: number; y: number }, b: { x: number; y: number }) {
    const recs = this.selection; if (!recs.length) return;
    const items: ModalItem[] = recs.map((p) => ({ p, startPos: p.obj.position.clone(), startQuat: p.obj.quaternion.clone(), startScale: p.obj.scale.clone(), before: this.capturePropState(p) }));
    const pivot = new THREE.Vector3();
    for (const it of items) pivot.add(it.startPos);
    pivot.multiplyScalar(1 / items.length);
    this.touchGesture = { items, pivot, startAngle: Math.atan2(b.y - a.y, b.x - a.x), startDist: Math.hypot(b.x - a.x, b.y - a.y) || 1 };
    this.propDown = null; this.dragGroup = null; this.dragGround = null; this.propDragging = null; this.orbit.enabled = false; // drop any single-finger drag the first finger started
  }
  private updateTouchGesture(a: { x: number; y: number }, b: { x: number; y: number }) {
    const g = this.touchGesture; if (!g) return;
    const angle = Math.atan2(b.y - a.y, b.x - a.x) - g.startAngle;
    const f = (Math.hypot(b.x - a.x, b.y - a.y) || 1) / g.startDist;
    const q = new THREE.Quaternion().setFromAxisAngle(this.camera.getWorldDirection(new THREE.Vector3()), angle); // twist about the view axis
    const off = new THREE.Vector3();
    for (const it of g.items) {
      off.copy(it.startPos).sub(g.pivot).multiplyScalar(f).applyQuaternion(q); // scale + rotate the offset about the shared pivot
      it.p.obj.position.copy(g.pivot).add(off);
      it.p.obj.quaternion.copy(q).multiply(it.startQuat);
      it.p.obj.scale.copy(it.startScale).multiplyScalar(f);
      it.p.obj.updateMatrixWorld(true);
    }
  }
  private endTouchGesture() {
    const g = this.touchGesture; if (!g) return;
    this.touchGesture = null; this.orbit.enabled = true;
    for (const it of g.items) if (it.p.attach) { const t = this.attachTarget(it.p.attach); if (t) it.p.attach.offset.copy(this.offsetFrom(t, it.p.obj)); } // re-bake offsets for attached props
    this.pushMultiState(g.items.map((it) => ({ p: it.p, before: it.before, after: this.capturePropState(it.p) })));
    this.refreshSelPrimary();
  }
  /** Phase-0 helper: drop a prop in a row beside the character (used by the temp calibration buttons). */
  async addProp(glb: Uint8Array, texture: Uint8Array | null, baseScale: number, name: string, subMesh?: string | null): Promise<void> {
    if (!this.propGroup.parent) this.scene.add(this.propGroup);
    const { obj, uvMeshes } = await this.buildProp(glb, texture, baseScale, subMesh);
    obj.position.set((this.props.length - 1.5) * 0.35, 0, 0.6);
    this.propGroup.add(obj); this.groundProp(obj);
    this.props.push({ id: this.nextPropId(), obj, baseScale, uvMeshes, uvXf: { flipU: false, flipV: false, rot: 0 }, sticky: false, align: false, attach: null });
    const s = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
    console.log(`[prop] ${name}: base=${baseScale} mult=${this.propMult.toFixed(3)} -> ${s.x.toFixed(3)}x${s.y.toFixed(3)}x${s.z.toFixed(3)} units`);
  }
  /** Start cursor-attach placement: the prop rides the cursor until a click drops it (right-click cancels). */
  async beginPropPlacement(glb: Uint8Array, texture: Uint8Array | null, baseScale: number, name: string, subMesh?: string | null): Promise<void> {
    if (!this.propGroup.parent) this.scene.add(this.propGroup);
    this.cancelPropPlacement();
    this.selectProp(null); // clean state while placing: only the hint shows, no stale inspector/gizmo
    const { obj, uvMeshes } = await this.buildProp(glb, texture, baseScale, subMesh);
    obj.userData.propName = name;
    this.propGroup.add(obj); this.groundProp(obj);
    this.pending = { obj, uvMeshes, baseScale };
  }
  cancelPropPlacement() { if (this.pending) { this.propGroup.remove(this.pending.obj); this.pending.obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); this.pending = null; } this.pendingDown = null; this.pendingPick = null; this.onPlacementHint?.(null); }
  /** The riding prop tracks whatever is under the cursor (character surface -> prop -> floor), with a live hint. */
  private movePending(e: { clientX: number; clientY: number }) {
    if (!this.pending) return;
    const pick = this.pickSurface(e, this.pending.obj); if (!pick) return;
    const o = this.pending.obj; o.position.copy(pick.point);
    const onSurface = pick.onBody || pick.propRoot;
    if (this.alignDefault) { if (onSurface && pick.normal) o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pick.normal); else o.quaternion.identity(); } // live align preview
    if (!onSurface) this.groundProp(o); else o.updateMatrixWorld(true);
    this.pendingPick = pick;
    this.onPlacementHint?.(this.pickHint(pick));
  }
  private commitPending() {
    if (!this.pending) return;
    const rec: PlacedProp = { id: this.nextPropId(), obj: this.pending.obj, baseScale: this.pending.baseScale, uvMeshes: this.pending.uvMeshes, uvXf: { flipU: false, flipV: false, rot: 0 }, sticky: this.stickyDefault, align: this.alignDefault, attach: null };
    // dropped onto the character or another prop: auto-stick + follow, so it lands exactly where you aimed
    const pick = this.pendingPick;
    if (pick && (pick.onBody || pick.propRoot)) { rec.attach = this.attachFromPick(rec.obj, pick, this.alignDefault); rec.sticky = true; }
    this.props.push(rec);
    this.pushPropAdd(rec);
    this.pending = null; this.pendingDown = null; this.pendingPick = null; this.onPlacementHint?.(null);
    this.selectProp(rec.obj); // the just-placed prop is selected + ready to nudge
  }

  // --- prop selection + move/rotate/scale gizmo ---
  private ensureGizmo(): TransformControls {
    if (this.gizmo) return this.gizmo;
    const g = new TransformControls(this.camera, this.renderer.domElement);
    // strip TransformControls down to the 3 single-axis handles (drop the plane + centre + free handles):
    // remove them from the visual + picker groups once (they're built in the constructor, never rebuilt).
    const keep: Record<string, Set<string>> = { translate: new Set(['X', 'Y', 'Z']), rotate: new Set(['X', 'Y', 'Z']), scale: new Set(['X', 'Y', 'Z', 'XYZ']) };
    const inner = (g as unknown as { _gizmo?: { gizmo: Record<string, THREE.Object3D>; picker: Record<string, THREE.Object3D> } })._gizmo;
    if (inner) for (const mode of ['translate', 'rotate', 'scale']) for (const grp of [inner.gizmo[mode], inner.picker[mode]]) { if (grp) for (const c of [...grp.children]) if (!keep[mode].has(c.name)) grp.remove(c); }
    // pointerdown fires before makeOrbit's mousedown, so this flips orbit off before it can start a rotate.
    // Also bracket the drag with a transform snapshot so one gizmo drag = one undo entry.
    g.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.orbit.enabled = !dragging;
      const p = this.selectedProp ? this.props.find((r) => r.obj === this.selectedProp) : null;
      if (dragging) { this.gizmoBeforeState = p ? this.capturePropState(p) : null; this.propDragging = p ? p.obj : null; }
      else if (p && this.gizmoBeforeState) {
        this.propDragging = null;
        if (p.attach) { const t = this.attachTarget(p.attach); if (t) p.attach.offset.copy(this.offsetFrom(t, p.obj)); } // re-bake fine-tuned offset
        this.pushPropStateHistory(p, this.gizmoBeforeState, this.capturePropState(p));
        this.gizmoBeforeState = null;
      } else this.propDragging = null;
    });
    this.scene.add(g.getHelper());
    this.gizmo = g;
    return g;
  }
  /** Entering/leaving the 3D Props sub-tab: enable prop clicks + point the gizmo at the current camera. */
  setPropMode(on: boolean) { this.propMode = on; this.propPointers.clear(); this.touchGesture = null; if (on) this.ensureGizmo().camera = this.camera; else { this.modalCancel(); this.selectProp(null); } }
  setGizmoMode(mode: 'translate' | 'rotate' | 'scale') { this.ensureGizmo().setMode(mode); }
  /** On touch, lift the aim above the fingertip (beat occlusion) so selection / drag / placement land where you look. */
  private aimClient(e: { clientX: number; clientY: number; pointerType?: string }): { clientX: number; clientY: number } {
    return e.pointerType === 'touch' ? { clientX: e.clientX, clientY: e.clientY - CharacterEngine.TOUCH_AIM } : { clientX: e.clientX, clientY: e.clientY };
  }
  private raycastProp(e: { clientX: number; clientY: number }, touch = false): THREE.Object3D | null {
    if (!this.props.length) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const targets = this.props.map((p) => p.obj);
    const cx = e.clientX, cy = e.clientY; // tap directly on the prop; the fingertip ring below forgives near-misses
    const tryAt = (px: number, py: number): { obj: THREE.Object3D; dist: number } | null => {
      this.raycaster.setFromCamera(new THREE.Vector2(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1), this.camera);
      const hit = this.raycaster.intersectObjects(targets, true)[0];
      if (!hit) return null;
      let o: THREE.Object3D | null = hit.object; while (o && o.parent !== this.propGroup) o = o.parent; // walk up to the prop root
      return o ? { obj: o, dist: hit.distance } : null;
    };
    const center = tryAt(cx, cy);
    if (center || !touch) return center?.obj ?? null;
    let best: { obj: THREE.Object3D; dist: number } | null = null; // touch miss: sample a fingertip-radius ring, take the nearest prop
    const R = CharacterEngine.TOUCH_PICK_R;
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const h = tryAt(cx + Math.cos(a) * R, cy + Math.sin(a) * R); if (h && (!best || h.dist < best.dist)) best = h; }
    return best?.obj ?? null;
  }
  /** Replace the selection with a single prop (or clear it). */
  selectProp(obj: THREE.Object3D | null) {
    const rec = obj ? this.props.find((p) => p.obj === obj) : null;
    this.applySelection(rec ? [rec] : []);
  }
  /** Shift-click: add the prop to the selection, or remove it if already selected. */
  toggleSelectProp(obj: THREE.Object3D) {
    const rec = this.props.find((p) => p.obj === obj); if (!rec) return;
    this.applySelection(this.selection.includes(rec) ? this.selection.filter((r) => r !== rec) : [...this.selection, rec]);
  }
  /** Marquee: select these props (additive keeps the current selection). */
  selectObjs(objs: THREE.Object3D[], additive: boolean) {
    const recs = objs.map((o) => this.props.find((p) => p.obj === o)).filter(Boolean) as PlacedProp[];
    if (!additive) { this.applySelection(recs); return; }
    const merged = [...this.selection];
    for (const r of recs) if (!merged.includes(r)) merged.push(r);
    this.applySelection(merged);
  }
  /** Props whose bounding-box centre projects to a screen point inside the client-px box. */
  private propsInRect(x0: number, y0: number, x1: number, y1: number): THREE.Object3D[] {
    const r = this.renderer.domElement.getBoundingClientRect();
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const c = new THREE.Vector3(), box = new THREE.Box3(), out: THREE.Object3D[] = [];
    for (const p of this.props) {
      box.setFromObject(p.obj); if (box.isEmpty()) continue;
      box.getCenter(c).project(this.camera); if (c.z >= 1) continue; // behind the camera
      const sx = r.left + (c.x * 0.5 + 0.5) * r.width, sy = r.top + (-c.y * 0.5 + 0.5) * r.height;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) out.push(p.obj);
    }
    return out;
  }
  private applySelection(recs: PlacedProp[]) {
    this.selection = recs;
    const primary = recs.length ? recs[recs.length - 1] : null;
    this.selectedProp = primary ? primary.obj : null;
    const g = this.ensureGizmo();
    if (primary && recs.length === 1 && this.showGizmo) g.attach(primary.obj); else g.detach(); // draggable handles are single-select only
    this.rebuildOutline();
    this.onPropSelect?.(primary ? this.propInfo(primary) : null);
  }
  deleteSelectedProp() {
    const recs = this.selection.slice(); if (!recs.length) return;
    this.applySelection([]);
    for (const rec of recs) { this.propGroup.remove(rec.obj); const i = this.props.indexOf(rec); if (i >= 0) this.props.splice(i, 1); } // detached, not disposed, so undo can restore them
    this.pushProp(
      () => { for (const rec of recs) { this.propGroup.add(rec.obj); if (this.props.indexOf(rec) < 0) this.props.push(rec); } },
      () => { for (const rec of recs) { this.propGroup.remove(rec.obj); const j = this.props.indexOf(rec); if (j >= 0) this.props.splice(j, 1); } this.applySelection(this.selection.filter((r) => !recs.includes(r))); },
    );
  }
  /** Live-rescale every placed prop (calibration slider). */
  setPropMult(m: number) {
    this.propMult = m;
    for (const p of this.props) { p.obj.position.y = 0; p.obj.scale.setScalar(p.baseScale * m); p.obj.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(p.obj); p.obj.position.y -= box.min.y; }
  }
  /** Per-prop UV fix (flip U / flip V / rotate) baked into the selected prop's uv attribute, for outlier meshes. */
  setSelectedPropTexXf(xf: PropXf) {
    const o = this.selectedProp; if (!o) return;
    const p = this.props.find((r) => r.obj === o); if (!p) return;
    const before = { ...p.uvXf };
    const apply = (v: PropXf) => { p.uvXf = { ...v }; this.applyUvXf(p.uvMeshes, p.uvXf); this.refreshSel(p); };
    apply(xf);
    this.pushProp(() => apply(before), () => apply(xf));
  }
  /** Clone one prop (own geometry so a later UV fix stays independent) into the scene, nudged, with its parts re-mounted. */
  private cloneProp(src: PlacedProp): PlacedProp {
    const obj = src.obj.clone(true);
    const stale: THREE.Object3D[] = []; // drop the shared-clone weapon parts; the copy re-mounts its own below
    obj.traverse((o) => { if (o.userData.isAttachment) stale.push(o); });
    for (const s of stale) s.parent?.remove(s);
    const uvMeshes: { geo: THREE.BufferGeometry; orig: Float32Array }[] = [];
    let k = 0;
    obj.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      m.geometry = m.geometry.clone(); // detach from the source so a later UV fix on either doesn't cross over
      if (m.geometry.getAttribute('uv')) { uvMeshes.push({ geo: m.geometry, orig: src.uvMeshes[k].orig.slice() }); k++; }
    });
    obj.userData.propName = src.obj.userData.propName;
    obj.position.copy(src.obj.position); obj.scale.copy(src.obj.scale); obj.rotation.copy(src.obj.rotation);
    this.propGroup.add(obj);
    obj.position.x += 0.2; obj.position.z += 0.2; // nudge so the copy is visible
    this.groundProp(obj);
    const rec: PlacedProp = { id: this.nextPropId(), obj, baseScale: src.baseScale, uvMeshes, uvXf: { ...src.uvXf }, sticky: src.sticky, align: src.align, attach: null }; // copy inherits toggles but starts detached
    this.props.push(rec);
    if (rec.uvXf.flipU || rec.uvXf.flipV || rec.uvXf.rot) this.applyUvXf(uvMeshes, rec.uvXf);
    if (src.attachSel?.size) { const sel = [...src.attachSel.entries()]; void (async () => { for (const [slot, opt] of sel) await this.mountPropPart(rec, slot, opt); if (this.selectedProp === rec.obj) { this.rebuildOutline(); this.refreshSel(rec); } })(); }
    return rec;
  }
  /** Duplicate every selected prop and select the copies. */
  duplicateSelectedProp() {
    const srcs = this.selection.slice(); if (!srcs.length) return;
    const copies = srcs.map((src) => this.cloneProp(src));
    this.pushProp(
      () => { for (const rec of copies) { this.propGroup.remove(rec.obj); const i = this.props.indexOf(rec); if (i >= 0) this.props.splice(i, 1); } this.applySelection(this.selection.filter((r) => !copies.includes(r))); },
      () => { for (const rec of copies) { this.propGroup.add(rec.obj); if (this.props.indexOf(rec) < 0) this.props.push(rec); } },
    );
    this.applySelection(copies);
  }
  /** Reset every selected prop's rotation to 0 and scale to its calibrated default, keeping its footprint position. */
  resetSelectedProp() {
    const recs = this.selection.slice(); if (!recs.length) return;
    const entries = recs.map((p) => {
      const before = this.capturePropState(p);
      p.obj.rotation.set(0, 0, 0); p.obj.scale.setScalar(p.baseScale * this.propMult); this.groundProp(p.obj);
      if (p.attach) { const t = this.attachTarget(p.attach); if (t) p.attach.offset.copy(this.offsetFrom(t, p.obj)); } // keep following at the reset pose
      return { p, before, after: this.capturePropState(p) };
    });
    this.pushMultiState(entries);
    this.refreshSelPrimary();
  }
  /** Inspector: arm/disarm sticky on every selected prop. Disarming detaches. */
  setSelectedPropSticky(on: boolean) {
    const recs = this.selection.filter((p) => p.sticky !== on); if (!recs.length) return;
    const prev = recs.map((p) => ({ p, attach: this.cloneAttach(p.attach) }));
    for (const p of recs) { p.sticky = on; if (!on) p.attach = null; }
    this.pushProp(
      () => { for (const e of prev) { e.p.sticky = !on; e.p.attach = this.cloneAttach(e.attach); } this.refreshSelPrimary(); },
      () => { for (const e of prev) { e.p.sticky = on; if (!on) e.p.attach = null; } this.refreshSelPrimary(); },
    );
    this.refreshSelPrimary();
  }
  /** Inspector: whether the next attach orients each selected prop to the surface normal (vs keeps its rotation). */
  setSelectedPropAlign(on: boolean) {
    const recs = this.selection.filter((p) => p.align !== on); if (!recs.length) return;
    for (const p of recs) p.align = on;
    this.pushProp(() => { for (const p of recs) p.align = !on; this.refreshSelPrimary(); }, () => { for (const p of recs) p.align = on; this.refreshSelPrimary(); });
    this.refreshSelPrimary();
  }
  /** Inspector: release the attachment on every selected prop; the props stay where they are. */
  detachSelectedProp() {
    const recs = this.selection.filter((p) => p.attach); if (!recs.length) return;
    const prev = recs.map((p) => ({ p, attach: this.cloneAttach(p.attach) }));
    for (const p of recs) p.attach = null;
    this.pushProp(() => { for (const e of prev) e.p.attach = this.cloneAttach(e.attach); this.refreshSelPrimary(); }, () => { for (const e of prev) e.p.attach = null; this.refreshSelPrimary(); });
    this.refreshSelPrimary();
  }
  /** Mount (option) or clear (null) a weapon part in a slot of the selected prop - a child of the prop mesh, so
   *  it inherits every transform + sticky-follow. Mirrors setHeldAttachment but keyed to the placed prop. */
  async setPropAttachment(slot: string, option: AttachOption | null) {
    const target = this.selectedProp; if (!target) return;
    const p = this.props.find((r) => r.obj === target); if (!p) return;
    const before = p.attachSel?.get(slot) ?? null; // prior part in this slot, for undo
    await this.applyPropAttachment(p, slot, option);
    if ((before?.partName ?? null) !== (option?.partName ?? null)) { // a real change: record it (re-mounts are async but self-consistent)
      this.pushProp(() => { void this.applyPropAttachment(p, slot, before); }, () => { void this.applyPropAttachment(p, slot, option); });
    }
  }
  /** Mount/clear a weapon part and refresh the selection rim + inspector (the undoable unit). */
  private async applyPropAttachment(p: PlacedProp, slot: string, option: AttachOption | null) {
    await this.mountPropPart(p, slot, option);
    if (this.selectedProp === p.obj) this.rebuildOutline();
    this.refreshSel(p);
  }
  private async mountPropPart(p: PlacedProp, slot: string, option: AttachOption | null) {
    if (!p.parts) p.parts = new Map(); if (!p.attachSel) p.attachSel = new Map();
    const prev = p.parts.get(slot);
    if (prev) { prev.parent?.remove(prev); prev.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); p.parts.delete(slot); p.attachSel.delete(slot); }
    if (!option) return;
    const r = await resolveAttachmentPart(this.ctx, option);
    if (r.error || !this.props.includes(p)) return; // failed, or the prop was deleted mid-load
    const obj = (await glbToGltf(r.meshGlb)).scene;
    isolateSubMesh(obj, r.subMesh);
    const mat = makeMaterial(r.texture ? await bytesToTexture(r.texture, false) : this.white(), this.lightingObj(), true);
    obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
    const holder = new THREE.Object3D();
    holder.matrixAutoUpdate = false; holder.matrix.copy(partMatrix(r.parentAttachment, r.selfAttachment)); // socket transform in model space
    holder.userData.isAttachment = true; holder.add(obj);
    p.obj.add(holder); // child of the prop root: follows scale, sticky-follow, gizmo/modal edits
    p.parts.set(slot, holder); p.attachSel.set(slot, option);
  }
  clearProps() {
    for (const p of this.props) { this.propGroup.remove(p.obj); p.obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); }
    this.props = [];
    this.pendingPropLinks = [];
    this.selectProp(null);
    // prop commands now reference disposed/detached objects; drop them but keep the tile (cell) timeline
    this.undoStack = this.undoStack.filter((e) => e.kind !== 'props');
    this.redoStack = this.redoStack.filter((e) => e.kind !== 'props');
    this.onHistory?.(this.canUndo(), this.canRedo());
  }
  private nextPropId(): string { return 'p' + (++this.propSeq); }

  // --- prop persistence (into a preset): serialise every placed prop, and rebuild them on load ---
  /** Serialise all placed props (transform + flags + sticky-attach offset + weapon parts) for a preset. */
  propsState(): PropSave[] {
    const idOf = (obj: THREE.Object3D | null | undefined) => this.props.find((p) => p.obj === obj)?.id ?? '';
    return this.props.map((p) => ({
      item: (p.obj.userData.propName as string) || 'prop', id: p.id,
      pos: p.obj.position.toArray(), quat: p.obj.quaternion.toArray(), scl: p.obj.scale.toArray(),
      uvXf: { ...p.uvXf }, sticky: p.sticky, align: p.align,
      attach: !p.attach ? null : p.attach.kind === 'bone'
        ? { kind: 'bone', boneName: p.attach.boneName ?? '', offset: p.attach.offset.toArray() }
        : { kind: 'prop', targetId: idOf(p.attach.targetObj), offset: p.attach.offset.toArray() },
      attachments: p.attachSel ? [...p.attachSel.entries()].map(([slot, o]) => ({ slot, partName: o.partName })) : [],
    }));
  }
  /** Rebuild one saved prop. Call relinkPropAttachments() once after loading them all (for prop->prop sticky). */
  async addSavedProp(input: SavedPropInput): Promise<void> {
    if (!this.propGroup.parent) this.scene.add(this.propGroup);
    const { glb, texture, subMesh, baseScale, save, attachments } = input;
    const { obj, uvMeshes } = await this.buildProp(glb, texture, baseScale, subMesh);
    obj.userData.propName = save.item;
    obj.position.fromArray(save.pos); obj.quaternion.fromArray(save.quat); obj.scale.fromArray(save.scl); obj.updateMatrixWorld(true);
    this.propGroup.add(obj);
    const rec: PlacedProp = { id: save.id, obj, baseScale, uvMeshes, uvXf: { ...save.uvXf }, sticky: save.sticky, align: save.align, attach: null };
    if (save.uvXf.flipU || save.uvXf.flipV || save.uvXf.rot) this.applyUvXf(uvMeshes, rec.uvXf);
    this.props.push(rec);
    const n = parseInt(save.id.replace(/\D/g, ''), 10); if (n > this.propSeq) this.propSeq = n; // don't reuse a loaded id
    if (save.attach?.kind === 'bone') rec.attach = { kind: 'bone', boneName: save.attach.boneName, offset: new THREE.Matrix4().fromArray(save.attach.offset) };
    else if (save.attach?.kind === 'prop') { rec.attach = { kind: 'prop', targetObj: null, offset: new THREE.Matrix4().fromArray(save.attach.offset) }; this.pendingPropLinks.push({ rec, targetId: save.attach.targetId }); }
    for (const a of attachments) await this.mountPropPart(rec, a.slot, a.option);
  }
  /** After a batch of addSavedProp, wire each prop->prop sticky-attach to its target by id (drop if missing). */
  relinkPropAttachments() {
    for (const link of this.pendingPropLinks) {
      const target = this.props.find((r) => r.id === link.targetId);
      if (target && link.rec.attach) link.rec.attach.targetObj = target.obj; else link.rec.attach = null;
    }
    this.pendingPropLinks = [];
  }
  private dropMesh(m: THREE.Mesh) { this.tileGroup.remove(m); const i = this.billboards.indexOf(m); if (i >= 0) this.billboards.splice(i, 1); }

  private cellFromClient(e: { clientX: number; clientY: number }, aimLift = 0): { gx: number; gy: number } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - aimLift - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    const T = CharacterEngine.TILE;
    return { gx: Math.round(hit.x / T), gy: Math.round(hit.z / T) };
  }
  private flatQuad(tex: THREE.Texture, y: number, order: number, opacity = 1): THREE.Mesh {
    const T = CharacterEngine.TILE;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.4, opacity, depthWrite: false });
    mat.color.setScalar(this.light.ambient);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(T, T), mat);
    m.rotation.x = -Math.PI / 2; m.position.y = y; m.renderOrder = order;
    return m;
  }
  // A standing sprite (wall/furniture): a camera-facing quad sized from the authored px, its footprint
  // anchored on the ground. Its base overhangs the tile's front half (below the cell origin), so it must
  // render OVER the floor/rug tiles (renderOrder 1-3) or the floor's near half clips its bottom corners.
  // We draw it in the transparent pass at a higher renderOrder but keep depthWrite (as an alphaTest
  // cutout) so it still depth-sorts against the character and other standing sprites.
  private makeBillboard(tex: THREE.Texture, fullW: number, fullH: number, anchor: number, opacity = 1): THREE.Mesh {
    const w = fullW * CharacterEngine.OBJ_PX, h = fullH * CharacterEngine.OBJ_PX;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.translate(0, h * (0.5 - anchor), 0); // the sprite's cell origin sits at the mesh origin (the cell)
    const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, transparent: true, opacity, depthWrite: opacity >= 1 });
    mat.color.setScalar(this.light.ambient);
    const m = new THREE.Mesh(geo, mat); m.userData.billboard = true;
    m.renderOrder = opacity >= 1 ? 5 : 6; // above floors/rugs; ghost (6) above placed sprites (5)
    return m;
  }
  // Add one standing sprite (wall/furniture) to a cell: re-placing the SAME tile replaces its own copy
  // (no z-fighting duplicate), a DIFFERENT one stacks. Furniture stacks (a lamp on a table); later items get
  // a higher renderOrder so they draw over earlier ones at the same near-equal depth.
  private addObjectMesh(gx: number, gy: number, tex: THREE.Texture, fullW: number, fullH: number, name: string | undefined, slot: 'wall' | 'furniture') {
    const key = `${gx},${gy}`; this.snapshotCell(key);
    let cell = this.cells.get(key); if (!cell) { cell = { walls: [], furniture: [] }; this.cells.set(key, cell); }
    const m = this.makeBillboard(tex, fullW, fullH, CharacterEngine.OBJ_ANCHOR);
    this.billboards.push(m); m.userData.tileName = name;
    const list = slot === 'wall' ? cell.walls : cell.furniture;
    const dup = list.findIndex((w) => w.userData.tileName === name);
    if (dup >= 0) { this.dropMesh(list[dup]); list.splice(dup, 1); }
    list.push(m);
    if (slot !== 'wall') cell.furniture.forEach((f, i) => { f.renderOrder = 6 + i; });
    m.position.x = gx * CharacterEngine.TILE; m.position.z = gy * CharacterEngine.TILE; this.tileGroup.add(m);
  }
  private placeBrush(gx: number, gy: number) {
    const b = this.brush; if (!b) return;
    const T = CharacterEngine.TILE;
    if (b.kind === 'object') {
      const slot = b.objectSlot ?? 'furniture';
      this.addObjectMesh(gx, gy, b.tex, b.fullW ?? 128, b.fullH ?? 256, b.name, slot);
      if (b.parts) for (const p of b.parts) this.addObjectMesh(gx + p.dx, gy + p.dy, p.tex, p.fullW, p.fullH, p.name, slot); // 2-tile couch / 2x2 bed: siblings alongside
      return;
    }
    const key = `${gx},${gy}`; this.snapshotCell(key);
    let cell = this.cells.get(key); if (!cell) { cell = { walls: [], furniture: [] }; this.cells.set(key, cell); }
    const m = this.flatQuad(b.tex, b.kind === 'rug' ? 0.004 : 0.002, b.kind === 'rug' ? 2 : 1);
    m.userData.tileName = b.name; // so floors/rugs serialise into a preset like objects do
    const slot = b.kind === 'rug' ? 'rug' : 'floor';
    if (cell[slot]) this.dropMesh(cell[slot]!);
    cell[slot] = m;
    m.position.x = gx * T; m.position.z = gy * T; this.tileGroup.add(m);
  }
  // stacked items of a cell in erase order (top first): furniture (last placed first), then walls, rug, floor
  private eraseOrder(cell: Cell): THREE.Mesh[] {
    const arr: THREE.Mesh[] = [];
    for (let i = cell.furniture.length - 1; i >= 0; i--) arr.push(cell.furniture[i]);
    for (let i = cell.walls.length - 1; i >= 0; i--) arr.push(cell.walls[i]);
    if (cell.rug) arr.push(cell.rug);
    if (cell.floor) arr.push(cell.floor);
    return arr;
  }
  private eraseAt(gx: number, gy: number, layer = 0) {
    const key = `${gx},${gy}`, cell = this.cells.get(key); if (!cell) return;
    const order = this.eraseOrder(cell); if (!order.length) return;
    const m = order[Math.min(Math.max(layer, 0), order.length - 1)];
    this.snapshotCell(key);
    if (this.eraseTarget === m) this.eraseTarget = null; // it's being deleted; don't restore its tint later
    const fi = cell.furniture.indexOf(m);
    if (fi >= 0) { cell.furniture.splice(fi, 1); cell.furniture.forEach((f, i) => { f.renderOrder = 6 + i; }); }
    else { const wi = cell.walls.indexOf(m); if (wi >= 0) cell.walls.splice(wi, 1); else if (cell.rug === m) cell.rug = undefined; else if (cell.floor === m) cell.floor = undefined; }
    this.dropMesh(m);
    if (!cell.furniture.length && !cell.walls.length && !cell.rug && !cell.floor) this.cells.delete(key);
  }
  // Erase highlight: tint the targeted stacked item red so it is obvious what a click would delete.
  private updateEraseHighlight(gx: number, gy: number) {
    this.eraseHover = { gx, gy };
    const cell = this.cells.get(`${gx},${gy}`);
    const order = cell ? this.eraseOrder(cell) : [];
    if (this.eraseLayer >= order.length) this.eraseLayer = order.length ? order.length - 1 : 0;
    const target = order.length ? order[this.eraseLayer] : null;
    if (target === this.eraseTarget) return;
    this.clearEraseHighlight();
    if (target) { this.eraseTarget = target; const mat = target.material as THREE.MeshBasicMaterial; this.eraseTargetColor.copy(mat.color); mat.color.setRGB(0.95, 0.18, 0.18); }
  }
  private clearEraseHighlight() {
    if (this.eraseTarget) { (this.eraseTarget.material as THREE.MeshBasicMaterial).color.copy(this.eraseTargetColor); this.eraseTarget = null; }
  }
  private hideGhost() { if (this.ghost) this.ghost.visible = false; for (const g of this.ghostParts) g.mesh.visible = false; }
  private moveGhost(e: { clientX: number; clientY: number }, aimLift = 0, shift = false) {
    let c = this.cellFromClient(e, aimLift); const b = this.brush;
    if (!c || !b) { this.hideGhost(); this.clearEraseHighlight(); this.eraseHover = null; return; }
    c = this.axisLock(c, shift); // keep the ghost on the locked axis while shift-drawing a line
    if (this.buildMode === 'erase') { this.hideGhost(); this.updateEraseHighlight(c.gx, c.gy); return; }
    this.clearEraseHighlight(); this.eraseHover = null;
    const T = CharacterEngine.TILE;
    if (!this.ghost) {
      this.ghost = b.kind === 'object' ? this.makeBillboard(b.tex, b.fullW ?? 128, b.fullH ?? 256, CharacterEngine.OBJ_ANCHOR, 0.55)
        : this.flatQuad(b.tex, b.kind === 'rug' ? 0.005 : 0.003, 3, 0.6);
      if (b.kind === 'object') this.billboards.push(this.ghost);
      this.tileGroup.add(this.ghost);
      // multi-tile brush: a translucent preview for each sibling sprite too
      if (b.kind === 'object' && b.parts) for (const p of b.parts) {
        const g = this.makeBillboard(p.tex, p.fullW, p.fullH, CharacterEngine.OBJ_ANCHOR, 0.55);
        this.billboards.push(g); this.tileGroup.add(g); this.ghostParts.push({ mesh: g, dx: p.dx, dy: p.dy });
      }
    }
    this.ghost.visible = true; this.ghost.position.x = c.gx * T; this.ghost.position.z = c.gy * T;
    for (const g of this.ghostParts) { g.mesh.visible = true; g.mesh.position.x = (c.gx + g.dx) * T; g.mesh.position.z = (c.gy + g.dy) * T; }
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
    // placed tiles are unlit sprites like the floor - tint them by ambient too (and the hover ghost)
    for (const c of this.cells.values()) for (const m of [c.floor, c.rug, ...c.walls, ...c.furniture]) if (m) (m.material as THREE.MeshBasicMaterial).color.setScalar(this.light.ambient);
    if (this.ghost) (this.ghost.material as THREE.MeshBasicMaterial).color.setScalar(this.light.ambient);
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
  seek(frac: number) { this.rigs.setTime(frac * this.rigs.duration()); if (this.editMode) { this.captureBoneBase(); this.applyBoneOverrides(); } } // re-base the edit on the new frame
  getTime() { return this.rigs.time(); }
  getDuration() { return this.rigs.duration(); }
  setLoop(on: boolean) { this.rigs.setLoop(on); if (on && this.finished) this.replay(); } // turning loop back on revives a stopped clip
  /** Rewind to the first frame and play again (one-shot or looping). */
  replay() { this.finished = false; this.rigs.restart(); this.playing = true; this.onPlaying?.(true); }
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

  /** Pin skin textures to a specific source (Vanilla vs a texture mod); null = mod-over-vanilla.
   *  Caller re-applies via setSkin (live) or loadBody (on reload). */
  setTextureSource(src: unknown) { this.textureSource = src || null; }

  // --- Tier-2 body/clothing UV compatibility -----------------------------------------------------
  // Painted ("composite") clothing and the stock skin textures are drawn through the BODY's UV map, so
  // they only line up if a modded body keeps the vanilla UV layout. We can't read intent, but we CAN
  // compare layouts: rasterise each body's UVs into a coarse occupancy grid and score the overlap
  // (intersection-over-union). High overlap = same atlas = vanilla clothing/skins fit; low = re-UV'd.
  // Occupancy (not per-vertex) is used so it's robust to a body being re-topologised without re-UVing.
  private static readonly UV_RES = 32;
  private static readonly UV_COMPAT_MIN = 0.55; // IoU at/above this = treat as vanilla-compatible

  /** Coarse UV-occupancy signature: the set of grid cells any mesh UV lands in (wrapped to [0,1)). */
  private uvSignature(meshes: THREE.SkinnedMesh[]): Set<number> {
    const res = CharacterEngine.UV_RES, cells = new Set<number>();
    for (const m of meshes) {
      const uv = m.geometry?.getAttribute('uv'); if (!uv) continue;
      for (let i = 0; i < uv.count; i++) {
        let u = uv.getX(i), v = uv.getY(i);
        u -= Math.floor(u); v -= Math.floor(v); // wrap tiled UVs into the unit square
        const cx = Math.min(res - 1, Math.max(0, Math.floor(u * res)));
        const cy = Math.min(res - 1, Math.max(0, Math.floor(v * res)));
        cells.add(cy * res + cx);
      }
    }
    return cells;
  }

  /** Vanilla body's UV signature for a gender (parsed once from the stock mesh, then cached). */
  private async vanillaUvSignature(gender: 'male' | 'female'): Promise<Set<number>> {
    const hit = this.vanillaUvSig.get(gender);
    if (hit) return hit;
    const body = await resolveBody(this.ctx, { gender }); // no bodySource -> vanilla mesh
    const gltf = await glbToGltf(body.meshGlb);
    const meshes: THREE.SkinnedMesh[] = [];
    gltf.scene.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh || (o as THREE.Mesh).isMesh) meshes.push(o as THREE.SkinnedMesh); });
    const sig = this.uvSignature(meshes);
    this.vanillaUvSig.set(gender, sig);
    return sig;
  }

  /** null when the current body is vanilla; else how its UV layout compares to vanilla. */
  uvVerdict(): { score: number; compatible: boolean } | null { return this.uvVerdictVal; }

  async loadBody(gender: 'male' | 'female' = this.gender, bodySource?: unknown) {
    this.gender = gender;
    const body = await resolveBody(this.ctx, { gender, bodySource, textureSource: this.textureSource });
    this.currentBody = { skinTexture: body.skinTexture };
    const tex = await bytesToTexture(body.skinTexture, false);
    const root = await this.loadSkinnedRoot(body.meshGlb, tex, null, false);
    this.bodyRest = boneRestMap(root);
    this.bodySkel = captureSkeletonBind(root); // bind-pose skeleton for world-space glb retarget
    const hadBody = !!this.rigs.bodyRig();
    this.clearBodyAttachments(); // their holders live on the old skeleton's bones; drop them on reload
    this.rigs.removeKind('body');
    this.rigs.add('body', root);
    root.updateMatrixWorld(true);
    // Ground the character so the actual posed SOLE rests on the grid. Every cheaper proxy
    // misleads here: Box3.setFromObject ignores GPU skinning (always bind bounds), getObjectByName
    // can return a duplicate-named proxy node a clip flings metres away, and the ankle-to-sole
    // distance varies per pose so no foot bone tracks the sole. So measure the true lowest skinned
    // vertex (see groundToClip/skinnedMinY). Collect the body's skinned meshes, then ground.
    this.bodyMeshes = [];
    root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh) this.bodyMeshes.push(sm); });
    this.groundToClip(); // grounds the bind pose here, or an active clip on a gender swap
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
    if (this.rigs.clip) this.groundToClip(); // a clip may already be playing (e.g. gender swap)
    await this.recompositeBody();
    // UV-compatibility verdict: only meaningful for a modded body (vanilla IS the reference). Never let
    // a failure here break body loading - it is advisory only.
    this.uvVerdictVal = null;
    if ((bodySource as { isMod?: boolean } | undefined)?.isMod) {
      try {
        const van = await this.vanillaUvSignature(gender);
        const mod = this.uvSignature(this.bodyMeshes);
        let inter = 0; for (const c of mod) if (van.has(c)) inter++;
        const union = van.size + mod.size - inter;
        const score = union ? inter / union : 1;
        this.uvVerdictVal = { score, compatible: score >= CharacterEngine.UV_COMPAT_MIN };
      } catch { this.uvVerdictVal = null; }
    }
  }

  /** World Y of the lowest CPU-skinned vertex across the body meshes at the current pose. This is
   *  the real visible sole - it accounts for skinning, foot pitch and everything Box3/bones miss. */
  private skinnedMinY(): number {
    let m = Infinity;
    const v = new THREE.Vector3();
    for (const sm of this.bodyMeshes) {
      const pos = sm.geometry.getAttribute('position');
      if (!pos) continue;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos as THREE.BufferAttribute, i);
        sm.applyBoneTransform(i, v);
        v.applyMatrix4(sm.matrixWorld);
        if (v.y < m) m = v.y;
      }
    }
    return m;
  }

  /** Ground the rig set so the lowest posed sole rests on the grid. With a clip playing it samples
   *  the loop and grounds the lowest frame (foot-plant), so a walk cycle's planted foot touches the
   *  floor while lifts rise; with no clip it grounds the bind pose. Clip-agnostic - grounds vanilla
   *  .x, .fbx and retargeted .glb the same way, since it measures actual skinned geometry. */
  private groundToClip() {
    const body = this.rigs.bodyRig();
    if (!body || !this.bodyMeshes.length) return;
    const hasClip = !!this.rigs.clip;
    const saved = this.rigs.time();
    const dur = this.rigs.duration() || 1;
    const K = hasClip ? 10 : 0;
    let minY = Infinity;
    for (let i = 0; i <= K; i++) {
      if (hasClip) this.rigs.setTime((i / Math.max(K, 1)) * dur);
      body.root.updateMatrixWorld(true);
      const y = this.skinnedMinY();
      if (y < minY) minY = y;
    }
    if (hasClip) { this.rigs.setTime(saved); body.root.updateMatrixWorld(true); }
    if (!Number.isFinite(minY)) return;
    this.rigs.setGroundOffset(this.rigs.groundOffset - minY); // lowest skinned point -> y=0
  }

  /** Swap the body skin tone (texture only, no mesh reload); recomposites so clothing stays.
   *  Honours the pinned textureSource so switching Vanilla<->mod textures is live. */
  async setSkin(tone: string) {
    if (!this.currentBody) return;
    const tex = await resolveSkinTexture(this.ctx, tone, this.textureSource);
    if (!tex) return;
    this.currentBody.skinTexture = tex.bytes;
    await this.recompositeBody();
  }

  async playClip(clip: Clip) {
    if (this.editMode) this.exitEditMode(); // picking a new clip drops any in-progress edit
    this.boneEdits.clear(); // edits are per-clip
    const r = await resolveClip(this.ctx, clip);
    if (r.error) throw new Error(r.error);
    this.editText = clip.format === 'x' && r.src ? new TextDecoder().decode(r.src) : null; // kept for the pose editor
    this.editClipName = clip.name;
    const gltf = await glbToGltf(r.glb);
    if (!gltf.animations?.length) throw new Error('no animation in ' + clip.name);
    const norm = normaliseClip(gltf.animations[0], clip.format, { clipScene: gltf.scene, bodySkel: this.bodySkel ?? undefined, clipRest: boneRestMap(gltf.scene), bodyRest: this.bodyRest });
    this.rigs.setClip(norm); // keeps the current loop setting - don't force looping on a freshly picked clip
    // Bake the weapon prop tracks AFTER binding, so the body is posed by the real playback mixer
    // (not the previous clip's leftover pose). Then rebind with the prop tracks folded in.
    const bodyRoot = this.rigs.bodyRig()?.root;
    if (norm.propMeta && bodyRoot) {
      const propTracks = retargetAttachments(norm.propMeta, bodyRoot, (t) => this.rigs.setTime(t));
      if (propTracks.length) { norm.clip.tracks.push(...propTracks); this.rigs.setClip(norm); }
    }
    this.groundToClip(); // re-ground off this clip's posed feet (formats frame the body differently)
    this.rigs.restart(); // grounding/prop-baking sample the clip to its end; that finishes a one-shot
    this.playing = true;  //   (LoopOnce) action, so rewind to a clean, playing frame 0
    this.finished = false;
    const tag = norm.best ? '' : (clip.format === 'fbx' ? ' (fbx, best-effort)' : ` (${clip.format}, retargeted)`);
    this.onClipName?.(clip.name + tag);
  }

  togglePlay() { if (this.finished) { this.replay(); return true; } this.playing = !this.playing; return this.playing; }

  // --- animation pose editor (Phase 1: enter/exit, joints, bone selection, per-bone override) ---
  /** The current clip can be pose-edited (its source is a .x we kept). */
  canEditClip(): boolean { return !!this.editText; }
  isEditing(): boolean { return this.editMode; }
  enterEditMode() {
    if (!this.editText || this.editMode) return;
    this.editMode = true;
    this.playing = false; this.finished = false; this.onPlaying?.(false); // pause: the mixer holds this frame
    this.gizmo?.detach();
    this.buildBoneMap();
    this.rigs.setTime(this.rigs.time()); // clean clip pose at the current frame (drop any stale override)
    this.captureBoneBase();
    this.applyBoneOverrides();
    this.setupOverlay(true);
    this.updateBoneHighlight();
    this.onEditState?.({ active: true, clip: this.editClipName, editable: true, bones: this.handleList().map((h) => h.bone) });
  }
  exitEditMode() {
    if (!this.editMode) return;
    this.editMode = false;
    this.setupOverlay(false);
    this.hoverBone = null; this.drag = null; this.renderer.domElement.style.cursor = '';
    this.selectedBones = []; this.onBoneSelect?.([]);
    this.rigs.setTime(this.rigs.time()); this.rigs.bodyRig()?.root.updateMatrixWorld(true); // restore the clip pose
    this.onEditState?.({ active: false, clip: this.editClipName, editable: !!this.editText, bones: [] });
  }
  private buildBoneMap() {
    this.bodyBones.clear();
    const root = this.rigs.bodyRig()?.root; if (!root) return;
    root.updateMatrixWorld(true);
    root.traverse((o) => { const b = o as THREE.Bone; if (b.isBone && b.name) this.bodyBones.set(b.name, b); });
  }
  private captureBoneBase() {
    this.boneBase.clear();
    this.poleTargets.clear(); // world-space pole points go stale when the pose re-bases (seek)
    for (const [name, bone] of this.bodyBones) this.boneBase.set(name, { quat: bone.quaternion.clone(), pos: bone.position.clone() });
  }
  /** Re-pose the body from base + each bone's app-space delta (base * rot, pos + delta). */
  private applyBoneOverrides() {
    for (const [name, bone] of this.bodyBones) {
      const base = this.boneBase.get(name); if (!base) continue;
      const edit = this.boneEdits.get(name);
      if (edit) { bone.quaternion.copy(base.quat).multiply(edit.rot); bone.position.copy(base.pos).add(edit.pos); }
      else { bone.quaternion.copy(base.quat); bone.position.copy(base.pos); }
    }
    this.rigs.bodyRig()?.root.updateMatrixWorld(true);
    this.updateBoneHighlight();
  }
  /** Set (or clear, when zero) a bone's app-space delta: euler degrees on the three.js axes + a position offset. */
  setBoneEdit(name: string, euler: [number, number, number], pos: [number, number, number]) {
    const zero = euler.every((v) => v === 0) && pos.every((v) => v === 0);
    if (zero) this.boneEdits.delete(name);
    else this.boneEdits.set(name, {
      rot: new THREE.Quaternion().setFromEuler(new THREE.Euler(euler[0] * Math.PI / 180, euler[1] * Math.PI / 180, euler[2] * Math.PI / 180, 'XYZ')),
      pos: new THREE.Vector3(pos[0], pos[1], pos[2]),
    });
    if (this.editMode) this.applyBoneOverrides();
  }
  /** The app-space delta a bone currently carries, as euler degrees + pos (for the editor panel). */
  boneEditOf(name: string): { euler: [number, number, number]; pos: [number, number, number] } {
    const e = this.boneEdits.get(name);
    if (!e) return { euler: [0, 0, 0], pos: [0, 0, 0] };
    const eu = new THREE.Euler().setFromQuaternion(e.rot, 'XYZ');
    return { euler: [eu.x * 180 / Math.PI, eu.y * 180 / Math.PI, eu.z * 180 / Math.PI], pos: [e.pos.x, e.pos.y, e.pos.z] };
  }
  // --- pose edit history (shares the prop/tile undo stack) ---
  private snapshotEdits(names: string[]): Map<string, { rot: THREE.Quaternion; pos: THREE.Vector3 } | null> {
    const m = new Map<string, { rot: THREE.Quaternion; pos: THREE.Vector3 } | null>();
    for (const n of names) { const e = this.boneEdits.get(n); m.set(n, e ? { rot: e.rot.clone(), pos: e.pos.clone() } : null); }
    return m;
  }
  private restoreEdits(snap: Map<string, { rot: THREE.Quaternion; pos: THREE.Vector3 } | null>) {
    for (const [n, e] of snap) { if (e) this.boneEdits.set(n, { rot: e.rot.clone(), pos: e.pos.clone() }); else this.boneEdits.delete(n); }
    if (this.editMode) this.applyBoneOverrides();
    this.onBoneEdit?.();
  }
  private pushBoneHistory(before: Map<string, { rot: THREE.Quaternion; pos: THREE.Vector3 } | null>, after: Map<string, { rot: THREE.Quaternion; pos: THREE.Vector3 } | null>) {
    let changed = false;
    for (const [n, b] of before) { const a = after.get(n); if (!!a !== !!b || (a && b && (!a.rot.equals(b.rot) || !a.pos.equals(b.pos)))) { changed = true; break; } }
    if (changed) this.pushProp(() => this.restoreEdits(before), () => this.restoreEdits(after));
  }
  /** Reset the edits on these bones to the clip pose (one undo entry). */
  resetBones(names: string[]) {
    const before = this.snapshotEdits(names);
    for (const n of names) this.boneEdits.delete(n);
    if (this.editMode) this.applyBoneOverrides();
    this.onBoneEdit?.();
    this.pushBoneHistory(before, this.snapshotEdits(names));
  }
  /** Which limb chains a handle plants (pinned to hold position/orientation while its root moves). */
  private pinChainsOf(h: { bone: string; role: 'ik' | 'pole' | 'aim' | 'move' }): string[][] {
    if (h.role === 'move') return [CharacterEngine.R_LEG, CharacterEngine.L_LEG, CharacterEngine.R_ARM, CharacterEngine.L_ARM];
    if (h.bone === 'Bip01_Spine') return [CharacterEngine.R_ARM, CharacterEngine.L_ARM, CharacterEngine.R_LEG, CharacterEngine.L_LEG];
    if (h.bone === 'Bip01_Spine1') return [CharacterEngine.R_ARM, CharacterEngine.L_ARM];
    return [];
  }
  /** The spine joints an aim handle bends (from the grabbed joint up to the head). */
  private spineChainOf(bone: string): string[] {
    const k = CharacterEngine.SPINE_COLUMN.indexOf(bone);
    return k >= 0 ? CharacterEngine.SPINE_COLUMN.slice(k).filter((n) => this.bodyBones.has(n)) : [bone];
  }
  /** Every bone a handle edits (drag AND right-click reset share this, so a reset clears exactly what a drag wrote). */
  private affectedForHandle(h: { bone: string; role: 'ik' | 'pole' | 'aim' | 'move'; chain?: string[] }): string[] {
    if ((h.role === 'ik' || h.role === 'pole') && h.chain) return [...h.chain];
    const pinBones = this.pinChainsOf(h).flat();
    const driven = h.role === 'move' ? ['Bip01_Pelvis', ...pinBones] : [...this.spineChainOf(h.bone), ...pinBones];
    return [...new Set(driven)].filter((n) => this.bodyBones.has(n));
  }
  private resetHandle(h: { bone: string; role: 'ik' | 'pole' | 'aim' | 'move'; chain?: string[] }) { this.resetBones(this.affectedForHandle(h)); this.selectBone(h.bone); }
  clearBoneEdits() {
    const names = [...this.boneEdits.keys()]; if (!names.length) return;
    const before = this.snapshotEdits(names);
    this.boneEdits.clear();
    if (this.editMode) this.applyBoneOverrides();
    this.onBoneEdit?.();
    this.pushBoneHistory(before, this.snapshotEdits(names));
  }
  editedBoneNames(): string[] { return [...this.boneEdits.keys()]; }

  // --- mirror the pose left <-> right across the body's sagittal plane (world-space, so it is
  //     independent of each bone's local-axis convention) ---
  private mirrorName(name: string): string { return name.includes('_L_') ? name.replace('_L_', '_R_') : name.includes('_R_') ? name.replace('_R_', '_L_') : name; }
  private mirrorQuat(q: THREE.Quaternion, n: THREE.Vector3): THREE.Quaternion { const d = 2 * (q.x * n.x + q.y * n.y + q.z * n.z); return new THREE.Quaternion(d * n.x - q.x, d * n.y - q.y, d * n.z - q.z, q.w); }
  private mirrorPoint(p: THREE.Vector3, n: THREE.Vector3, plane: THREE.Vector3): THREE.Vector3 { return p.clone().addScaledVector(n, -2 * p.clone().sub(plane).dot(n)); }
  mirrorPose() {
    const lb = this.bodyBones.get('Bip01_L_Thigh'), rb = this.bodyBones.get('Bip01_R_Thigh'); if (!lb || !rb) return;
    this.rigs.bodyRig()?.root.updateMatrixWorld(true);
    const lp = lb.getWorldPosition(new THREE.Vector3()), rp = rb.getWorldPosition(new THREE.Vector3());
    const n = rp.clone().sub(lp); if (n.lengthSq() < 1e-9) return; n.normalize(); // body left-right axis (thigh joints are symmetric, set by the pelvis)
    const plane = lp.add(rp).multiplyScalar(0.5);
    const set = new Set<string>();
    for (const name of this.boneEdits.keys()) { set.add(name); set.add(this.mirrorName(name)); }
    const bones = [...set].filter((x) => this.bodyBones.has(x)); if (!bones.length) return;
    const world = new Map<string, { quat: THREE.Quaternion; pos: THREE.Vector3 }>();
    for (const name of bones) { const b = this.bodyBones.get(name)!; world.set(name, { quat: b.getWorldQuaternion(new THREE.Quaternion()), pos: b.getWorldPosition(new THREE.Vector3()) }); }
    const before = this.snapshotEdits(bones);
    for (const name of this.bodySkel?.order ?? bones) { // parent-first so each parent's new world is ready
      if (!set.has(name)) continue;
      const b = this.bodyBones.get(name)!, src = world.get(this.mirrorName(name)) ?? world.get(name)!;
      const parentQ = b.parent ? b.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
      b.quaternion.copy(parentQ.invert().multiply(this.mirrorQuat(src.quat, n)));
      if (name === 'Bip01_Pelvis' && b.parent) b.position.copy(b.parent.worldToLocal(this.mirrorPoint(src.pos, n, plane))); // mirror the hip shift; other bones keep their base position
      b.updateMatrixWorld(true);
    }
    for (const name of bones) {
      const b = this.bodyBones.get(name)!, base = this.boneBase.get(name); if (!base) continue;
      const rot = base.quat.clone().invert().multiply(b.quaternion), pos = b.position.clone().sub(base.pos);
      if (Math.abs(rot.w) > 0.9999995 && pos.lengthSq() < 1e-10) this.boneEdits.delete(name); else this.boneEdits.set(name, { rot, pos });
    }
    this.applyBoneOverrides();
    this.onBoneEdit?.();
    this.pushBoneHistory(before, this.snapshotEdits(bones));
  }
  /** The AnimationSet name declared in the loaded .x (usually the clip name). */
  private editSetName(): string | null { const m = this.editText ? /AnimationSet\s+(\S+)\s*\{/.exec(this.editText) : null; return m ? m[1] : null; }
  /** Bake the current bone edits into an edited .x (app-space deltas -> .x via the verified calibration).
   *  saveAs renames the AnimationSet so vanilla is never clobbered. Returns null if nothing to bake. */
  bakeEdits(saveAs?: string): { name: string; text: string; bones: number } | null {
    if (!this.editText || !this.boneEdits.size) return null;
    const setName = this.editSetName();
    let text = this.editText, bones = 0;
    for (const [bone, edit] of this.boneEdits) {
      const A: Quat = [edit.rot.w, edit.rot.x, edit.rot.y, edit.rot.z];
      const rotId = Math.abs(A[0]) > 0.9999995; // ~identity rotation
      const hasPos = !!(edit.pos.x || edit.pos.y || edit.pos.z);
      let touched = false;
      if (!rotId) { try { text = applyDelta(text, bone, appDeltaToX(A), setName, 'post').text; touched = true; } catch { /* bone has no R keys in this .x */ } }
      if (hasPos) { try { text = applyTranslationDelta(text, bone, appPosToX([edit.pos.x, edit.pos.y, edit.pos.z]), setName).text; touched = true; } catch { /* no T keys */ } }
      if (touched) bones++;
    }
    let name = this.editClipName || setName || 'edited';
    const target = saveAs?.trim().replace(/[^A-Za-z0-9_]/g, '_'); // AnimationSet names + filenames must be identifier-safe
    if (target && setName && target !== setName) { text = renameSet(text, setName, target).text; name = target; }
    else if (target) name = target;
    return { name, text, bones };
  }

  // --- IK / pose handles: a small curated set of draggable control points (no full-body pick) ---
  private static readonly R_ARM = ['Bip01_R_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand'];
  private static readonly L_ARM = ['Bip01_L_UpperArm', 'Bip01_L_Forearm', 'Bip01_L_Hand'];
  private static readonly R_LEG = ['Bip01_R_Thigh', 'Bip01_R_Calf', 'Bip01_R_Foot'];
  private static readonly L_LEG = ['Bip01_L_Thigh', 'Bip01_L_Calf', 'Bip01_L_Foot'];
  private static readonly SPINE_COLUMN = ['Bip01_Spine', 'Bip01_Spine1', 'Bip01_Neck', 'Bip01_Head']; // torso bends distribute across this chain for a smooth arc
  private static readonly HANDLES: { bone: string; label: string; role: 'ik' | 'pole' | 'aim' | 'move'; chain?: string[] }[] = [
    { bone: 'Bip01_R_Hand', label: 'R hand', role: 'ik', chain: CharacterEngine.R_ARM },
    { bone: 'Bip01_R_Forearm', label: 'R elbow', role: 'pole', chain: CharacterEngine.R_ARM },
    { bone: 'Bip01_L_Hand', label: 'L hand', role: 'ik', chain: CharacterEngine.L_ARM },
    { bone: 'Bip01_L_Forearm', label: 'L elbow', role: 'pole', chain: CharacterEngine.L_ARM },
    { bone: 'Bip01_R_Foot', label: 'R foot', role: 'ik', chain: CharacterEngine.R_LEG },
    { bone: 'Bip01_R_Calf', label: 'R knee', role: 'pole', chain: CharacterEngine.R_LEG },
    { bone: 'Bip01_L_Foot', label: 'L foot', role: 'ik', chain: CharacterEngine.L_LEG },
    { bone: 'Bip01_L_Calf', label: 'L knee', role: 'pole', chain: CharacterEngine.L_LEG },
    { bone: 'Bip01_Head', label: 'head', role: 'aim' },
    { bone: 'Bip01_Spine1', label: 'chest', role: 'aim' },
    { bone: 'Bip01_Spine', label: 'spine', role: 'aim' },
    { bone: 'Bip01_Pelvis', label: 'hips', role: 'move' },
  ];
  handleList(): { bone: string; label: string }[] { return CharacterEngine.HANDLES.filter((h) => this.bodyBones.has(h.bone)).map((h) => ({ bone: h.bone, label: h.label })); }
  selectBones(names: string[]) { this.selectedBones = names; this.updateBoneHighlight(); this.onBoneSelect?.(names); }
  selectBone(name: string | null) { this.selectBones(name ? [name] : []); }
  toggleBone(name: string) { this.selectBones(this.selectedBones.includes(name) ? this.selectedBones.filter((n) => n !== name) : [...this.selectedBones, name]); }
  private firstBoneChild(bone: THREE.Object3D): THREE.Bone | null { return (bone.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone) ?? null; }

  private setupOverlay(on: boolean) {
    if (!on) { if (this.boneOverlay) { this.scene.remove(this.boneOverlay); this.boneOverlay.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } }); this.boneOverlay = null; } return; }
    if (this.boneOverlay) return;
    const g = new THREE.Group();
    const geo = new THREE.SphereGeometry(0.019, 14, 12);
    for (const h of CharacterEngine.HANDLES) {
      if (!this.bodyBones.has(h.bone)) continue;
      const base = h.role === 'pole' ? 0xff9944 : h.role === 'move' ? 0xcc66ff : h.role === 'aim' ? 0x33cc99 : 0x5b8cff; // elbow/knee orange, hips purple, torso teal, hands/feet blue
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: base, depthTest: false, transparent: true, opacity: 0.8 }));
      m.renderOrder = 1000; m.frustumCulled = false; m.userData = { bone: h.bone, role: h.role, chain: h.chain, base, baseScale: h.role === 'pole' ? 0.66 : 1 };
      g.add(m);
    }
    this.scene.add(g); this.boneOverlay = g;
    this.updateBoneHighlight();
  }
  private updateBoneHighlight() {
    const g = this.boneOverlay; if (!g) return;
    const wp = new THREE.Vector3(), sel = this.selectedBones[this.selectedBones.length - 1];
    for (const m of g.children as THREE.Mesh[]) {
      const name = m.userData.bone as string, bone = this.bodyBones.get(name); if (!bone) continue;
      if (m.userData.role === 'aim') wp.copy(this.aimHandlePos(bone)); else bone.getWorldPosition(wp); // aim nodes sit on the body at the spine segment midpoints
      m.position.copy(wp);
      const isSel = name === sel, isHover = name === this.hoverBone, bs = m.userData.baseScale as number, mat = m.material as THREE.MeshBasicMaterial;
      mat.color.setHex(isSel ? 0xffcc33 : isHover ? 0x66d9ff : this.boneEdits.has(name) ? 0x33cc66 : (m.userData.base as number));
      mat.opacity = isSel || isHover ? 1 : 0.5; // subtle at rest, solid on hover/select
      m.scale.setScalar(bs * (isSel ? 1.5 : isHover ? 1.3 : 1));
    }
  }
  private handleFromHit(e: { clientX: number; clientY: number }): { bone: string; role: 'ik' | 'pole' | 'aim' | 'move'; chain?: string[] } | null {
    const g = this.boneOverlay; if (!g) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = this.raycaster.intersectObjects(g.children, false)[0];
    return hit ? { bone: hit.object.userData.bone as string, role: hit.object.userData.role, chain: hit.object.userData.chain as string[] | undefined } : null;
  }
  setHoverFromPointer(e: { clientX: number; clientY: number } | null) {
    const n = e ? this.handleFromHit(e)?.bone ?? null : null;
    if (n !== this.hoverBone) { this.hoverBone = n; this.updateBoneHighlight(); this.renderer.domElement.style.cursor = this.editMode && n ? 'grab' : ''; }
  }

  // --- grab + drag posing: aim a bone's child-direction at a world target, drift-free per frame ---
  /** World position of an aim handle's draggable tip, pushed out to a minimum lever length so short
   *  bones (head) don't spin wildly when their handle sits right on the pivot. Same direction as the
   *  bone's child, so the aim stays identity at grab. */
  private aimTip(bone: THREE.Bone): THREE.Vector3 {
    bone.updateWorldMatrix(true, false);
    const J = bone.getWorldPosition(new THREE.Vector3());
    const child = this.firstBoneChild(bone);
    const raw = child ? child.getWorldPosition(new THREE.Vector3()).sub(J)
      : bone.parent ? J.clone().sub(bone.parent.getWorldPosition(new THREE.Vector3())) : new THREE.Vector3(0, 1, 0);
    if (raw.lengthSq() < 1e-9) raw.set(0, 1, 0);
    const len = Math.max(raw.length(), 0.2);
    return J.add(raw.normalize().multiplyScalar(len));
  }
  /** Where an aim node is drawn/grabbed: the midpoint of the bone's segment, so torso/head nodes sit ON
   *  the body evenly along the spine. Placement is purely cosmetic now (aim is driven by pixel deltas). */
  private aimHandlePos(bone: THREE.Bone): THREE.Vector3 {
    bone.updateWorldMatrix(true, false);
    const J = bone.getWorldPosition(new THREE.Vector3());
    const child = this.firstBoneChild(bone);
    return child ? J.add(child.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5) : J;
  }
  private aimBoneChildAt(bone: THREE.Bone, target: THREE.Vector3) {
    bone.updateWorldMatrix(true, false);
    const J = bone.getWorldPosition(new THREE.Vector3());
    const child = this.firstBoneChild(bone);
    const tip = child ? child.getWorldPosition(new THREE.Vector3())
      : J.clone().add(bone.parent ? J.clone().sub(bone.parent.getWorldPosition(new THREE.Vector3())).normalize().multiplyScalar(0.12) : new THREE.Vector3(0, 0.12, 0)); // end bone: continue from the parent
    const aim0 = tip.sub(J).normalize(), aim1 = target.clone().sub(J).normalize();
    if (aim0.lengthSq() < 1e-9 || aim1.lengthSq() < 1e-9) return;
    const wDelta = new THREE.Quaternion().setFromUnitVectors(aim0, aim1);
    const pWorld = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    const bWorld = bone.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.copy(pWorld.invert().multiply(wDelta.multiply(bWorld)));
    bone.updateMatrixWorld(true);
  }
  /** Cursor projected onto a camera-facing plane through `through` (world). */
  private cursorOnPlane(e: { clientX: number; clientY: number }, through: THREE.Vector3): THREE.Vector3 | null {
    this.setRayClient(e.clientX, e.clientY);
    const n = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, through);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, hit) ? hit : null;
  }
  /** Grab a handle: hands/feet = 2-bone IK; elbows/knees = pole (bend); torso/head = aim-the-tip; hips = move.
   *  Every mode records a grab offset so the control point starts where it is and tracks the drag (never snaps). */
  private startDrag(handle: { bone: string; role: 'ik' | 'pole' | 'aim' | 'move'; chain?: string[] }, e: { clientX: number; clientY: number }) {
    this.orbit.enabled = false;
    const chain = handle.chain, bone = this.bodyBones.get(handle.bone);
    let P0: THREE.Vector3; // the control point that must stay under the cursor as-grabbed
    if ((handle.role === 'ik' || handle.role === 'pole') && chain && chain.every((n) => this.bodyBones.has(n))) {
      const [up, mid, end] = chain.map((n) => this.bodyBones.get(n)!);
      const R = up.getWorldPosition(new THREE.Vector3()), M = mid.getWorldPosition(new THREE.Vector3()), E = end.getWorldPosition(new THREE.Vector3());
      P0 = handle.role === 'pole' ? M : E;
      const C0 = this.cursorOnPlane(e, P0);
      this.drag = { mode: handle.role, grab: handle.bone, affected: [...chain], chain, l1: R.distanceTo(M), l2: M.distanceTo(E), handTarget: handle.role === 'pole' ? E.clone() : undefined, endQuat: handle.role === 'pole' ? end.getWorldQuaternion(new THREE.Quaternion()) : undefined, planePt: P0.clone(), offset: C0 ? P0.clone().sub(C0) : new THREE.Vector3() };
      if (handle.role === 'ik') this.poleTargets.set(chain[2], this.computePoleDir(chain, R, E, M)); // lock the bend direction at grab so the knee/elbow can't wander
    } else if (handle.role === 'move' && bone) {
      P0 = bone.getWorldPosition(new THREE.Vector3());
      const C0 = this.cursorOnPlane(e, P0);
      const pins = this.buildPins(this.pinChainsOf(handle)); // plant both hands + feet (position + orientation)
      this.drag = { mode: 'move', grab: handle.bone, affected: this.affectedForHandle(handle), l1: 0, l2: 0, planePt: P0.clone(), offset: C0 ? P0.clone().sub(C0) : new THREE.Vector3(), pins };
    } else if (bone) {
      P0 = handle.role === 'aim' ? this.aimHandlePos(bone) : bone.getWorldPosition(new THREE.Vector3());
      const C0 = this.cursorOnPlane(e, P0);
      const pinChains = this.pinChainsOf(handle);
      const pins = pinChains.length ? this.buildPins(pinChains) : undefined;
      this.drag = { mode: 'aim', grab: handle.bone, chain: this.spineChainOf(handle.bone), affected: this.affectedForHandle(handle), l1: 0, l2: 0, planePt: P0.clone(), offset: C0 ? P0.clone().sub(C0) : new THREE.Vector3(), pins, lastX: e.clientX, lastY: e.clientY };
    }
    if (this.drag) { this.drag.twistDir = this.computeTwistDir(this.bodyBones.get(this.drag.grab)); this.dragBefore = this.snapshotEdits(this.drag.affected); } // lock scroll dir + snapshot for undo
  }
  /** Build IK pins for a set of limb chains: each records its endpoint's world position + orientation
   *  and a locked bend direction, so the endpoint stays planted while its root is moved elsewhere. */
  private buildPins(chains: string[][]) {
    return chains.filter((c) => c.every((n) => this.bodyBones.has(n))).map((chain) => {
      const [up, mid, end] = chain.map((n) => this.bodyBones.get(n)!);
      const R = up.getWorldPosition(new THREE.Vector3()), M = mid.getWorldPosition(new THREE.Vector3()), E = end.getWorldPosition(new THREE.Vector3());
      return { chain, target: E, pole: this.computePoleDir(chain, R, E, M), l1: R.distanceTo(M), l2: M.distanceTo(E), footQuat: end.getWorldQuaternion(new THREE.Quaternion()) };
    });
  }
  /** Re-solve one pinned limb so its endpoint holds the recorded world position AND orientation. */
  private applyPin(p: { chain: string[]; target: THREE.Vector3; pole: THREE.Vector3; l1: number; l2: number; footQuat: THREE.Quaternion }) {
    this.solveIk(p.chain, p.target, p.pole, p.l1, p.l2);
    const end = this.bodyBones.get(p.chain[2]);
    if (end?.parent) { end.quaternion.copy(end.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(p.footQuat)); end.updateMatrixWorld(true); }
  }
  /** Horizontal direction the character faces (from the toes), for a stable IK bend fallback. */
  private characterForward(): THREE.Vector3 {
    const f = new THREE.Vector3();
    for (const [foot, toe] of [['Bip01_L_Foot', 'Bip01_L_Toe0'], ['Bip01_R_Foot', 'Bip01_R_Toe0']]) {
      const fb = this.bodyBones.get(foot), tb = this.bodyBones.get(toe);
      if (fb && tb) f.add(tb.getWorldPosition(new THREE.Vector3()).sub(fb.getWorldPosition(new THREE.Vector3())));
    }
    f.y = 0;
    return f.lengthSq() < 1e-9 ? new THREE.Vector3(0, 0, 1) : f.normalize();
  }
  /** Resolve a stable bend DIRECTION (world) for a limb at grab: the mid's sideways offset if the limb is
   *  clearly bent, else anatomical (knees forward, elbows back). Stored + reused so it can't wander. */
  private computePoleDir(chain: string[], hip: THREE.Vector3, foot: THREE.Vector3, mid: THREE.Vector3): THREE.Vector3 {
    const axis = foot.clone().sub(hip); if (axis.lengthSq() < 1e-9) axis.set(0, -1, 0); axis.normalize();
    let d = mid.clone().sub(hip); d.addScaledVector(axis, -d.dot(axis)); // knee/elbow sideways offset
    if (d.lengthSq() < 1e-4) { d = this.characterForward().multiplyScalar(chain[0].includes('Thigh') ? 1 : -1); d.addScaledVector(axis, -d.dot(axis)); } // near-straight: anatomical
    return d.lengthSq() < 1e-9 ? new THREE.Vector3(0, 0, 1) : d.normalize();
  }
  /** 2-bone IK: place mid + end so end reaches T, the mid bending toward poleDir (a world direction). */
  private solveIk(chain: string[], T: THREE.Vector3, poleDir: THREE.Vector3, l1: number, l2: number) {
    const [up, mid] = chain.map((n) => this.bodyBones.get(n)!);
    const R = up.getWorldPosition(new THREE.Vector3());
    const reach = (l1 + l2) * 0.999, near = Math.abs(l1 - l2) + 1e-3;
    let toT = T.clone().sub(R); let dist = toT.length(); const axis = (dist > 1e-6 ? toT.clone().normalize() : new THREE.Vector3(0, -1, 0));
    if (dist > reach) { T = R.clone().addScaledVector(axis, reach); dist = reach; } else if (dist < near) { T = R.clone().addScaledVector(axis, near); dist = near; }
    let pole = poleDir.clone(); pole.addScaledVector(axis, -pole.dot(axis)); // perpendicular component of the bend direction
    if (pole.lengthSq() < 1e-7) { pole = this.characterForward().multiplyScalar(chain[0].includes('Thigh') ? 1 : -1); pole.addScaledVector(axis, -pole.dot(axis)); if (pole.lengthSq() < 1e-7) pole.crossVectors(axis, new THREE.Vector3(0, 1, 0)); }
    pole.normalize();
    const a = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist))));
    const Mnew = R.clone().addScaledVector(axis, Math.cos(a) * l1).addScaledVector(pole, Math.sin(a) * l1);
    this.aimBoneChildAt(up, Mnew);
    this.aimBoneChildAt(mid, T);
  }
  /** +1/-1: which way to rotate the bone about the view axis so a positive scroll tilts its tip toward
   *  screen-up. Computed only on grab / drag (NOT per scroll) so continuous scrolling never reverses. */
  private computeTwistDir(bone: THREE.Bone | undefined): number {
    if (!bone) return 1;
    bone.updateWorldMatrix(true, false);
    const pivot = bone.getWorldPosition(new THREE.Vector3());
    const axis = pivot.clone().sub(this.camera.getWorldPosition(new THREE.Vector3())).normalize();
    const child = this.firstBoneChild(bone);
    const r = (child ? child.getWorldPosition(new THREE.Vector3()) : bone.localToWorld(new THREE.Vector3(0, 1, 0))).sub(pivot);
    const camUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    return new THREE.Vector3().crossVectors(axis, r).dot(camUp) >= 0 ? 1 : -1;
  }
  /** Pitch a bone about the view axis (into the screen) by a signed angle. */
  private applyTwist(bone: THREE.Bone | undefined, angle: number) {
    if (!bone || !angle) return;
    bone.updateWorldMatrix(true, false);
    const axis = bone.getWorldPosition(new THREE.Vector3()).sub(this.camera.getWorldPosition(new THREE.Vector3())).normalize();
    if (axis.lengthSq() < 1e-9) return;
    const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    const pWorld = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    const bWorld = bone.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.copy(pWorld.invert().multiply(q).multiply(bWorld));
    bone.updateMatrixWorld(true);
  }
  /** Torso/head aim: bend the spine chain so the grabbed joint's tip follows the cursor's screen-space
   *  motion. The rotation is split evenly across every joint from the grab up to the head, so the spine
   *  curves as a smooth arc instead of kinking at one hinge. Axis is perpendicular to the tip (no roll). */
  private updateAim(e: { clientX: number; clientY: number }) {
    const d = this.drag!, bone = this.bodyBones.get(d.grab), chain = (d.chain ?? [d.grab]).map((n) => this.bodyBones.get(n)!).filter(Boolean);
    const dx = e.clientX - (d.lastX ?? e.clientX), dy = e.clientY - (d.lastY ?? e.clientY);
    d.lastX = e.clientX; d.lastY = e.clientY;
    if (bone && chain.length && (dx || dy)) {
      const J = bone.getWorldPosition(new THREE.Vector3());
      const tip = this.aimTip(bone).sub(J); // current tip direction from the grabbed joint
      const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const camUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const wantMove = camRight.multiplyScalar(dx).add(camUp.multiplyScalar(-dy)); // where the cursor pushed the tip (world), screen-y is down
      const axis = new THREE.Vector3().crossVectors(tip, wantMove); // perpendicular to the tip -> pure aim, never twist
      if (tip.lengthSq() > 1e-9 && axis.lengthSq() > 1e-12) {
        axis.normalize();
        const q = new THREE.Quaternion().setFromAxisAngle(axis, Math.hypot(dx, dy) * 0.006 / chain.length); // ~0.34 deg/px total, spread across the chain
        for (const b of chain) { // base -> tip, each joint bends an equal share about the same world axis: a circular arc
          const pWorld = b.parent ? b.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
          b.quaternion.copy(pWorld.invert().multiply(q).multiply(b.getWorldQuaternion(new THREE.Quaternion())));
          b.updateMatrixWorld(true);
        }
      }
    }
    if (d.pins) for (const p of d.pins) this.applyPin(p); // keep the hands (and feet, for the waist) where they were
    this.rigs.bodyRig()?.root.updateMatrixWorld(true);
    this.updateBoneHighlight();
  }
  private updateDrag(e: { clientX: number; clientY: number }) {
    const d = this.drag; if (!d) return;
    if (d.mode === 'aim') { this.updateAim(e); return; } // screen-space drag, no plane projection
    const C = this.cursorOnPlane(e, d.planePt!); if (!C) return;
    const target = C.add(d.offset!); // the grabbed control point follows the cursor from where it started (no snap)
    // Every primary transform composes onto the CURRENT orientation, so any scroll-twist already on the bone survives.
    if (d.mode === 'move') { // hips: move the upper body, limbs IK so hands + feet stay planted
      const bone = this.bodyBones.get(d.grab); if (!bone?.parent) return;
      bone.position.copy(bone.parent.worldToLocal(target.clone())); bone.updateMatrixWorld(true);
      for (const p of d.pins!) this.applyPin(p);
    } else if (d.mode === 'ik') {
      const pole = this.poleTargets.get(d.chain![2]) ?? this.characterForward(); // bend direction locked at grab
      this.solveIk(d.chain!, target, pole, d.l1, d.l2);
    } else { // pole: swing the elbow/knee toward the cursor, keeping the hand/foot planted in position AND orientation
      const R = this.bodyBones.get(d.chain![0])!.getWorldPosition(new THREE.Vector3());
      const poleDir = this.computePoleDir(d.chain!, R, d.handTarget!, target); // aim the bend toward the cursor
      this.poleTargets.set(d.chain![2], poleDir);
      this.solveIk(d.chain!, d.handTarget!, poleDir, d.l1, d.l2);
      const end = this.bodyBones.get(d.chain![2]); if (end?.parent && d.endQuat) { end.quaternion.copy(end.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(d.endQuat)); end.updateMatrixWorld(true); } // hold the hand/foot orientation
    }
    this.rigs.bodyRig()?.root.updateMatrixWorld(true);
    this.updateBoneHighlight();
  }
  private commitDrag() {
    const d = this.drag; if (!d) return;
    for (const name of d.affected) {
      const bone = this.bodyBones.get(name), base = this.boneBase.get(name); if (!bone || !base) continue;
      const rot = base.quat.clone().invert().multiply(bone.quaternion), pos = bone.position.clone().sub(base.pos);
      if (Math.abs(rot.w) > 0.9999995 && pos.lengthSq() < 1e-12) this.boneEdits.delete(name); else this.boneEdits.set(name, { rot, pos });
    }
    this.applyBoneOverrides();
    this.onBoneEdit?.();
    if (this.dragBefore) { this.pushBoneHistory(this.dragBefore, this.snapshotEdits(d.affected)); this.dragBefore = null; } // one undo entry per grab-drag
  }

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
    // Composite the texture-only garments (socks, longjohns, undies, ...) in PZ BodyLocations order,
    // not toggle order, so overlapping layers stack correctly regardless of what was equipped first.
    const ordered = [...this.equipped.entries()].sort((a, b) => a[1].layer - b[1].layer);
    for (const [name, e] of ordered) {
      if (this.hidden.has(name)) continue; // a hidden garment drops its texture layer AND its skin mask
      for (const b of e.baseTextures) layers.push({ bytes: b, tint: e.tint });
      for (const m of e.maskTextures) masks.push(m);
    }
    const canvas = await composeBody(this.currentBody.skinTexture, layers, masks);
    this.setBodyTexture(sourceToTexture(canvas, false));
  }

  /** All currently-equipped clothing + held items, for the viewer's equipped panel. */
  equippedList(): { name: string; type: 'clothing' | 'held'; hidden: boolean; hand?: 'right' | 'left' }[] {
    const out: { name: string; type: 'clothing' | 'held'; hidden: boolean; hand?: 'right' | 'left' }[] = [];
    for (const name of this.equipped.keys()) out.push({ name, type: 'clothing', hidden: this.hidden.has(name) });
    for (const name of this.held.keys()) out.push({ name, type: 'held', hidden: this.hidden.has(name), hand: this.heldHand(name)! });
    return out;
  }

  /** Full serialisable state of what's worn/held, for saving a character preset. */
  clothingState(): { name: string; tint: number[] | null; hidden: boolean }[] {
    return [...this.equipped.entries()].map(([name, e]) => ({ name, tint: e.tint, hidden: this.hidden.has(name) }));
  }
  /** The colour tint (rgb 0-1) applied to an equipped garment, or null for none. */
  clothingTint(name: string): number[] | null { return this.equipped.get(name)?.tint ?? null; }
  /** Recolour an equipped garment live: update the shader tint uniform (mesh/static) and, for
   *  texture-composited garments, recomposite the body diffuse. tint=null clears it (white). */
  async setClothingTint(name: string, tint: number[] | null) {
    const e = this.equipped.get(name); if (!e) return;
    e.tint = tint;
    const apply = (obj: THREE.Object3D | undefined) => obj?.traverse((o) => {
      const m = o as THREE.Mesh & { material: THREE.ShaderMaterial };
      if ((o as THREE.Mesh).isMesh && m.material?.uniforms?.tint) m.material.uniforms.tint.value.set(tint ? tint[0] : 1, tint ? tint[1] : 1, tint ? tint[2] : 1);
    });
    apply(this.rigs.get('cloth:' + name)?.root);
    apply(this.statics.get(name));
    if (e.kind === 'composite') await this.recompositeBody();
  }
  heldState(): { name: string; hand: 'right' | 'left'; hidden: boolean; attachments: { slot: string; option: AttachOption }[] }[] {
    return [...this.held.entries()].map(([name, h]) => ({
      name, hand: this.heldHand(name)!, hidden: this.hidden.has(name),
      attachments: [...h.attachSel.entries()].map(([slot, option]) => ({ slot, option })),
    }));
  }
  async clearAllHeld() { for (const name of [...this.held.keys()]) this.unequipHeld(name); }

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

  async toggleClothing(item: { name: string; layer?: number }, tint: number[] | null = null) {
    if (this.equipped.has(item.name)) { await this.unequipClothing(item.name); return false; }
    const r = await resolveClothing(this.ctx, item, this.gender);
    if (r.error) throw new Error(r.error);
    const layer = typeof item.layer === 'number' ? item.layer : -1; // PZ BodyLocations draw order
    const entry: Equip = { kind: r.kind, maskTextures: r.maskTextures || [], baseTextures: r.baseTextures || [], tint, hatCategory: r.hatCategory || null, layer };
    if (r.kind === 'mesh') {
      const tex = r.texture ? await bytesToTexture(r.texture, false) : this.white();
      const root = await this.loadSkinnedRoot(r.meshGlb, tex, tint, true); // tint -> shader tint uniform
      // Draw overlapping garment meshes in body-location order so the outer one wins coincident
      // surfaces (no arbitrary z-fight); +1 keeps every garment above the base body (renderOrder 0).
      root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.renderOrder = 1 + Math.max(layer, 0); });
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

  private async attachStatic(name: string, r: { meshGlb: Uint8Array; texture: Uint8Array | null; attachBone?: string | null; subMesh?: string | null }, tint: number[] | null = null) {
    const body = this.rigs.bodyRig();
    if (!body) return;
    let skeleton: THREE.Skeleton | null = null;
    body.root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && !skeleton) skeleton = sm.skeleton; });
    if (!skeleton) throw new Error('no body skeleton to attach to');
    // Attach to the item's named bone when it exists. A static item with no attach bone (or an unknown
    // one - common in mods) used to default onto Bip01_Head, dumping mis-configured garments on the head.
    // Fall back to the body root so it renders at its own authored position instead of on the head.
    const bone = r.attachBone ? (skeleton as THREE.Skeleton).bones.find((b) => b.name === r.attachBone) : null;
    const parent: THREE.Object3D = bone || body.root;
    const gltf = await glbToGltf(r.meshGlb);
    const obj = gltf.scene;
    isolateSubMesh(obj, r.subMesh); // modular model file: keep only the named part
    const tex = r.texture ? await bytesToTexture(r.texture, false) : this.white();
    const mat = makeMaterial(tex, this.lightingObj(), true);
    if (tint) mat.uniforms.tint.value.set(tint[0], tint[1], tint[2]);
    obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
    parent.add(obj);
    this.statics.set(name, obj);
  }

  private detachStatic(name: string) {
    const obj = this.statics.get(name);
    if (obj?.parent) obj.parent.remove(obj);
    this.statics.delete(name);
  }

  // ---- body attachments (item on the player: bat on back, gun in a worn holster, light on webbing) ----

  /** Mount a held item's model at a body location. `transform` is the location's bone + PZ-space
   *  offset/rotate/scale (A_parent); the item's own attachment of the same name (A_self, usually
   *  absent) is composed on top - exactly the game's Bone x A_parent x A_self. One item per slot. */
  async attachToBody(item: BodyAttachItem, slotType: string, attachmentName: string, transform: BodyTransform): Promise<boolean> {
    const body = this.rigs.bodyRig();
    if (!body) return false;
    const bone = body.root.getObjectByName(transform.bone);
    if (!bone) throw new Error(`body attach bone not found: ${transform.bone}`);
    const r = await resolveHeldItem(this.ctx, item); // needs mesh/texture/scale, not just the name
    if (r.error) throw new Error(r.error);
    const gltf = await glbToGltf(r.meshGlb);
    const obj = gltf.scene;
    isolateSubMesh(obj, r.subMesh); // modular model file: keep only the named part
    const tex = r.texture ? await bytesToTexture(r.texture, false) : this.white();
    const mat = makeMaterial(tex, this.lightingObj(), true);
    obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
    if (r.scale && r.scale !== 1) obj.scale.setScalar(r.scale);
    const selfAtt = (item.allAttachments && item.allAttachments[attachmentName]) || null; // optional per-item fine-tune
    const holder = new THREE.Object3D();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(partMatrix(transform, selfAtt)); // Bone(implicit) x A_parent(body location) x A_self(item)
    holder.add(obj);
    this.detachFromBody(slotType); // one item per slot
    bone.add(holder);
    this.bodyAttached.set(slotType, { obj: holder, itemName: item.name, attachmentName, transform });
    return true;
  }

  detachFromBody(slotType: string) {
    const cur = this.bodyAttached.get(slotType);
    if (cur?.obj.parent) cur.obj.parent.remove(cur.obj);
    this.bodyAttached.delete(slotType);
  }

  /** What is attached in each slot (for the UI + save/restore). */
  bodyAttachState(): { slotType: string; itemName: string; attachmentName: string; transform: BodyTransform }[] {
    return [...this.bodyAttached.entries()].map(([slotType, v]) => ({ slotType, itemName: v.itemName, attachmentName: v.attachmentName, transform: v.transform }));
  }
  clearBodyAttachments() { for (const s of [...this.bodyAttached.keys()]) this.detachFromBody(s); }

  isHeld(name: string) { return this.held.has(name); }

  async toggleHeld(item: { name: string }, hand: 'right' | 'left' = 'right') {
    if (this.held.has(item.name)) { this.unequipHeld(item.name); return false; }
    return await this.attachHeld(item, hand);
  }

  /** Which hand a currently-held item is in, or null if it isn't held. */
  heldHand(name: string): 'right' | 'left' | null {
    const h = this.held.get(name);
    return h ? (h.prop === CharacterEngine.LEFT_PROP ? 'left' : 'right') : null;
  }

  /** Move an already-held item to the other hand, preserving its hidden state + attachments. */
  async setHeldHand(name: string, hand: 'right' | 'left') {
    const h = this.held.get(name);
    if (!h || this.heldHand(name) === hand) return;
    const item = h.item;
    const keep = h.attachSel;
    if (h.holder.parent) h.holder.parent.remove(h.holder);
    this.held.delete(name); // keep this.hidden so attachHeld restores the hidden flag
    await this.attachHeld(item, hand, keep);
  }

  private async attachHeld(item: { name: string }, hand: 'right' | 'left', keepAttach?: Map<string, AttachOption>): Promise<boolean> {
    const body = this.rigs.bodyRig();
    if (!body) return false;
    const prop = hand === 'left' ? CharacterEngine.LEFT_PROP : CharacterEngine.RIGHT_PROP;
    const r = await resolveHeldItem(this.ctx, item);
    if (r.error) throw new Error(r.error);
    // left hand may lack a dedicated prop bone on some rigs; fall back to the right so the item
    // still attaches rather than throwing.
    const bone = body.root.getObjectByName(prop) || body.root.getObjectByName(CharacterEngine.RIGHT_PROP);
    if (!bone) throw new Error(`hand bone not found: ${prop}`);
    // prefer the attachment authored for this bone; fall back to the right-hand grip so a
    // left-held item without its own Prop2 offset still sits in the hand.
    const att = (r.attachments && (r.attachments[prop] || r.attachments[CharacterEngine.RIGHT_PROP])) || null;
    const gltf = await glbToGltf(r.meshGlb);
    const obj = gltf.scene;
    isolateSubMesh(obj, r.subMesh); // modular model file (e.g. one FBX of weapon parts): keep only the named part
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
    holder.visible = !this.hidden.has(item.name);
    bone.add(holder);
    this.held.set(item.name, { holder, prop, item, gunObj: obj, parts: new Map(), attachSel: new Map() });
    // re-mount attachments carried over (e.g. across a hand swap)
    if (keepAttach) for (const [slot, opt] of keepAttach) await this.setHeldAttachment(item.name, slot, opt);
    return true;
  }

  /** Which weapon-part option (if any) is mounted in a held gun's slot, by part name. */
  heldAttachment(name: string, slot: string): string | null {
    return this.held.get(name)?.attachSel.get(slot)?.partName ?? null;
  }

  /** Mount (or, with option=null, clear) a weapon part in the given slot of a held gun. */
  async setHeldAttachment(name: string, slot: string, option: AttachOption | null) {
    const h = this.held.get(name);
    if (!h) return;
    const prev = h.parts.get(slot);
    if (prev) { if (prev.parent) prev.parent.remove(prev); h.parts.delete(slot); h.attachSel.delete(slot); }
    if (!option) return;
    const r = await resolveAttachmentPart(this.ctx, option);
    if (r.error) throw new Error(r.error);
    if (!this.held.has(name)) return; // item was removed mid-load
    const gltf = await glbToGltf(r.meshGlb);
    const obj = gltf.scene;
    isolateSubMesh(obj, r.subMesh); // modular model file: keep only the named part
    const tex = r.texture ? await bytesToTexture(r.texture, false) : this.white();
    const mat = makeMaterial(tex, this.lightingObj(), true);
    obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals(); m.material = mat; m.frustumCulled = false; } });
    const partHolder = new THREE.Object3D();
    partHolder.matrixAutoUpdate = false;
    partHolder.matrix.copy(partMatrix(r.parentAttachment, r.selfAttachment));
    partHolder.add(obj);
    h.gunObj.add(partHolder);          // child of the gun mesh, so it inherits the hold + animation
    h.parts.set(slot, partHolder);
    h.attachSel.set(slot, option);
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
