// Interactive preview / adjust UI (Electron renderer, ES module).
// Live 3D preview + true 32px output for one icon, with per-item controls that
// save back to icons.config.json as overrides.

import { THREE, loadMesh, loadTexture, layoutIconScene } from '../renderWorker/renderCore.js';

const ipc = window.ipc;
const $ = (id) => document.getElementById(id);

// --- boot overlay -------------------------------------------------------------
// The overlay is in the markup, so it is painted before this module even finishes
// loading. Main drives its text; we take it down once the first icon has rendered.
function bootMsg(msg) { const el = $('bootMsg'); if (el) el.textContent = msg; }
function showBoot(msg) {
  const b = $('boot');
  if (!b) return;
  b.classList.remove('hide', 'error');
  bootMsg(msg || 'Working…');
}
function hideBoot() { const b = $('boot'); if (b) b.classList.add('hide'); }
function bootError(msg) {
  const b = $('boot');
  if (!b) return;
  b.classList.remove('hide');
  b.classList.add('error');
  bootMsg(msg);
}
ipc.on('boot-status', (_e, msg) => bootMsg(msg));
ipc.on('boot-error', (_e, msg) => bootError(msg));

// --- persistent renderer for the big viewport ---
const view = $('view');
const renderer = new THREE.WebGLRenderer({ canvas: view, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
renderer.setSize(480, 480, false);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

let DEFAULTS = null;
let MEDIA_DIR = null;
let icons = [];
let cur = null;            // working params for the current icon
let model = null, texture = null, prevMaterials = [];
let curIcon = null;
let curSlots = [];         // attachment slots for the current icon (weapons only)
let attachObjects = [];    // loaded { model, texture, parentAttachment, selfAttachment }

// Output sizes. The enabled set drives BOTH the live previews and what Batch writes.
const SIZES = [32, 64, 128, 256, 512];
const SS_CAP = 2048;       // never render a target bigger than this
const enabled = new Set([32]);
function enabledSizes() { return SIZES.filter((s) => enabled.has(s)); }
/** Supersample factor for a size, capped so the render target stays sane. */
function effSS(size) { return Math.max(1, Math.min(DEFAULTS.supersample, Math.floor(SS_CAP / size))); }

// --- helpers ---
function layoutParams() {
  return {
    pitch: 30, yaw: 45,
    extraYaw: cur.extraYaw, extraPitch: cur.extraPitch, extraRoll: cur.extraRoll,
    doubleSide: cur.doubleSide,
    lighting: { ambient: cur.ambient, keyDir: cur.keyDir, keyColour: cur.keyColour },
    attachments: attachObjects,
  };
}
function postOptsFor(p, size) {
  return { outSize: size, downscale: p.downscale, mirror: p.mirror, padding: p.padding };
}
function status(msg, ok = true) { const s = $('status'); s.textContent = msg; s.style.color = ok ? '#7c9' : '#e88'; }

// --- rendering ---
let postTimer = null;
function scheduleRender() {
  drawViewport();
  if (postTimer) clearTimeout(postTimer);
  postTimer = setTimeout(updateOutput, 120);
}

function drawViewport() {
  if (!model) return;
  // The engine's X-flip is applied in post (sharp .flop()); mirror the canvas so the
  // big preview matches the actual output orientation.
  view.style.transform = cur && cur.mirror ? 'scaleX(-1)' : '';
  for (const m of prevMaterials) m.dispose();
  const { scene, camera, materials } = layoutIconScene(model, texture, layoutParams());
  prevMaterials = materials;
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(scene, camera);
  scene.userData._cam = camera; // keep for output pass
  lastScene = scene; lastCam = camera;
}

let lastScene = null, lastCam = null;

const targetCache = new Map();
function getTarget(S) {
  let t = targetCache.get(S);
  if (!t) {
    t = new THREE.WebGLRenderTarget(S, S, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
    });
    targetCache.set(S, t);
  }
  return t;
}
/** Render a scene to an offscreen SxS target and read back raw RGBA. */
function readScene(scene, cam, S) {
  const t = getTarget(S);
  renderer.setRenderTarget(t);
  renderer.clear();
  renderer.render(scene, cam);
  const rgba = new Uint8Array(S * S * 4);
  renderer.readRenderTargetPixels(t, 0, 0, S, S, rgba);
  renderer.setRenderTarget(null);
  return rgba;
}

/** Refresh every enabled live output from the current scene. */
async function updateOutput() {
  if (!lastScene) return;
  for (const size of enabledSizes()) {
    const S = size * effSS(size);
    const rgba = readScene(lastScene, lastCam, S);
    try {
      const dataUrl = await ipc.invoke('post-process', { rgba, width: S, height: S, opts: postOptsFor(cur, size) });
      const img = document.querySelector(`#outputs img[data-size="${size}"]`);
      if (img) img.src = dataUrl;
    } catch (e) { status('post-process failed: ' + e.message, false); }
  }
}

// Solid grayscale backdrop behind the outputs, so icons can be judged against any
// background brightness. Purely a viewing aid: it is never baked into the PNG.
function applyOutBg() {
  const v = parseInt($('outBg').value, 10);
  const c = `rgb(${v},${v},${v})`;
  $('outBgV').textContent = String(v);
  for (const img of document.querySelectorAll('#outputs img')) {
    img.style.backgroundColor = c;
    img.parentElement.style.backgroundColor = c;
  }
}

/** One preview box per enabled size, each shown at true 1:1 (never scaled). */
function buildOutputs() {
  const c = $('outputs');
  c.innerHTML = '';
  for (const s of enabledSizes()) {
    const box = document.createElement('div'); box.className = 'outbox';
    const frame = document.createElement('div'); frame.className = 'frame';
    const img = document.createElement('img'); img.dataset.size = String(s);
    img.addEventListener('load', () => {
      img.style.width = img.naturalWidth + 'px';
      img.style.height = img.naturalHeight + 'px';
    });
    frame.appendChild(img); box.appendChild(frame);
    const cap = document.createElement('small'); cap.textContent = `${s}x${s}`;
    box.appendChild(cap); c.appendChild(box);
  }
  applyOutBg();
}

function buildSizeRow() {
  const row = $('sizeRow');
  row.innerHTML = '<span style="color:#9aa">sizes:</span> ';
  for (const s of SIZES) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = enabled.has(s);
    cb.addEventListener('change', () => {
      if (cb.checked) enabled.add(s); else enabled.delete(s);
      if (!enabled.size) { enabled.add(32); buildSizeRow(); } // never leave it empty
      buildOutputs(); refreshBatchUI(); scheduleRender();
    });
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + s));
    row.appendChild(lab);
  }
}

