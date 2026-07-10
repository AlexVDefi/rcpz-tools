// Shared three.js core for the Character viewer (ESM, runs in the renderer).
// Reuses the icon shader's FRAG lighting, but the vertex shader adds GPU skinning
// so the body deforms under animation. The icon path's ShaderMaterial had no
// skinning chunks, which is why it needs its own material here.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FRAG, fileUrl, loadTexture, makeMaterial, partMatrix } from '../renderWorker/renderCore.js';

THREE.ColorManagement.enabled = false;

// Skinned vertex shader: standard three skinning chunks feed `transformed` and
// `objectNormal`, then the same view-space normal + UV varyings the FRAG expects.
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

// Character lighting is CAMERA-RELATIVE (the FRAG lights a view-space normal against
// this fixed view-space direction). Keep it dominated by +Z (the camera direction)
// so whatever faces the viewer stays lit at any orbit/iso angle, with only a gentle
// top bias for form -- an up-heavy key would light the top of the head and let the
// forward-facing centre of the face fall into shadow when the view is tilted.
export const CHAR_LIGHTING = { ambient: [0.55, 0.55, 0.55], keyDir: [0.12, 0.28, 1.0], keyColour: [0.5, 0.5, 0.5] };

export function makeSkinnedMaterial(texture, lighting = CHAR_LIGHTING, doubleSide = true) {
  const ambient = lighting.ambient ?? CHAR_LIGHTING.ambient;
  const keyDir = lighting.keyDir ?? CHAR_LIGHTING.keyDir;
  const keyColour = lighting.keyColour ?? CHAR_LIGHTING.keyColour;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      ambient: { value: new THREE.Vector3(...ambient) },
      keyDir: { value: new THREE.Vector3(...keyDir) },
      keyColour: { value: new THREE.Vector3(...keyColour) },
      tint: { value: new THREE.Vector3(1, 1, 1) },
    },
    vertexShader: SKIN_VERT,
    fragmentShader: FRAG,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: false,
    blending: THREE.NoBlending,
  });
  return mat;
}

const gltfLoader = new GLTFLoader();
export function loadGlb(p) {
  return new Promise((resolve, reject) =>
    gltfLoader.load(fileUrl(p), (g) => resolve(g), undefined, reject));
}

/**
 * Minimal orbit controller: drag to rotate, wheel to zoom, around a fixed target.
 * Avoids vendoring three's OrbitControls (not in the copied addon set).
 */
export function makeOrbit(getCamera, dom, target = new THREE.Vector3(0, 0.5, 0)) {
  const state = { radius: 2.2, theta: Math.PI * 0.5, phi: Math.PI * 0.42, target };
  let dragging = false, lastX = 0, lastY = 0;

  function apply() {
    const camera = typeof getCamera === 'function' ? getCamera() : getCamera;
    const { radius, theta, phi } = state;
    const sp = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
    state.phi = sp;
    camera.position.set(
      target.x + radius * Math.sin(sp) * Math.cos(theta),
      target.y + radius * Math.cos(sp),
      target.z + radius * Math.sin(sp) * Math.sin(theta));
    camera.lookAt(target);
    // an orthographic camera zooms by frustum size, not distance, so map the
    // orbit radius onto the ortho half-height (aspect keeps it square-ish)
    if (camera.isOrthographicCamera) {
      const h = radius * 0.42, w = h * (camera.__aspect || 1);
      camera.left = -w; camera.right = w; camera.top = h; camera.bottom = -h;
      camera.updateProjectionMatrix();
    }
  }
  const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
  const onUp = () => { dragging = false; };
  const onMove = (e) => {
    if (!dragging) return;
    state.theta -= (e.clientX - lastX) * 0.01;
    state.phi -= (e.clientY - lastY) * 0.01;
    lastX = e.clientX; lastY = e.clientY;
    apply();
  };
  const onWheel = (e) => {
    e.preventDefault();
    state.radius = Math.max(0.6, Math.min(8, state.radius * (1 + Math.sign(e.deltaY) * 0.1)));
    apply();
  };
  dom.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('mousemove', onMove);
  dom.addEventListener('wheel', onWheel, { passive: false });
  apply();
  return { state, apply, setTarget: (t) => { target.copy(t); apply(); } };
}

export { THREE, loadTexture, makeMaterial, partMatrix };
