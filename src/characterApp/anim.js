// Animation clip normalisation for the character viewer (ESM, renderer side).
//
// The body rig is always the vanilla .x skeleton (via assimp): a
// `$dummy_root / Dummy01(Rx+90) / Bip01 / ...` chain in metres. Clips retarget
// onto it by bone name (three's mixer matches Bip01_* track nodes to the body's
// bones). How a clip must be prepared depends on the convention it was authored in:
//
//   .x  (and the tool's own .x->glb conversions, tagged 'x'): same pipeline as the
//        body -- metres, matching root frame -> play as-is, no normalisation.
//
//   .fbx (assimp-converted mod clip): metre-scale like the body, but authored in a
//        root frame tipped +90deg about X. Rx(-90) at the character root uprights
//        it; drop the root hip-position track to keep the bind hip height.
//
//   .glb / .gltf (a modder's hand-export straight from Blender/Max): a DIFFERENT
//        skeleton root chain (`Bip01(S=0.01)/Bip01_Root/Bip01`) with every bone
//        carrying a CENTIMETRE-scale position track -- retargeting those raw
//        positions onto the metre body would explode it 100x. We keep only the
//        ROTATION tracks (bone lengths come from the body's own bind pose) and
//        REST-DELTA retarget them: each bone is re-anchored to the body's own bind
//        orientation and driven by the clip's rest-relative rotation, so the export's
//        arbitrary root framing (up-axis, unit dummies) is cancelled without any
//        hand-tuned angle. Falls back to a plain Rx(-90) if the rest maps are absent.
//
// Binding is by case-insensitive bone name; three's mixer already matches the
// track node names (Bip01_*) against the body's bones.

import * as THREE from 'three';

const HIP_TRACK = 'Bip01.position';
const QUAT_TRACK = /\.quaternion$/;

/**
 * Re-anchor every rotation track onto the body's own bind pose:
 *   body.local(t) = body.rest . clip.rest^-1 . clip.local(t)
 * For bones whose rest matches (all but the root of a differently-framed export)
 * the delta is identity and the track passes through untouched.
 * @param {THREE.AnimationClip} clip  cloned clip, mutated in place
 * @param {Map<string,THREE.Quaternion>} clipRest  bone -> clip bind-local rotation
 * @param {Map<string,THREE.Quaternion>} bodyRest  bone -> body bind-local rotation
 */
function retargetRestDelta(clip, clipRest, bodyRest) {
  const delta = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const inv = new THREE.Quaternion();
  for (const track of clip.tracks) {
    if (!QUAT_TRACK.test(track.name)) continue;
    const bone = track.name.replace(QUAT_TRACK, '');
    const br = bodyRest.get(bone), cr = clipRest.get(bone);
    if (!br || !cr) continue;
    inv.copy(cr).invert();
    delta.copy(br).multiply(inv);           // body.rest . clip.rest^-1
    if (Math.abs(delta.w) > 0.99999) continue; // ~identity: nothing to correct
    const v = track.values;
    for (let i = 0; i < v.length; i += 4) {
      q.set(v[i], v[i + 1], v[i + 2], v[i + 3]).premultiply(delta); // delta . clip.local
      v[i] = q.x; v[i + 1] = q.y; v[i + 2] = q.z; v[i + 3] = q.w;
    }
  }
}

/**
 * Prepare a loaded clip for playback on the body.
 * @param {THREE.AnimationClip} clip
 * @param {string} format  'x' | 'glb' | 'gltf' | 'fbx'
 * @param {{clipRest?:Map<string,THREE.Quaternion>, bodyRest?:Map<string,THREE.Quaternion>}} [ctx]
 *        bind-pose rotation maps for rest-delta retargeting (glb/gltf only)
 * @returns {{ clip: THREE.AnimationClip, rootRotationX: number, best: boolean }}
 */
export function normaliseClip(clip, format, ctx = {}) {
  const fmt = String(format).toLowerCase();

  if (fmt === 'glb' || fmt === 'gltf') {
    const c = clip.clone();
    // rotation-only: drop the export's centimetre position (and scale) tracks
    c.tracks = c.tracks.filter((t) => QUAT_TRACK.test(t.name));
    if (ctx.clipRest && ctx.bodyRest) {
      retargetRestDelta(c, ctx.clipRest, ctx.bodyRest);
      return { clip: c, rootRotationX: 0, best: false };
    }
    // no rest maps: best-effort single-axis upright
    return { clip: c, rootRotationX: -Math.PI / 2, best: false };
  }

  if (fmt === 'fbx') {
    const c = clip.clone();
    // keep bind hip height instead of the clip's zeroed root position
    c.tracks = c.tracks.filter((t) => t.name !== HIP_TRACK);
    return { clip: c, rootRotationX: -Math.PI / 2, best: false };
  }

  return { clip, rootRotationX: 0, best: true };
}

/** Build a bone -> bind-local rotation map from a freshly loaded (unposed) rig root. */
export function boneRestMap(root) {
  const m = new Map();
  root.traverse((o) => { if (o.isBone) m.set(o.name, o.quaternion.clone()); });
  return m;
}
