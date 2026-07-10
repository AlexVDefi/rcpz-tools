// Animation clip normalisation for the character viewer (ESM, renderer side).
//
// Per the P0 spike:
//   .x and in-convention .glb clips retarget onto the body by bone name and play
//   upright with NO normalisation.
//   .fbx clips are authored in a different root frame: raw they render tipped and
//   hip-sunk. An Rx(-90) applied at the character root brings them upright, and
//   dropping the root hip-position track keeps the bind hip height.
//
// Binding is by case-insensitive bone name; three's mixer already matches the
// track node names (Bip01_*) against the body's bones.

const HIP_TRACK = 'Bip01.position';

/**
 * Prepare a loaded clip for playback on the body.
 * @param {THREE.AnimationClip} clip
 * @param {string} format  'x' | 'glb' | 'gltf' | 'fbx'
 * @returns {{ clip: THREE.AnimationClip, rootRotationX: number, best: boolean }}
 */
export function normaliseClip(clip, format) {
  const fmt = String(format).toLowerCase();
  if (fmt === 'fbx') {
    const c = clip.clone();
    // keep bind hip height instead of the clip's zeroed root position
    c.tracks = c.tracks.filter((t) => t.name !== HIP_TRACK);
    return { clip: c, rootRotationX: -Math.PI / 2, best: false };
  }
  return { clip, rootRotationX: 0, best: true };
}
