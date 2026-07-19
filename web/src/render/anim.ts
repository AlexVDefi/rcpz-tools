// Animation clip normalisation + rest-delta retargeting. Faithful port of
// src/characterApp/anim.js - the byte-identical WASM converter (verified in Phase 0.2)
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

// The body's bind pose, captured once from a freshly-loaded (unposed) rig: enough to
// world-space retarget a foreign-skeleton glb clip onto it. `bindWorld` covers EVERY named
// node (so a bone's static ancestor - e.g. Dummy01's Rx+90 - is available for the parent
// frame); the bone-only maps drive the retarget walk in hierarchy order.
export interface SkeletonBind {
  order: string[];                            // bone names, parent-before-child
  parentName: Map<string, string>;            // bone name -> parent node name
  bindLocal: Map<string, THREE.Quaternion>;   // bone name -> bind local rotation
  bindWorld: Map<string, THREE.Quaternion>;   // ANY node name -> bind world rotation
}

// The TRUE bind-world rotation per joint, from the skin's inverseBindMatrices (= bind world
// matrix inverse). This is authoritative: a node's default TRS is NOT the bind pose for
// exports (e.g. AnimForge/Blender) that leave the node at animation frame 0 - only the skin's
// inverse-bind encodes the pose the mesh was rigged in, which is what skinning actually uses.
function bindWorldFromSkin(root: THREE.Object3D): Map<string, THREE.Quaternion> {
  const m = new Map<string, THREE.Quaternion>();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh || !sm.skeleton) return;
    sm.skeleton.bones.forEach((bone, i) => {
      if (!bone.name) return;
      const q = new THREE.Quaternion();
      sm.skeleton.boneInverses[i].clone().invert().decompose(p, q, s);
      m.set(bone.name, q);
    });
  });
  return m;
}

export function captureSkeletonBind(root: THREE.Object3D): SkeletonBind {
  root.updateMatrixWorld(true);
  const order: string[] = [];
  const parentName = new Map<string, string>();
  const bindLocal = new Map<string, THREE.Quaternion>();
  const bindWorld = new Map<string, THREE.Quaternion>();
  // node-default world for EVERY node (covers non-joint ancestors like Dummy01 for parent frames)
  root.traverse((o) => { if (o.name) bindWorld.set(o.name, o.getWorldQuaternion(new THREE.Quaternion())); });
  // then override joints with the authoritative inverse-bind pose
  for (const [name, q] of bindWorldFromSkin(root)) bindWorld.set(name, q);
  root.traverse((o) => {
    if (!(o as THREE.Bone).isBone || !o.name) return;
    order.push(o.name);
    if (o.parent?.name) parentName.set(o.name, o.parent.name);
    bindLocal.set(o.name, o.quaternion.clone());
  });
  return { order, parentName, bindLocal, bindWorld };
}

const IDENTITY_Q = new THREE.Quaternion();
const boneWorldMap = (root: THREE.Object3D) => {
  const m = new Map<string, THREE.Quaternion>();
  root.updateMatrixWorld(true);
  root.traverse((o) => { if (o.name && (o as THREE.Bone).isBone) m.set(o.name, o.getWorldQuaternion(new THREE.Quaternion())); });
  return m; // deepest duplicate-named node wins (the real joint, not a scale/root proxy)
};

