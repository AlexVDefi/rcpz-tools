// Faithful port of the pure-Three.js pieces of src/renderWorker/renderCore.js and
// src/characterApp/charCore.js - shaders, materials, attachment math, orbit, icon
// layout. No I/O here: the file:// loaders are replaced by byte loaders (loaders.ts).
// The camera/shader/handedness constants are reverse-engineered from PZ's own renderer;
// they must match the Electron app exactly, so this is a copy, not a reinterpretation.
import * as THREE from 'three';

THREE.ColorManagement.enabled = false;
const DEG = Math.PI / 180;

export const VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normalMatrix * normal;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const FRAG = /* glsl */`
  uniform sampler2D map;
  uniform vec3 ambient;
  uniform vec3 keyDir;
  uniform vec3 keyColour;
  uniform vec3 tint;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vec4 tex = texture2D(map, vUv);
    if (tex.a < 0.01) discard;
    vec3 N = normalize(vNormal);
    float d = max(dot(N, normalize(keyDir)), 0.0);
    vec3 lighting = min(ambient + keyColour * d, vec3(1.0));
    gl_FragColor = vec4(tex.rgb * tint * lighting, tex.a);
  }
`;

// Skinned vertex shader: standard three skinning chunks feed the same view-space
// normal + UV varyings the FRAG expects.
export const SKIN_VERT = /* glsl */`
  #include <common>
  #include <skinning_pars_vertex>
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    vNormal = normalMatrix * objectNormal;
    vUv = uv;
    #include <begin_vertex>
    #include <skinning_vertex>
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }
`;

export const CHAR_LIGHTING = { ambient: [0.55, 0.55, 0.55], keyDir: [0.12, 0.28, 1.0], keyColour: [0.5, 0.5, 0.5] };

type Lighting = { ambient?: number[]; keyDir?: number[]; keyColour?: number[] };

export function makeMaterial(texture: THREE.Texture, lighting: Lighting = {}, doubleSide = true) {
  const ambient = lighting.ambient ?? [0.6, 0.6, 0.6];
  const keyDir = lighting.keyDir ?? [0, -2, 5];
  const keyColour = lighting.keyColour ?? [0.5, 0.5, 0.5];
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      ambient: { value: new THREE.Vector3(...(ambient as [number, number, number])) },
      keyDir: { value: new THREE.Vector3(...(keyDir as [number, number, number])) },
      keyColour: { value: new THREE.Vector3(...(keyColour as [number, number, number])) },
      tint: { value: new THREE.Vector3(1, 1, 1) },
    },
    vertexShader: VERT, fragmentShader: FRAG,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: false, blending: THREE.NoBlending,
  });
}

export function makeSkinnedMaterial(texture: THREE.Texture, lighting: Lighting = CHAR_LIGHTING, doubleSide = true) {
  const ambient = lighting.ambient ?? CHAR_LIGHTING.ambient;
  const keyDir = lighting.keyDir ?? CHAR_LIGHTING.keyDir;
  const keyColour = lighting.keyColour ?? CHAR_LIGHTING.keyColour;
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      ambient: { value: new THREE.Vector3(...(ambient as [number, number, number])) },
      keyDir: { value: new THREE.Vector3(...(keyDir as [number, number, number])) },
      keyColour: { value: new THREE.Vector3(...(keyColour as [number, number, number])) },
      tint: { value: new THREE.Vector3(1, 1, 1) },
    },
    vertexShader: SKIN_VERT, fragmentShader: FRAG,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: false, blending: THREE.NoBlending,
  });
}

// attachment placement (game's left-handed model space -> three)
type Attachment = { offset: number[]; rotate: number[]; scale?: number };
export function attachmentMatrix(a: Attachment) {
  const m = new THREE.Matrix4().makeTranslation(a.offset[0], a.offset[1], a.offset[2]);
  m.multiply(new THREE.Matrix4().makeRotationX(a.rotate[0] * DEG));
  m.multiply(new THREE.Matrix4().makeRotationY(a.rotate[1] * DEG));
  m.multiply(new THREE.Matrix4().makeRotationZ(a.rotate[2] * DEG));
  const s = (typeof a.scale === 'number' && a.scale) ? a.scale : 1;
  m.multiply(new THREE.Matrix4().makeScale(s, s, s));
  return m;
}
const HAND_FLIP = new THREE.Matrix4().makeScale(1, 1, -1);
const toThreeSpace = (A: THREE.Matrix4) => HAND_FLIP.clone().multiply(A).multiply(HAND_FLIP);
export function partMatrix(parentAttachment: Attachment | null, selfAttachment: Attachment | null) {
  const m = parentAttachment ? toThreeSpace(attachmentMatrix(parentAttachment)) : new THREE.Matrix4();
  if (selfAttachment) m.multiply(toThreeSpace(attachmentMatrix(selfAttachment)));
  return m;
}