/** The mod writes a single icon PNG, so it needs one chosen size. */
function refreshIconSizes() {
  const sel = $('iconSize'); const prev = sel.value;
  sel.innerHTML = '';
  for (const s of enabledSizes()) {
    const o = document.createElement('option'); o.value = String(s); o.textContent = `${s}x${s}`;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  updateDestHint();
}

function updateDestHint() {
  const sz = $('iconSize').value || '32';
  $('destHint').textContent = $('destMod').checked
    ? `writes <mod>/media/textures/Item_<icon>.png at ${sz}x${sz}`
    : `writes <folder>/<icon>_<size>.png for each enabled size (${enabledSizes().join(', ')})`;
}

// --- load an icon ---
async function loadIcon(icon) {
  status('loading ' + icon + ' ...');
  const info = await ipc.invoke('get-icon', icon);
  if (info.error) { status(info.error, false); return; }
  curIcon = icon;
  const p = info.params;
  cur = {
    extraYaw: p.extraYaw ?? 0, extraPitch: p.extraPitch ?? 0, extraRoll: p.extraRoll ?? 0,
    padding: p.padding ?? DEFAULTS.padding, mirror: p.mirror ?? true, doubleSide: p.doubleSide ?? true,
    downscale: p.downscale ?? DEFAULTS.downscale,
    ambient: (p.ambient ?? DEFAULTS.ambient).slice(), keyDir: (p.keyDir ?? DEFAULTS.keyDir).slice(),
    keyColour: (p.keyColour ?? DEFAULTS.keyColour).slice(),
    model: p.model || null,
    attachments: { ...(info.attachments || {}) },
  };
  curSlots = info.slots || [];
  $('modelName').textContent = info.modelName || '-';
  $('meshName').textContent = info.meshFile.split(/[\\/]/).pop();
  await loadMeshTexture(info.meshFile, info.meshFormat, info.textureFile);
  syncControls();
  buildAttachUI();
  refreshBatchUI();
  await applyAttachments();
  status('loaded ' + icon);   // the Attachments tab badge already shows the slot count
}

async function loadMeshTexture(meshFile, meshFormat, textureFile) {
  model = await loadMesh(meshFile, meshFormat);
  if (texture) texture.dispose();
  texture = textureFile ? await loadTexture(textureFile, cur.flipY ?? true) : null;
}

// --- attachments (weapon parts) ---
function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of document.querySelectorAll('.tabpane')) p.classList.toggle('active', p.dataset.tab === name);
}