// World-space delta retarget: bake body-local rotation tracks so that each bone reproduces
// the clip's bind-RELATIVE world rotation on the BODY's own bind pose -
//   bodyWorld_b(t) = (clipWorld_b(t) . clipBindWorld_b^-1) . bodyBindWorld_b
//   bodyLocal_b(t) = bodyWorldParent(t)^-1 . bodyWorld_b(t)
// This transfers MOTION (not absolute pose), so it is correct even when the clip's skeleton
// has a different bind pose / root chain than the body - the case custom .glb exports hit,
// which the per-bone rest-delta cannot handle. Rotation only (positions/scale dropped).
function retargetWorld(clip: THREE.AnimationClip, clipScene: THREE.Object3D, body: SkeletonBind, bodyRoot?: THREE.Object3D): THREE.AnimationClip {
  const clipBindWorld = bindWorldFromSkin(clipScene); // authoritative bind (NOT node defaults)
  const timeSet = new Set<number>();
  for (const t of clip.tracks) if (QUAT_TRACK.test(t.name)) for (const time of t.times) timeSet.add(time);
  const times = [...timeSet].sort((a, b) => a - b);
  if (!times.length) return clip;

  const mixer = new THREE.AnimationMixer(clipScene);
  mixer.clipAction(clip).play();

  const mapped = body.order.filter((n) => clipBindWorld.has(n));
  const values = new Map<string, number[]>();
  for (const n of mapped) values.set(n, []);

  const world = new Map<string, THREE.Quaternion>();
  const delta = new THREE.Quaternion(), target = new THREE.Quaternion(), invBind = new THREE.Quaternion(), local = new THREE.Quaternion();

  for (const time of times) {
    mixer.setTime(time);
    const clipNow = boneWorldMap(clipScene);
    world.clear();
    for (const b of body.order) {
      const parent = body.parentName.get(b);
      const pw = (parent && (world.get(parent) || body.bindWorld.get(parent))) || IDENTITY_Q;
      const cBind = clipBindWorld.get(b), cNow = clipNow.get(b), bBind = body.bindWorld.get(b);
      if (cBind && cNow && bBind) {
        invBind.copy(cBind).invert();
        delta.copy(cNow).multiply(invBind);      // clip world delta from its bind
        target.copy(delta).multiply(bBind);      // re-anchored on the body's bind world
        world.set(b, target.clone());
        local.copy(pw).invert().multiply(target);
        values.get(b)!.push(local.x, local.y, local.z, local.w);
      } else {
        world.set(b, pw.clone().multiply(body.bindLocal.get(b)!)); // static bone: keep bind
      }
    }
  }
  mixer.stopAllAction(); mixer.uncacheRoot(clipScene);
  const tracks = mapped.map((n) => new THREE.QuaternionKeyframeTrack(n + '.quaternion', times, values.get(n)!));
  const mappedSet = new Set(mapped);
  if (bodyRoot) retargetAttachments(clip, clipScene, body, bodyRoot, mappedSet, times, tracks);
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

// The skinned-bone retarget above skips the weapon PROP bones (Bip01_Prop1/Prop2): the PZ body
// weights no vertices to them, so they aren't skin joints, and the body parents them under the
// root (not the hand) with a bind that doesn't match the clip's own prop parent. Copying the
// clip's local prop TRS therefore flings the held item metres away. Instead retarget the prop in
// WORLD space, anchored to the clip's FIRST frame (its rest pose, not inverse-bind, which differ
// here) so the item sits exactly at the body's rest attachment and then moves by the authored
// world-space delta. Runs on real posed matrices: pose the body with the bone tracks to read the
// prop's parent, pose the clip to read the prop's motion. Everything is expressed relative to the
// rig root, so facing/ground offsets cancel out.
function retargetAttachments(
  clip: THREE.AnimationClip, clipScene: THREE.Object3D, body: SkeletonBind, bodyRoot: THREE.Object3D,
  mappedSet: Set<string>, times: number[], tracks: THREE.KeyframeTrack[],
) {
  const nodes = [...new Set(clip.tracks
    .map((t) => /^(.+)\.(?:quaternion|position)$/.exec(t.name)?.[1])
    .filter((n): n is string => !!n && !mappedSet.has(n) && body.bindWorld.has(n)))];
  if (!nodes.length) return;

  const boneClip = new THREE.AnimationClip(clip.name, clip.duration, tracks.slice());
  const bodyMixer = new THREE.AnimationMixer(bodyRoot);
  bodyMixer.clipAction(boneClip).play();
  const clipMixer = new THREE.AnimationMixer(clipScene);
  clipMixer.clipAction(clip).play();

  const rootInv = new THREE.Matrix4();
  const clipRef = new Map<string, THREE.Matrix4>();   // prop world matrix at the clip's first frame
  const bodyRest = new Map<string, THREE.Matrix4>();   // body prop matrix (rel. rig root) at rest
  clipMixer.setTime(times[0]); clipScene.updateMatrixWorld(true);
  bodyMixer.setTime(times[0]); bodyRoot.updateMatrixWorld(true);
  rootInv.copy(bodyRoot.matrixWorld).invert();
  const active = nodes.filter((n) => clipScene.getObjectByName(n) && bodyRoot.getObjectByName(n)?.parent);
  for (const n of active) {
    clipRef.set(n, clipScene.getObjectByName(n)!.matrixWorld.clone());
    bodyRest.set(n, new THREE.Matrix4().multiplyMatrices(rootInv, bodyRoot.getObjectByName(n)!.matrixWorld));
  }

  const posVals = new Map(active.map((n) => [n, [] as number[]]));
  const quatVals = new Map(active.map((n) => [n, [] as number[]]));
  const tmp = new THREE.Matrix4(), targetM = new THREE.Matrix4(), localM = new THREE.Matrix4();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  for (const time of times) {
    clipMixer.setTime(time); clipScene.updateMatrixWorld(true);
    bodyMixer.setTime(time); bodyRoot.updateMatrixWorld(true);
    rootInv.copy(bodyRoot.matrixWorld).invert();
    for (const n of active) {
      const clipNow = clipScene.getObjectByName(n)!.matrixWorld;
      const parent = bodyRoot.getObjectByName(n)!.parent!;
      // target = (clipNow . clipRef^-1) . bodyRest ; local = (parent rel. root)^-1 . target
      targetM.copy(clipNow).multiply(tmp.copy(clipRef.get(n)!).invert()).multiply(bodyRest.get(n)!);
      localM.copy(rootInv).multiply(parent.matrixWorld).invert().multiply(targetM);
      localM.decompose(p, q, s);
      posVals.get(n)!.push(p.x, p.y, p.z);
      quatVals.get(n)!.push(q.x, q.y, q.z, q.w);
    }
  }
  clipMixer.stopAllAction(); clipMixer.uncacheRoot(clipScene);
  bodyMixer.stopAllAction(); bodyMixer.uncacheRoot(bodyRoot);
  for (const n of active) {
    tracks.push(new THREE.VectorKeyframeTrack(n + '.position', times, posVals.get(n)!));
    tracks.push(new THREE.QuaternionKeyframeTrack(n + '.quaternion', times, quatVals.get(n)!));
  }
}

export function normaliseClip(
  clip: THREE.AnimationClip,
  format: string,
  ctx: { clipRest?: Map<string, THREE.Quaternion>; bodyRest?: Map<string, THREE.Quaternion>; clipScene?: THREE.Object3D; bodySkel?: SkeletonBind; bodyRoot?: THREE.Object3D } = {},
): NormalisedClip {
  const fmt = String(format).toLowerCase();
  if (fmt === 'glb' || fmt === 'gltf') {
    // preferred: world-space retarget (handles foreign-skeleton exports correctly)
    if (ctx.clipScene && ctx.bodySkel) {
      return { clip: retargetWorld(clip, ctx.clipScene, ctx.bodySkel, ctx.bodyRoot), rootRotationX: 0, best: false };
    }
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
