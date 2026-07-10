// A set of skinned "rigs" (body, hair, beard, clothing, ...) that all animate
// together. The engine shares ONE skeleton across every character mesh; three
// binds a clip to a specific root, so instead each rig keeps its own copy of the
// skeleton and its own mixer, and the same name-bound clip drives them all in
// lockstep. Advancing every mixer by the same delta keeps them synchronised.

import * as THREE from 'three';

export class RigSet {
  constructor(scene) {
    this.scene = scene;
    this.rigs = [];         // { kind, root, mixer, action }
    this.clip = null;       // normalised clip: { clip, rootRotationX, ... } or null
    this.loop = true;
    this.facing = 0;        // character body Y rotation (radians), for cardinal facing
  }

  add(kind, root) {
    root.rotation.x = this.clip ? this.clip.rootRotationX : 0;
    root.rotation.y = this.facing;
    this.scene.add(root);
    const rig = { kind, root, mixer: null, action: null };
    this.rigs.push(rig);
    if (this.clip) this._bind(rig, this.time());
    return rig;
  }

  /** Rotate the whole character (every rig, so hats/held items follow) to a facing. */
  setFacing(rad) {
    this.facing = rad;
    for (const rig of this.rigs) rig.root.rotation.y = rad;
  }

  removeKind(kind) {
    for (let i = this.rigs.length - 1; i >= 0; i--) {
      if (this.rigs[i].kind !== kind) continue;
      const r = this.rigs[i];
      if (r.mixer) { r.mixer.stopAllAction(); r.mixer.uncacheRoot(r.root); }
      this.scene.remove(r.root);
      this.rigs.splice(i, 1);
    }
  }

  has(kind) { return this.rigs.some((r) => r.kind === kind); }
  get(kind) { return this.rigs.find((r) => r.kind === kind); }
  bodyRig() { return this.get('body'); }

  /** Set (or clear, with null) the active clip and rebind every rig at t=0. */
  setClip(normalised) {
    this.clip = normalised;
    for (const rig of this.rigs) {
      rig.root.rotation.x = normalised ? normalised.rootRotationX : 0;
      rig.root.rotation.y = this.facing;
      this._rebind(rig, 0);
    }
  }

  setLoop(on) {
    this.loop = on;
    for (const r of this.rigs) if (r.action) r.action.loop = on ? THREE.LoopRepeat : THREE.LoopOnce;
  }

  update(dt) { for (const r of this.rigs) if (r.mixer) r.mixer.update(dt); }
  setTime(t) { for (const r of this.rigs) if (r.mixer) r.mixer.setTime(t); }

  time() { const b = this.bodyRig(); return b && b.action ? b.action.time : 0; }
  duration() { return this.clip ? (this.clip.clip.duration || 1) : 1; }

  _rebind(rig, t) {
    if (rig.mixer) { rig.mixer.stopAllAction(); rig.mixer.uncacheRoot(rig.root); rig.mixer = null; rig.action = null; }
    if (this.clip) this._bind(rig, t);
  }

  _bind(rig, t) {
    rig.mixer = new THREE.AnimationMixer(rig.root);
    rig.action = rig.mixer.clipAction(this.clip.clip);
    rig.action.loop = this.loop ? THREE.LoopRepeat : THREE.LoopOnce;
    rig.action.clampWhenFinished = true;
    rig.action.play();
    rig.mixer.setTime(t);
  }
}