function buildAttachUI() {
  const tab = $('attachTab'), rows = $('attachRows');
  rows.innerHTML = '';
  const renderable = curSlots.filter((s) => s.options.some((o) => o.available));
  if (!renderable.length) {           // non-weapon: hide the tab entirely
    tab.style.display = 'none';
    const active = document.querySelector('.tab.active');
    if (active && active.dataset.tab === 'attach') showTab('adjust');
    return;
  }
  tab.style.display = '';
  $('attachCount').textContent = `(${renderable.length})`;

  for (const s of renderable) {
    const row = document.createElement('div');
    row.className = 'arow';
    const lab = document.createElement('label');
    lab.textContent = s.slot;
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = ''; none.textContent = '(none)';
    sel.appendChild(none);
    for (const o of s.options.filter((x) => x.available)) {
      const op = document.createElement('option');
      op.value = o.partType; op.textContent = o.partType;
      sel.appendChild(op);
    }
    sel.value = cur.attachments[s.slot] || '';
    row.classList.toggle('off', !sel.value);
    sel.addEventListener('change', async () => {
      if (sel.value) cur.attachments[s.slot] = sel.value; else delete cur.attachments[s.slot];
      row.classList.toggle('off', !sel.value);
      markDirty();
      await applyAttachments();
    });
    row.appendChild(lab); row.appendChild(sel);
    rows.appendChild(row);
  }
}

/** Ask main for the attachment specs, load their meshes/textures, re-render. */
async function applyAttachments() {
  for (const a of attachObjects) if (a.texture) a.texture.dispose();
  attachObjects = [];
  const sel = cur.attachments || {};
  if (Object.keys(sel).length) {
    status('loading attachments ...');
    const res = await ipc.invoke('resolve-attachments', { icon: curIcon, selection: sel });
    for (const w of (res.warnings || [])) status(w, false);
    for (const spec of (res.specs || [])) {
      attachObjects.push({
        model: await loadMesh(spec.meshFile, spec.meshFormat),
        texture: spec.textureFile ? await loadTexture(spec.textureFile, cur.flipY ?? true) : null,
        parentAttachment: spec.parentAttachment, selfAttachment: spec.selfAttachment,
      });
    }
  }
  scheduleRender();
  status(`${attachObjects.length} attachment(s)`);
}

function setAllAttachments(on) {
  cur.attachments = {};
  if (on) {
    for (const s of curSlots) {
      const first = s.options.find((o) => o.available);
      if (first) cur.attachments[s.slot] = first.partType;
    }
  }
  buildAttachUI();
  markDirty();
  applyAttachments();
}

// --- controls wiring ---
const ranges = [
  ['extraYaw', 'extraYaw', 0], ['extraPitch', 'extraPitch', 0], ['extraRoll', 'extraRoll', 0],
  ['padding', 'padding', 3],
];
function syncControls() {
  for (const [id, key, dp] of ranges) { $(id).value = cur[key]; $(id + 'V').textContent = Number(cur[key]).toFixed(dp); }
  $('mirror').checked = !!cur.mirror;
  $('doubleSide').checked = !!cur.doubleSide;
  $('downscale').value = cur.downscale;
  $('ambient').value = cur.ambient[0]; $('ambientV').textContent = cur.ambient[0].toFixed(2);
  $('keyBright').value = cur.keyColour[0]; $('keyBrightV').textContent = cur.keyColour[0].toFixed(2);
  $('keyX').value = cur.keyDir[0]; $('keyXV').textContent = cur.keyDir[0].toFixed(1);
  $('keyY').value = cur.keyDir[1]; $('keyYV').textContent = cur.keyDir[1].toFixed(1);
  $('keyZ').value = cur.keyDir[2]; $('keyZV').textContent = cur.keyDir[2].toFixed(1);
  $('modelOverride').value = cur.model || '';
}