// Orbit controller: left-drag rotates, right-drag pans, wheel zooms. `onInteract` fires
// on drag start (the viewer uses it to leave the locked PZ-iso camera). Suppresses the
// right-click context menu so panning doesn't pop the native menu.
export function makeOrbit(getCamera: () => THREE.Camera, dom: HTMLElement, target = new THREE.Vector3(0, 0.5, 0)) {
  const state = { radius: 2.2, theta: Math.PI * 0.5, phi: Math.PI * 0.42, target };
  let mode: 'none' | 'rotate' | 'pan' = 'none';
  let lastX = 0, lastY = 0;
  // lockRotate: while the scene builder is active, left-drag must NOT rotate/leave the iso camera (it
  // places tiles instead) - but right-drag pan and wheel zoom stay live.
  const api = { state, apply, setTarget, dispose, lockRotate: false, onInteract: undefined as (() => void) | undefined, onAdjust: undefined as (() => void) | undefined };

  function apply() {
    const camera = getCamera() as THREE.PerspectiveCamera & THREE.OrthographicCamera & { __aspect?: number };
    const { radius, theta, phi } = state;
    const sp = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
    state.phi = sp;
    camera.position.set(
      target.x + radius * Math.sin(sp) * Math.cos(theta),
      target.y + radius * Math.cos(sp),
      target.z + radius * Math.sin(sp) * Math.sin(theta));
    camera.lookAt(target);
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const h = radius * 0.42, w = h * (camera.__aspect || 1);
      camera.left = -w; camera.right = w; camera.top = h; camera.bottom = -h;
      camera.updateProjectionMatrix();
    }
  }

  const right = new THREE.Vector3(), up = new THREE.Vector3();
  function pan(dx: number, dy: number) {
    const cam = getCamera() as THREE.PerspectiveCamera & THREE.OrthographicCamera;
    cam.updateMatrixWorld();
    right.setFromMatrixColumn(cam.matrixWorld, 0);
    up.setFromMatrixColumn(cam.matrixWorld, 1);
    const h = (dom as HTMLElement).clientHeight || 1;
    const scale = cam.isOrthographicCamera ? (cam.top - cam.bottom) / h : (2 * state.radius * Math.tan((cam.fov * Math.PI / 180) / 2)) / h;
    target.addScaledVector(right, -dx * scale);
    target.addScaledVector(up, dy * scale);
    apply();
  }

  const onDown = (e: MouseEvent) => {
    if (e.button === 2) { mode = 'pan'; e.preventDefault(); } // pan keeps the current (e.g. iso) camera
    else if (e.button === 0 && !api.lockRotate) { mode = 'rotate'; api.onInteract?.(); } // only rotating leaves a locked camera
    else return; // left-button while lockRotate: leave it to the tile placer (no orbit action)
    api.onAdjust?.();
    lastX = e.clientX; lastY = e.clientY;
  };
  const onUp = () => { mode = 'none'; };
  const onMove = (e: MouseEvent) => {
    if (mode === 'none') return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (mode === 'rotate') { state.theta -= dx * 0.01; state.phi -= dy * 0.01; apply(); }
    else pan(dx, dy);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    api.onAdjust?.();
    state.radius = Math.max(0.6, Math.min(8, state.radius * (1 + Math.sign(e.deltaY) * 0.1)));
    apply();
  };
  const onContext = (e: Event) => e.preventDefault();

  // Touch: one finger rotates, two fingers pinch-zoom + drag-pan. Additive to the mouse handlers
  // (touch events don't fire from a desktop mouse), so desktop behaviour is unchanged. The canvas
  // sets touch-action:none so these gestures don't scroll/zoom the page.
  let pinch = 0;
  const onTouchStart = (e: TouchEvent) => {
    api.onAdjust?.();
    if (e.touches.length === 1 && !api.lockRotate) { mode = 'rotate'; api.onInteract?.(); lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }
    else if (e.touches.length >= 2) {
      mode = 'pan';
      const a = e.touches[0], b = e.touches[1];
      lastX = (a.clientX + b.clientX) / 2; lastY = (a.clientY + b.clientY) / 2;
      pinch = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    if (mode === 'none') return;
    e.preventDefault();
    if (e.touches.length === 1 && mode === 'rotate') {
      const dx = e.touches[0].clientX - lastX, dy = e.touches[0].clientY - lastY;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      state.theta -= dx * 0.01; state.phi -= dy * 0.01; apply();
    } else if (e.touches.length >= 2) {
      const a = e.touches[0], b = e.touches[1];
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch > 0 && dist > 0) state.radius = Math.max(0.6, Math.min(8, state.radius * (pinch / dist)));
      pinch = dist;
      pan(cx - lastX, cy - lastY); // pan() calls apply(), which also picks up the new radius
      lastX = cx; lastY = cy;
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length === 0) { mode = 'none'; pinch = 0; }
    else if (e.touches.length === 1) { mode = 'rotate'; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }
  };

  dom.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('mousemove', onMove);
  dom.addEventListener('wheel', onWheel, { passive: false });
  dom.addEventListener('contextmenu', onContext);
  dom.addEventListener('touchstart', onTouchStart, { passive: false });
  dom.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd);
  apply();

  function setTarget(t: THREE.Vector3) { target.copy(t); apply(); }
  function dispose() {
    dom.removeEventListener('mousedown', onDown);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('mousemove', onMove);
    dom.removeEventListener('wheel', onWheel);
    dom.removeEventListener('contextmenu', onContext);
    dom.removeEventListener('touchstart', onTouchStart);
    dom.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
  }
  return api;
}

export { THREE };
