// Shared three.js core for both the headless batch worker (render.js) and the
// interactive preview UI (previewApp/preview.js), so both use the identical
// camera, shader, and framing. Runs in an Electron renderer as an ES module.

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Match PZ: no color management round-trip, straight gamma-space multiply.
THREE.ColorManagement.enabled = false;

const DEG = Math.PI / 180;

export const VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normalMatrix * normal;   // view-space normal
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const FRAG = /* glsl */`
  uniform sampler2D map;
  uniform vec3 ambient;
  uniform vec3 keyDir;     // view-space direction toward the key light
  uniform vec3 keyColour;
  uniform vec3 tint;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vec4 tex = texture2D(map, vUv);
    if (tex.a < 0.01) discard;                 // PZ alpha cutout
    vec3 N = normalize(vNormal);
    float d = max(dot(N, normalize(keyDir)), 0.0);
    vec3 lighting = min(ambient + keyColour * d, vec3(1.0));
    gl_FragColor = vec4(tex.rgb * tint * lighting, tex.a);
  }
`;

export function fileUrl(p) { return 'file:///' + String(p).replace(/\\/g, '/'); }

const texLoader = new THREE.TextureLoader();
const fbxLoader = new FBXLoader();
const gltfLoader = new GLTFLoader();

export function loadTexture(path, flipY) {
  return new Promise((resolve, reject) => {
    texLoader.load(fileUrl(path), (t) => {
      t.flipY = flipY;
      t.colorSpace = THREE.NoColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      resolve(t);
    }, undefined, reject);
  });
}

export function loadMesh(path, format) {
  const url = fileUrl(path);
  return new Promise((resolve, reject) => {
    if (format === 'glb' || format === 'gltf') gltfLoader.load(url, (g) => resolve(g.scene), undefined, reject);
    else if (format === 'fbx') fbxLoader.load(url, (g) => resolve(g), undefined, reject);
    else reject(new Error(`unsupported mesh format for renderer: ${format} (convert .x to .glb first)`));
  });
}

export function makeMaterial(texture, lighting = {}, doubleSide = true) {
  const ambient = lighting.ambient ?? [0.6, 0.6, 0.6];
  const keyDir = lighting.keyDir ?? [0, -2, 5];
  const keyColour = lighting.keyColour ?? [0.5, 0.5, 0.5];
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      ambient: { value: new THREE.Vector3(...ambient) },
      keyDir: { value: new THREE.Vector3(...keyDir) },
      keyColour: { value: new THREE.Vector3(...keyColour) },
      tint: { value: new THREE.Vector3(1, 1, 1) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: false,
    blending: THREE.NoBlending,
  });
}

/**
 * Transform for one model attachment point, as the game composes it:
 *   A = T(offset) * Rx(rx) * Ry(ry) * Rz(rz) * S(uniform scale)
 * Rotations and scale post-multiply, matching three's Matrix4.multiply.
 */
export function attachmentMatrix(a) {
  const m = new THREE.Matrix4().makeTranslation(a.offset[0], a.offset[1], a.offset[2]);
  m.multiply(new THREE.Matrix4().makeRotationX(a.rotate[0] * DEG));
  m.multiply(new THREE.Matrix4().makeRotationY(a.rotate[1] * DEG));
  m.multiply(new THREE.Matrix4().makeRotationZ(a.rotate[2] * DEG));
  const s = (typeof a.scale === 'number' && a.scale) ? a.scale : 1;
  m.multiply(new THREE.Matrix4().makeScale(s, s, s));
  return m;
}

// The game imports every mesh into a left-handed coordinate space, which mirrors
// the Z axis; three.js keeps the original right-handed data. Attachment
// offsets/rotations are authored in that left-handed model space, so they must be
// conjugated into three's space before use:
//
//   A_three = M * A_pz * M      M = diag(1, 1, -1),  M * M = I
//
// which negates offset.z and the X/Y rotations (Z rotation and uniform scale are
// unchanged). Without this, parts land mirrored front-to-back on their parent.
const HAND_FLIP = new THREE.Matrix4().makeScale(1, 1, -1);
function toThreeSpace(A) { return HAND_FLIP.clone().multiply(A).multiply(HAND_FLIP); }

/**
 * Placement of a weapon part on its parent, as the game computes it:
 *   partTransform = A(parentAttachment) * A(selfAttachment)
 * The part's own attachment transform is composed directly, not inverted.
 * Each factor is converted from the game's left-handed model space into three's.
 */
export function partMatrix(parentAttachment, selfAttachment) {
  const m = parentAttachment ? toThreeSpace(attachmentMatrix(parentAttachment)) : new THREE.Matrix4();
  if (selfAttachment) m.multiply(toThreeSpace(attachmentMatrix(selfAttachment)));
  return m;
}

/**
 * Build the icon scene: apply the shader material to the model, attach any weapon
 * parts in the parent's local space, orient at the icon camera angle, center, and
 * size a square ortho camera with a generous safety margin (real edge-to-edge
 * framing is done by the alpha-trim in post).
 *
 * `params.attachments` = [{ model, texture, parentAttachment, selfAttachment }]
 * @returns {{scene, camera, group, material, materials}}
 */
export function layoutIconScene(model, texture, params = {}) {
  const pitch = (params.pitch ?? 30) * DEG;
  const yaw = ((params.yaw ?? 45) + (params.extraYaw ?? 0)) * DEG;
  const extraPitch = (params.extraPitch ?? 0) * DEG;
  const extraRoll = (params.extraRoll ?? 0) * DEG;
  const doubleSide = params.doubleSide ?? true;

  const materials = [];
  const material = makeMaterial(texture, params.lighting, doubleSide);
  materials.push(material);

  // drop attachment holders from a previous layout so they don't accumulate
  for (const c of [...model.children]) if (c.userData && c.userData.__attachHolder) model.remove(c);

  model.traverse((o) => {
    if (o.isMesh && !(o.userData && o.userData.__isPart)) {
      if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
      o.material = material;
    }
  });

  // Attach parts as children of the parent object so they inherit its transform,
  // mirroring the engine (part = sceneMV * parentTransform * partTransform).
  for (const att of (params.attachments || [])) {
    const mat = makeMaterial(att.texture, params.lighting, doubleSide);
    materials.push(mat);
    att.model.traverse((o) => {
      if (o.isMesh) {
        if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
        o.material = mat;
        o.userData.__isPart = true;
      }
    });
    const holder = new THREE.Object3D();
    holder.userData.__attachHolder = true;
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(partMatrix(att.parentAttachment, att.selfAttachment));
    holder.add(att.model);
    model.add(holder);
  }

  // Orientation: baseIso (pitch*yaw) * modelTweak (extraPitch/roll in model space).
  const M = new THREE.Matrix4().makeRotationX(pitch).multiply(new THREE.Matrix4().makeRotationY(yaw));
  M.multiply(new THREE.Matrix4().makeRotationX(extraPitch).multiply(new THREE.Matrix4().makeRotationZ(extraRoll)));

  const group = new THREE.Group();
  group.add(model);
  group.quaternion.setFromRotationMatrix(M);
  group.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  const sizeV = box.getSize(new THREE.Vector3());
  group.position.sub(center);
  group.updateMatrixWorld(true);

  const half = Math.max(sizeV.x, sizeV.y) / 2 * 1.15;
  const depth = Math.max(sizeV.z, 1e-3);
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.001, depth * 2 + 10);
  camera.position.set(0, 0, depth + 5);
  camera.lookAt(0, 0, 0);

  const scene = new THREE.Scene();
  scene.add(group);
  return { scene, camera, group, material, materials };
}

export { THREE };
