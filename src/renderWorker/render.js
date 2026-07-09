// Headless three.js render worker (runs in the Electron renderer as an ES module).
// Receives a batch of render jobs over IPC, renders each to an offscreen square
// RGBA target using the shared icon core, and returns raw pixels. The main
// process does the alpha-trim + mirror + downscale + PNG encode.

import { THREE, loadMesh, loadTexture, layoutIconScene } from './renderCore.js';

const ipc = window.ipc; // set by a classic <script> before this module loads

let renderer;
function getRenderer() {
  if (renderer) return renderer;
  renderer = new THREE.WebGLRenderer({
    alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  return renderer;
}

async function renderOne(job) {
  const { meshFile, meshFormat, textureFile, size = 512, angle = {}, flipY = true, doubleSide = true, lighting = {} } = job;

  const model = await loadMesh(meshFile, meshFormat);
  const texture = textureFile ? await loadTexture(textureFile, flipY) : null;

  // weapon parts attached at the parent's attachment points
  const attachments = [];
  for (const a of (job.attachments || [])) {
    attachments.push({
      model: await loadMesh(a.meshFile, a.meshFormat),
      texture: a.textureFile ? await loadTexture(a.textureFile, flipY) : null,
      parentAttachment: a.parentAttachment, selfAttachment: a.selfAttachment,
    });
  }

  const { scene, camera, materials } = layoutIconScene(model, texture, {
    pitch: angle.pitch, yaw: angle.yaw, extraYaw: angle.extraYaw, extraPitch: angle.extraPitch, extraRoll: angle.extraRoll,
    doubleSide, lighting, attachments,
  });

  const r = getRenderer();
  const target = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
  });
  r.setRenderTarget(target);
  r.clear();
  r.render(scene, camera);

  const rgba = new Uint8Array(size * size * 4);
  r.readRenderTargetPixels(target, 0, 0, size, size, rgba);
  r.setRenderTarget(null);
  target.dispose();
  for (const m of materials) m.dispose();
  if (texture) texture.dispose();
  for (const a of attachments) if (a.texture) a.texture.dispose();
  return { width: size, height: size, rgba };
}

ipc.on('render-batch', async (_e, jobs) => {
  for (const job of jobs) {
    try {
      const out = await renderOne(job);
      ipc.send('render-result', { id: job.id, ok: true, width: out.width, height: out.height, rgba: out.rgba });
    } catch (err) {
      ipc.send('render-result', { id: job.id, ok: false, error: String(err && err.stack || err) });
    }
  }
  ipc.send('render-done');
});

ipc.send('ready');