function wire() {
  for (const [id, key, dp] of ranges) {
    $(id).addEventListener('input', () => { cur[key] = parseFloat($(id).value); $(id + 'V').textContent = Number(cur[key]).toFixed(dp); markDirty(); scheduleRender(); });
  }
  $('mirror').addEventListener('change', () => { cur.mirror = $('mirror').checked; markDirty(); scheduleRender(); });
  $('doubleSide').addEventListener('change', () => { cur.doubleSide = $('doubleSide').checked; markDirty(); scheduleRender(); });
  $('downscale').addEventListener('change', () => { cur.downscale = $('downscale').value; markDirty(); scheduleRender(); });
  $('ambient').addEventListener('input', () => { const v = parseFloat($('ambient').value); cur.ambient = [v, v, v]; $('ambientV').textContent = v.toFixed(2); markDirty(); scheduleRender(); });
  $('keyBright').addEventListener('input', () => { const v = parseFloat($('keyBright').value); cur.keyColour = [v, v, v]; $('keyBrightV').textContent = v.toFixed(2); markDirty(); scheduleRender(); });
  for (const [id, idx] of [['keyX', 0], ['keyY', 1], ['keyZ', 2]]) {
    $(id).addEventListener('input', () => { cur.keyDir[idx] = parseFloat($(id).value); $(id + 'V').textContent = cur.keyDir[idx].toFixed(1); markDirty(); scheduleRender(); });
  }
  // per-slider reset: click a value label to restore that control's default
  const resets = [
    ['ambientV', () => { cur.ambient = (DEFAULTS.ambient || [0.6, 0.6, 0.6]).slice(); }],
    ['keyBrightV', () => { cur.keyColour = (DEFAULTS.keyColour || [0.5, 0.5, 0.5]).slice(); }],
    ['keyXV', () => { cur.keyDir[0] = (DEFAULTS.keyDir || [0, -2, 5])[0]; }],
    ['keyYV', () => { cur.keyDir[1] = (DEFAULTS.keyDir || [0, -2, 5])[1]; }],
    ['keyZV', () => { cur.keyDir[2] = (DEFAULTS.keyDir || [0, -2, 5])[2]; }],
    ['extraYawV', () => { cur.extraYaw = 0; }], ['extraPitchV', () => { cur.extraPitch = 0; }],
    ['extraRollV', () => { cur.extraRoll = 0; }], ['paddingV', () => { cur.padding = DEFAULTS.padding ?? 0.03; }],
  ];
  for (const [valId, reset] of resets) {
    const v = $(valId); if (!v) continue;
    v.style.cursor = 'pointer'; v.title = 'click to reset to default';
    v.addEventListener('click', () => { reset(); syncControls(); markDirty(); scheduleRender(); });
  }
  $('iconSelect').addEventListener('change', () => loadIcon($('iconSelect').value));
  $('prevBtn').addEventListener('click', () => step(-1));
  $('nextBtn').addEventListener('click', () => step(1));
  $('resetBtn').addEventListener('click', () => loadIcon(curIcon));
  $('saveBtn').addEventListener('click', save);
  $('applyModel').addEventListener('click', applyModelOverride);
  $('attachAll').addEventListener('click', () => setAllAttachments(true));
  $('attachNone').addEventListener('click', () => setAllAttachments(false));
  $('outBg').addEventListener('input', applyOutBg); // viewing aid; no re-render needed
  $('openMod').addEventListener('click', openMod);
  $('gameDirBtn').addEventListener('click', chooseGameDir);
  $('charBtn').addEventListener('click', () => window.ipc.invoke('open-character'));

  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));

  $('openBatch').addEventListener('click', openBatch);
  $('closeBatch').addEventListener('click', closeBatch);
  $('batchBackdrop').addEventListener('click', closeBatch);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBatch(); });
  $('runBatch').addEventListener('click', generate);
  $('cancelBatch').addEventListener('click', () => {
    cancelRequested = true;
    $('cancelBatch').disabled = true;
    $('cancelBatch').textContent = 'Cancelling\u2026';
  });
  $('destMod').addEventListener('change', updateDestHint);
  $('destFolder').addEventListener('change', updateDestHint);
  $('iconSize').addEventListener('change', updateDestHint);
  $('browseOut').addEventListener('click', async () => {
    const f = await ipc.invoke('choose-folder');
    if (f) { $('destPath').value = f; $('destFolder').checked = true; updateDestHint(); }
  });
}

