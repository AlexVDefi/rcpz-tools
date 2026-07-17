// Animation clip normalisation + rest-delta retargeting. Faithful port of
// src/characterApp/anim.js — the byte-identical WASM converter (verified in Phase 0.2)
// produces the same bone names + bind quats the native DLL did, so this retarget logic
// applies unchanged.
import * as THREE from 'three';

const HIP_TRACK = 'Bip01.position';
const QUAT_TRACK = /\.quaternion$/;

function retargetRestDelta(clip: THREE.AnimationClip, clipRest: Map<string, THREE.Quaternion>, bodyRest: Map<string, THREE.Quaternion>) {
  const delta = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const inv = new THREE.Quaternion();
  for (const track of clip.tracks) {
    if (!QUAT_TRACK.test(track.name)) continue;
    const bone = track.name.replace(QUAT_TRACK, '');
    const br = bodyRest.get(bone), cr = clipRest.get(bone);
    if (!br || !cr) continue;
    inv.copy(cr).invert();
    delta.copy(br).multiply(inv);
    if (Math.abs(delta.w) > 0.99999) continue;
    const v = track.values;
    for (let i = 0; i < v.length; i += 4) {
      q.set(v[i], v[i + 1], v[i + 2], v[i + 3]).premultiply(delta);
      v[i] = q.x; v[i + 1] = q.y; v[i + 2] = q.z; v[i + 3] = q.w;
    }
  }
}

export interface NormalisedClip { clip: THREE.AnimationClip; rootRotationX: number; best: boolean; }

export function normaliseClip(
  clip: THREE.AnimationClip,
  format: string,
  ctx: { clipRest?: Map<string, THREE.Quaternion>; bodyRest?: Map<string, THREE.Quaternion> } = {},
): NormalisedClip {
  const fmt = String(format).toLowerCase();
  if (fmt === 'glb' || fmt === 'gltf') {
    const c = clip.clone();
    c.tracks = c.tracks.filter((t) => QUAT_TRACK.test(t.name));
    if (ctx.clipRest && ctx.bodyRest) {
      retargetRestDelta(c, ctx.clipRest, ctx.bodyRest);
      return { clip: c, rootRotationX: 0, best: false };
    }
    return { clip: c, rootRotationX: -Math.PI / 2, best: false };
  }
  if (fmt === 'fbx') {
    const c = clip.clone();
    c.tracks = c.tracks.filter((t) => t.name !== HIP_TRACK);
    return { clip: c, rootRotationX: -Math.PI / 2, best: false };
  }
  return { clip, rootRotationX: 0, best: true };
}

/** bone -> bind-local rotation, from a freshly loaded (unposed) rig root. */
export function boneRestMap(root: THREE.Object3D): Map<string, THREE.Quaternion> {
  const m = new Map<string, THREE.Quaternion>();
  root.traverse((o) => { if ((o as THREE.Bone).isBone) m.set(o.name, o.quaternion.clone()); });
  return m;
}

/** Reconcile a mod clothing/hair rig's Blender-suffixed root bone names with the body. */
export function normalizeClothingRig(root: THREE.Object3D) {
  root.traverse((o) => { if (o.name) o.name = o.name.replace(/^(Dummy01|Bip01)(?:\.\d+|\d{2,})$/, '$1'); });
}
