// Offscreen animation-thumbnail renderer (ESM). Reuses the main WebGL context to
// pose a nude reference body at a clip frame and read it back as a PNG data URL.
// Frame 0 gives the static thumbnail; advancing the time gives the hover preview.

import { THREE, makeSkinnedMaterial, loadGlb, loadTexture } from './charCore.js';

export class ThumbRenderer {
  constructor(renderer, size = 112) {
    this.renderer = renderer;
    this.size = size;
    this.target = new THREE.WebGLRenderTarget(size, size);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(0.4, 1.2, 1.6);
    this.scene.add(key);
    // Frame the whole body centred: a vertically SYMMETRIC frustum around the
    // look-at (body centre ~y=0.5), square so the 112x112 target isn't stretched.
    // Visible world Y = 0.5 +/- 0.68 = [-0.18, 1.18], so the 0..1.0 body is centred.
    this.camera = new THREE.OrthographicCamera(-0.68, 0.68, 0.68, -0.68, 0.01, 100);
    this.camera.position.set(0, 0.5, 6);
    this.camera.lookAt(0, 0.5, 0);

    this.body = null;
    this.mixer = null;
    this._clip = null;
    this.gender = null;

    this._canvas = document.createElement('canvas');
    this._canvas.width = size; this._canvas.height = size;
    this._ctx = this._canvas.getContext('2d');
    this._buf = new Uint8Array(size * size * 4);
  }

  /** Load / swap the nude reference body for a gender. */
  async setBody(meshFile, skinTexture, gender) {
    if (this.body) { this.scene.remove(this.body); this.body = null; }
    this._clip = null; this.mixer = null;
    const root = (await loadGlb(meshFile)).scene;
    const tex = await loadTexture(skinTexture, false);
    const mat = makeSkinnedMaterial(tex);
    root.traverse((o) => {
      if (o.isMesh) {
        if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
        o.material = mat; o.frustumCulled = false;
      }
    });
    this.body = root; this.scene.add(root); this.gender = gender;
  }

  /** Bind a normalised clip (so subsequent renders advance the same mixer). */
  bind(clipNorm) {
    if (!this.body) return;
    this.body.rotation.x = clipNorm.rootRotationX;
    if (this.mixer) this.mixer.stopAllAction();
    this.mixer = new THREE.AnimationMixer(this.body);
    const action = this.mixer.clipAction(clipNorm.clip);
    action.play();
    this._clip = clipNorm.clip;
  }

  /** Render the bound clip at time t and return a PNG data URL. */
  renderAt(t) {
    if (!this.body || !this.mixer) return null;
    this.mixer.setTime(t);
    this.body.updateMatrixWorld(true);
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0); // transparent background
    r.clear();
    r.render(this.scene, this.camera);
    r.readRenderTargetPixels(this.target, 0, 0, this.size, this.size, this._buf);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);

    // WebGL readback is bottom-up; flip into the 2D canvas
    const s = this.size, img = this._ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      const sy = s - 1 - y;
      for (let x = 0; x < s; x++) {
        const di = (y * s + x) * 4, si = (sy * s + x) * 4;
        img.data[di] = this._buf[si]; img.data[di + 1] = this._buf[si + 1];
        img.data[di + 2] = this._buf[si + 2]; img.data[di + 3] = this._buf[si + 3];
      }
    }
    this._ctx.putImageData(img, 0, 0);
    return this._canvas.toDataURL('image/png');
  }

  duration() { return this._clip ? (this._clip.duration || 1) : 1; }
}