let dirty = false;
function markDirty() { dirty = true; $('dirtyFlag').textContent = '● unsaved'; }
function clearDirty() { dirty = false; $('dirtyFlag').textContent = ''; }

function step(d) {
  const sel = $('iconSelect');
  let i = sel.selectedIndex + d;
  i = Math.max(0, Math.min(sel.options.length - 1, i));
  sel.selectedIndex = i;
  loadIcon(sel.value);
}

async function applyModelOverride() {
  const name = $('modelOverride').value.trim();
  if (!name) { cur.model = null; markDirty(); return; }
  status('resolving model ' + name + ' ...');
  const res = await ipc.invoke('resolve-override', { model: name });
  if (res.error) { status(res.error, false); return; }
  cur.model = name;
  $('modelName').textContent = name;
  $('meshName').textContent = res.meshFile.split(/[\\/]/).pop();
  await loadMeshTexture(res.meshFile, res.meshFormat, res.textureFile);
  markDirty(); scheduleRender(); status('applied model ' + name);
}

// Build the minimal override object (only values that differ from defaults).
function buildOverride() {
  const o = {};
  const d = DEFAULTS;
  if (cur.extraYaw) o.extraYaw = cur.extraYaw;
  if (cur.extraPitch) o.extraPitch = cur.extraPitch;
  if (cur.extraRoll) o.extraRoll = cur.extraRoll;
  if (cur.padding !== d.padding) o.padding = cur.padding;
  if (cur.mirror !== d.mirror) o.mirror = cur.mirror;
  if (cur.doubleSide !== d.doubleSide) o.doubleSide = cur.doubleSide;
  if (cur.downscale !== d.downscale) o.downscale = cur.downscale;
  if (JSON.stringify(cur.ambient) !== JSON.stringify(d.ambient)) o.ambient = cur.ambient;
  if (JSON.stringify(cur.keyDir) !== JSON.stringify(d.keyDir)) o.keyDir = cur.keyDir;
  if (JSON.stringify(cur.keyColour) !== JSON.stringify(d.keyColour)) o.keyColour = cur.keyColour;
  if (cur.model) o.model = cur.model;
  if (cur.attachments && Object.keys(cur.attachments).length) o.attachments = { ...cur.attachments };
  return o;
}

async function save() {
  const override = buildOverride();
  const res = await ipc.invoke('save-config', { icon: curIcon, override });
  if (res.error) { status(res.error, false); return; }
  clearDirty();
  status('saved override for ' + curIcon + ' -> ' + res.file);
}

// --- batch: render any icon, independent of the current preview state ---
/** Loads an icon's own assets and returns a ready scene (caller must dispose). */
async function buildSceneFor(info) {
  const p = info.params;
  const flipY = p.flipY ?? true;
  const mdl = await loadMesh(info.meshFile, info.meshFormat);
  const tex = info.textureFile ? await loadTexture(info.textureFile, flipY) : null;

  const atts = [];
  const sel = info.attachments || {};
  if (Object.keys(sel).length) {
    const res = await ipc.invoke('resolve-attachments', { icon: info.icon, selection: sel });
    for (const a of (res.specs || [])) {
      atts.push({
        model: await loadMesh(a.meshFile, a.meshFormat),
        texture: a.textureFile ? await loadTexture(a.textureFile, flipY) : null,
        parentAttachment: a.parentAttachment, selfAttachment: a.selfAttachment,
      });
    }
  }

  const { scene, camera, materials } = layoutIconScene(mdl, tex, {
    pitch: p.pitch, yaw: p.yaw, extraYaw: p.extraYaw, extraPitch: p.extraPitch, extraRoll: p.extraRoll,
    doubleSide: p.doubleSide,
    lighting: { ambient: p.ambient, keyDir: p.keyDir, keyColour: p.keyColour },
    attachments: atts,
  });
  const dispose = () => {
    for (const m of materials) m.dispose();
    if (tex) tex.dispose();
    for (const a of atts) if (a.texture) a.texture.dispose();
  };
  return { scene, camera, dispose, params: p };
}

