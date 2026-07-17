// A set of skinned rigs (body, hair, beard, clothing) animated together in lockstep.
// Faithful port of src/characterApp/rigset.js.
import * as THREE from 'three';
import type { NormalisedClip } from './anim';

interface Rig { kind: string; root: THREE.Object3D; mixer: THREE.AnimationMixer | null; action: THREE.AnimationAction | null; }

export class RigSet {
  scene: THREE.Scene;
  rigs: Rig[] = [];
  clip: NormalisedClip | null = null;
  loop = true;
  facing = 0;

  constructor(scene: THREE.Scene) { this.scene = scene; }

  add(kind: string, root: THREE.Object3D): Rig {
    root.rotation.x = this.clip ? this.clip.rootRotationX : 0;
    root.rotation.y = this.facing;
    this.scene.add(root);
    const rig: Rig = { kind, root, mixer: null, action: null };
    this.rigs.push(rig);
    if (this.clip) this._bind(rig, this.time());
    return rig;
  }

  setFacing(rad: number) { this.facing = rad; for (const rig of this.rigs) rig.root.rotation.y = rad; }

  removeKind(kind: string) {
    for (let i = this.rigs.length - 1; i >= 0; i--) {
      if (this.rigs[i].kind !== kind) continue;
      const r = this.rigs[i];
      if (r.mixer) { r.mixer.stopAllAction(); r.mixer.uncacheRoot(r.root); }
      this.scene.remove(r.root);
      this.rigs.splice(i, 1);
    }
  }

  has(kind: string) { return this.rigs.some((r) => r.kind === kind); }
  get(kind: string) { return this.rigs.find((r) => r.kind === kind); }
  bodyRig() { return this.get('body'); }

  setClip(normalised: NormalisedClip | null) {
    this.clip = normalised;
    for (const rig of this.rigs) {
      rig.root.rotation.x = normalised ? normalised.rootRotationX : 0;
      rig.root.rotation.y = this.facing;
      this._rebind(rig, 0);
    }
  }

  setLoop(on: boolean) { this.loop = on; for (const r of this.rigs) if (r.action) r.action.loop = on ? THREE.LoopRepeat : THREE.LoopOnce; }

  update(dt: number) { for (const r of this.rigs) if (r.mixer) r.mixer.update(dt); }
  setTime(t: number) { for (const r of this.rigs) if (r.mixer) r.mixer.setTime(t); }
  time() { const b = this.bodyRig(); return b && b.action ? b.action.time : 0; }
  duration() { return this.clip ? (this.clip.clip.duration || 1) : 1; }

  private _rebind(rig: Rig, t: number) {
    if (rig.mixer) { rig.mixer.stopAllAction(); rig.mixer.uncacheRoot(rig.root); rig.mixer = null; rig.action = null; }
    if (this.clip) this._bind(rig, t);
  }

  private _bind(rig: Rig, t: number) {
    rig.mixer = new THREE.AnimationMixer(rig.root);
    rig.action = rig.mixer.clipAction(this.clip!.clip);
    rig.action.loop = this.loop ? THREE.LoopRepeat : THREE.LoopOnce;
    rig.action.clampWhenFinished = true;
    rig.action.play();
    rig.mixer.setTime(t);
  }
}