// ---- batch drawer ----
let batchRunning = false, cancelRequested = false;

function refreshBatchUI() {
  const chips = $('batchSizes');
  chips.innerHTML = '';
  for (const s of enabledSizes()) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = s + '\u00d7' + s;
    chips.appendChild(c);
  }
  $('scopeOneLbl').textContent = curIcon ? `This icon (${curIcon})` : 'This icon';
  $('scopeAllLbl').textContent = `All icons (${icons.length})`;
  refreshIconSizes();
}

function openBatch() {
  refreshBatchUI();
  $('batchDrawer').classList.add('open');
  $('batchDrawer').setAttribute('aria-hidden', 'false');
  $('batchBackdrop').classList.add('open');
}

function closeBatch() {
  if (batchRunning) return;          // don't hide a run in progress
  $('batchDrawer').classList.remove('open');
  $('batchDrawer').setAttribute('aria-hidden', 'true');
  $('batchBackdrop').classList.remove('open');
}

/**
 * Render one icon or all icons, at every enabled size.
 *  - mod destination:    one Item_<icon>.png at the chosen icon size
 *  - folder destination: <icon>_<size>.png for each enabled size
 */
async function generate() {
  const scope = $('scopeOne').checked ? 'one' : 'all';
  const bs = $('buildStatus'), bar = $('batchBar');
  const setBar = (f) => { bar.style.width = Math.round(f * 100) + '%'; };
  batchRunning = true; cancelRequested = false;
  $('runBatch').disabled = true; $('cancelBatch').disabled = false;
  setBar(0);
  try {
    const sizes = enabledSizes();
    if (!sizes.length) { bs.style.color = '#e88'; bs.textContent = 'enable at least one size'; return; }
    const toMod = $('destMod').checked;
    const folder = $('destPath').value.trim();
    if (!toMod && !folder) { bs.style.color = '#e88'; bs.textContent = 'choose an output folder'; return; }
    if (dirty) await save(); // the saved config drives the render

    const iconList = scope === 'one' ? [curIcon] : (await ipc.invoke('build-plan')).map((x) => x.icon);
    const iconSize = parseInt($('iconSize').value, 10) || sizes[0];

    const jobs = [];
    for (const icon of iconList) {
      if (toMod) jobs.push({ icon, size: iconSize, outPath: `${MEDIA_DIR}/textures/Item_${icon}.png` });
      else for (const sz of sizes) jobs.push({ icon, size: sz, outPath: `${folder}/${icon}_${sz}.png` });
    }

    const exists = await ipc.invoke('check-exists', jobs.map((j) => j.outPath));
    const overwrite = $('overwrite').checked;
    const todo = jobs.filter((j, i) => overwrite || !exists[i]);
    const skipped = jobs.length - todo.length;
    if (!todo.length) { bs.style.color = '#7c9'; bs.textContent = `nothing to do (${skipped} already exist; tick overwrite)`; return; }

    // group by icon so each icon's assets load once
    const byIcon = new Map();
    for (const j of todo) { if (!byIcon.has(j.icon)) byIcon.set(j.icon, []); byIcon.get(j.icon).push(j); }

    let done = 0, failed = 0, n = 0;
    outer:
    for (const [icon, js] of byIcon) {
      let sc = null;
      try {
        const info = await ipc.invoke('get-icon', icon);
        if (info.error) throw new Error(info.error);
        sc = await buildSceneFor(info);
        for (const j of js) {
          if (cancelRequested) { sc.dispose(); sc = null; break outer; }
          n++;
          bs.style.color = '#9aa';
          bs.textContent = `${icon} @${j.size}  (${n}/${todo.length})`;
          setBar(n / todo.length);
          await new Promise((r) => setTimeout(r, 0)); // let the UI paint
          const S = j.size * effSS(j.size);
          const rgba = readScene(sc.scene, sc.camera, S);
          await ipc.invoke('write-png', {
            rgba, width: S, height: S, opts: postOptsFor(sc.params, j.size), outPath: j.outPath,
          });
          done++;
        }
      } catch (e) { failed += js.length; n += js.length; console.error('[generate]', icon, e); }
      finally { if (sc) sc.dispose(); }
    }
    setBar(1);
    const where = toMod ? MEDIA_DIR + '/textures' : folder;
    bs.style.color = failed ? '#e88' : '#7c9';
    bs.textContent = cancelRequested
      ? `cancelled after ${done} written`
      : `${done} written, ${failed} failed, ${skipped} skipped -> ${where}`;
    await loadIcon(curIcon); // restore the preview
  } finally {
    batchRunning = false; cancelRequested = false;
    $('runBatch').disabled = false;
    $('cancelBatch').disabled = true;
    $('cancelBatch').textContent = 'Cancel';
  }
}

/** Show whether a Project Zomboid install is configured (vanilla assets). */
function setGameDirBadge(dir) {
  const b = $('gameDirBtn');
  b.textContent = dir ? 'Game folder ✓' : 'Game folder …';
  b.title = dir
    ? `Project Zomboid: ${dir}
Click to change.`
    : 'No Project Zomboid install set. Vanilla assets that mods reuse will not resolve. Click to set it.';
  b.style.borderColor = dir ? '' : '#8a6d3b';
}

/** Pick the Project Zomboid install; it is remembered across runs. */
async function chooseGameDir() {
  const res = await ipc.invoke('choose-game-dir');
  if (!res || res.canceled) return;
  if (res.error) { status(res.error, false); return; }
  showBoot('Re-indexing assets…');
  setGameDirBadge(res.gameDir);
  icons = res.icons;
  const sel = $('iconSelect');
  const keep = sel.value;
  sel.innerHTML = '';
  for (const it of icons) { const o = document.createElement('option'); o.value = it.icon; o.textContent = it.icon; sel.appendChild(o); }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  await loadIcon(sel.value || (icons[0] && icons[0].icon));
  hideBoot();
  status('game folder set; assets re-resolved');
}

/** Point the UI at a different mod folder. */
async function openMod() {
  const res = await ipc.invoke('open-mod');
  if (!res || res.canceled) return;
  if (res.error) { status(res.error, false); return; }
  showBoot('Reading mod…');
  DEFAULTS = res.defaults; MEDIA_DIR = res.mediaDir; icons = res.icons;
  $('modLabel').textContent = res.modPath;
  const sel = $('iconSelect');
  sel.innerHTML = '';
  for (const it of icons) { const o = document.createElement('option'); o.value = it.icon; o.textContent = it.icon; sel.appendChild(o); }
  clearDirty();
  $('buildStatus').textContent = '';
  if (icons.length) { sel.selectedIndex = 0; await loadIcon(icons[0].icon); }
  else { curSlots = []; buildAttachUI(); status('no renderable icons in that mod', false); }
  hideBoot();
}

// --- boot (main signals when the mod is picked and indexed) ---
async function boot() {
  const data = await ipc.invoke('get-data');
  DEFAULTS = data.defaults; MEDIA_DIR = data.mediaDir; icons = data.icons;
  $('modLabel').textContent = data.modPath;
  setGameDirBadge(data.gameDir);
  const sel = $('iconSelect');
  for (const it of icons) { const o = document.createElement('option'); o.value = it.icon; o.textContent = it.icon; sel.appendChild(o); }
  wire();
  buildSizeRow();
  buildOutputs();
  refreshBatchUI();
  applyOutBg();
  if (icons.length) {
    let idx = 0;
    if (data.startIcon) { const i = icons.findIndex((it) => it.icon === data.startIcon); if (i >= 0) idx = i; }
    sel.selectedIndex = idx;
    bootMsg(`Loading ${icons[idx].icon}…`);
    await loadIcon(icons[idx].icon);
    await updateOutput();          // don't drop the overlay before pixels exist
  } else status('no renderable icons found for this mod', false);
  hideBoot();
  setTimeout(() => ipc.send('ui-ready'), 300); // signal for debug capture
}

ipc.on('boot-ready', () => { boot().catch((e) => bootError(String(e && e.message || e))); });
