// Character viewer renderer (ESM). Loads the body glb, applies the skinned
// shader with the chosen skin texture, and lets the user orbit it. Gender and
// skin-tone changes re-resolve the body in the main process and reload.

import { THREE, makeSkinnedMaterial, makeMaterial, CHAR_LIGHTING, partMatrix, loadGlb, makeOrbit, loadTexture } from './charCore.js';
import { normaliseClip } from './anim.js';
import { RigSet } from './rigset.js';
import { ThumbRenderer } from './thumbs.js';

const fileUrl = (p) => 'file:///' + String(p).replace(/\\/g, '/');

const { ipcRenderer } = require('electron');

// ---------- boot overlay ----------
const boot = document.getElementById('boot');
const bootMsg = document.getElementById('bootMsg');
ipcRenderer.on('boot-status', (_e, m) => { if (bootMsg) bootMsg.textContent = m; });
ipcRenderer.on('boot-error', (_e, m) => { if (bootMsg) { bootMsg.textContent = 'Error: ' + m; boot.classList.add('err'); } });
ipcRenderer.on('boot-ready', () => start().catch(fail));

function fail(e) {
  console.error(e);
  if (bootMsg) { bootMsg.textContent = 'Error: ' + (e && e.message || e); boot.classList.add('err'); }
}
function hideBoot() { if (boot) boot.style.display = 'none'; }

// ---------- three setup ----------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setClearColor(0x14141a, 1);

const scene = new THREE.Scene();
// Two cameras: a perspective free-orbit view, and an orthographic camera locked to
// the vanilla PZ CharacterModelCamera angle (30 deg pitch, 45 deg yaw, ortho).
const perspCam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
const isoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
let camera = perspCam;         // active camera
const orbit = makeOrbit(() => camera, canvas);

// A soft ground plane grid for spatial reference, kept subtle.
const grid = new THREE.GridHelper(4, 16, 0x2b2b34, 0x24242c);
grid.position.y = 0;
scene.add(grid);

const rigs = new RigSet(scene); // body + hair + beard + clothing, animated together

// ---------- lighting (live-adjustable, applied to every character material) ----------
const light = {
  ambient: CHAR_LIGHTING.ambient[0],
  keyBright: CHAR_LIGHTING.keyColour[0],
  keyDir: CHAR_LIGHTING.keyDir.slice(),
};
/** The lighting object new materials are created with. */
function lightingObj() {
  return { ambient: [light.ambient, light.ambient, light.ambient], keyDir: light.keyDir.slice(), keyColour: [light.keyBright, light.keyBright, light.keyBright] };
}
/** Push the current lighting onto every existing character material. */
function applyLighting() {
  const setMat = (o) => {
    const u = o.material && o.material.uniforms;
    if (!u) return;
    if (u.ambient) u.ambient.value.set(light.ambient, light.ambient, light.ambient);
    if (u.keyColour) u.keyColour.value.set(light.keyBright, light.keyBright, light.keyBright);
    if (u.keyDir) u.keyDir.value.set(light.keyDir[0], light.keyDir[1], light.keyDir[2]);
  };
  for (const rig of rigs.rigs) rig.root.traverse(setMat);
  for (const s of statics.values()) s.obj.traverse(setMat);
  for (const h of held.values()) h.obj.traverse(setMat);
}

// ---------- animation state ----------
const clock = new THREE.Clock();
let currentClip = null;    // { clip, rootRotationX, best, name, format } or null
let playing = false;
let loopMode = true;
let speed = 1;

function fitCanvas() {
  const wrap = canvas.parentElement;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  const aspect = w / h;
  perspCam.aspect = aspect; perspCam.updateProjectionMatrix();
  isoCam.__aspect = aspect;
  orbit.apply(); // re-fit the ortho frustum to the new aspect
}
window.addEventListener('resize', fitCanvas);

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const dt = clock.getDelta();
  if (currentClip && playing) {
    rigs.update(dt * speed);
    updateScrub();
  }
  renderer.render(scene, camera);
}

// ---------- animation playback ----------
async function loadClip(id) {
  const r = await ipcRenderer.invoke('resolve-clip', id);
  if (r.error) return fail(new Error(r.error));
  const glb = await loadGlb(r.glbFile);
  if (!glb.animations || !glb.animations.length) return fail(new Error(`no animation in ${r.name}`));
  const norm = normaliseClip(glb.animations[0], r.format);
  currentClip = { clip: norm.clip, rootRotationX: norm.rootRotationX, best: norm.best, name: r.name, format: r.format };
  rigs.setLoop(loopMode);
  rigs.setClip(currentClip);
  playing = true;
  setTransportUI();
  const label = r.name + (norm.best ? '' : ' (fbx, best-effort)');
  const nameEl = document.getElementById('clipName');
  if (nameEl) nameEl.textContent = label;
  const np = document.getElementById('nowPlaying');
  if (np) np.textContent = label;
  // keep the clip list highlight in sync (a clip may be chosen from the browser)
  const list = document.getElementById('clipList');
  if (list) for (const el of list.querySelectorAll('.item[data-id]')) el.classList.toggle('sel', el.dataset.id === id);
}

function updateScrub() {
  const scrub = document.getElementById('scrub');
  if (!scrub || !currentClip) return;
  const dur = rigs.duration();
  scrub.value = String(((rigs.time() % dur) / dur) * 1000);
}

function setTransportUI() {
  const pp = document.getElementById('playPause');
  if (pp) pp.textContent = playing ? '❚❚' : '▶';
  const lp = document.getElementById('loopBtn');
  if (lp) lp.classList.toggle('active', loopMode);
}

// ---------- clothing ----------
const equipped = new Map(); // name -> { kind, masks:[path], baseTextures:[path], texture, meshFile, attachBone }
let whiteTex = null;
function getWhiteTex() {
  if (!whiteTex) {
    const d = new Uint8Array([255, 255, 255, 255]);
    whiteTex = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
    whiteTex.needsUpdate = true;
  }
  return whiteTex;
}

/** Update the body rig's diffuse map to a freshly composited texture. Only the
 *  body's own SkinnedMeshes are updated -- static items (hats) are plain Meshes
 *  parented to a body bone, and must keep their own texture. */
function setBodyTexture(tex) {
  const body = rigs.bodyRig();
  if (!body) return;
  body.root.traverse((o) => {
    if (o.isSkinnedMesh && o.material && o.material.uniforms && o.material.uniforms.map) o.material.uniforms.map.value = tex;
  });
}

/** Rebuild the body diffuse from skin + every equipped composite layer + mask. */
async function recompositeBody() {
  const layers = [], maskFiles = [];
  for (const e of equipped.values()) {
    for (const b of e.baseTextures) layers.push({ path: b, tint: e.tint || null });
    for (const m of e.masks) maskFiles.push(m);
  }
  const r = await ipcRenderer.invoke('compose-body', { layers, maskFiles });
  if (r.error) return fail(new Error(r.error));
  setBodyTexture(await loadTexture(r.file, false));
}

/** The active hat category (most-recently-equipped hat), drives hair alternates. */
function currentHatCategory() {
  let cat = null;
  for (const e of equipped.values()) if (e.kind === 'static' && e.hatCategory) cat = e.hatCategory;
  return cat;
}

async function equipClothing(name) {
  if (equipped.has(name)) { await unequipClothing(name); return; }
  const r = await ipcRenderer.invoke('resolve-clothing', name);
  if (r.error) return fail(new Error(r.error));
  const entry = {
    kind: r.kind, masks: r.maskFiles || [], baseTextures: r.baseTextures || [],
    meshFile: r.meshFile, texture: r.texture, attachBone: r.attachBone,
    hatCategory: r.hatCategory || null, tint: null,
  };
  if (r.kind === 'mesh') {
    const tex = r.texture ? await loadTexture(r.texture, false) : getWhiteTex();
    const root = await loadSkinnedRoot(r.meshFile, tex);
    rigs.add('cloth:' + name, root);
  } else if (r.kind === 'static') {
    await attachStatic(name, r);
  }
  equipped.set(name, entry);
  await recompositeBody();
  if (r.kind === 'static') await applyHair(); // hair may tuck under the hat
  markClothingUI();
}

async function unequipClothing(name) {
  const e = equipped.get(name);
  if (!e) return;
  if (e.kind === 'mesh') rigs.removeKind('cloth:' + name);
  else if (e.kind === 'static') detachStatic(name);
  equipped.delete(name);
  await recompositeBody();
  if (e.kind === 'static') await applyHair(); // hat gone, hair may return
  markClothingUI();
}

/** Recolour one equipped item (RGB multiply). Composite items recomposite; mesh/static tint live. */
function setItemTint(name, color) {
  const e = equipped.get(name);
  if (!e) return;
  e.tint = color;
  const apply = (root) => root && root.traverse((o) => {
    if (o.material && o.material.uniforms && o.material.uniforms.tint) o.material.uniforms.tint.value.set(...(color || [1, 1, 1]));
  });
  if (e.kind === 'mesh') { const rig = rigs.get('cloth:' + name); apply(rig && rig.root); }
  else if (e.kind === 'static') { const s = statics.get(name); apply(s && s.obj); }
  else if (e.kind === 'composite') recompositeBody();
}

// Static items (hats): rigid mesh bone-parented to m_AttachBone. The mesh is
// authored in the bone's LOCAL space (hat-sized coords about the bone origin), so
// it parents to the bone with an identity local transform and follows it directly.
const statics = new Map(); // name -> { boneName, obj }

async function attachStatic(name, r) {
  const body = rigs.bodyRig();
  if (!body) return;
  let skeleton = null;
  body.root.traverse((o) => { if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton; });
  if (!skeleton) return fail(new Error('no body skeleton to attach to'));
  const boneName = r.attachBone || 'Bip01_Head';
  const bone = skeleton.bones.find((b) => b.name === boneName);
  if (!bone) return fail(new Error(`attach bone not found: ${boneName}`));

  const obj = (await loadGlb(r.meshFile)).scene;
  const tex = r.texture ? await loadTexture(r.texture, false) : getWhiteTex();
  const mat = makeMaterial(tex, lightingObj(), true);
  obj.traverse((o) => {
    if (o.isMesh) {
      if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
      o.material = mat; o.frustumCulled = false;
    }
  });
  bone.add(obj);
  statics.set(name, { boneName, obj });
}

function detachStatic(name) {
  const s = statics.get(name);
  if (s && s.obj.parent) s.obj.parent.remove(s.obj);
  statics.delete(name);
}

// Held items / weapons: mesh bone-parented to Bip01_Prop1/Prop2 with the model's
// hand-attachment transform (offset/rotate/scale, conjugated into three's space by
// partMatrix, the same maths the icon path uses for weapon parts).
const held = new Map(); // name -> { obj, prop }

// Which hand new items go into. Default primary (Bip01_Prop1) -- the right hand,
// where weapons belong; the model's declared prop is only a fallback.
let handTarget = 'Bip01_Prop1';
const otherProp = (p) => (p === 'Bip01_Prop1' ? 'Bip01_Prop2' : 'Bip01_Prop1');

async function equipHeld(name, prop) {
  if (held.has(name)) { unequipHeld(name); return; }
  const body = rigs.bodyRig();
  if (!body) return;
  const r = await ipcRenderer.invoke('resolve-item', name);
  if (r.error) return fail(new Error(r.error));

  const targetProp = prop || handTarget;
  // Prop1/Prop2 are attachment nodes in the graph, not skinning bones; the clip
  // animates them by name so a held item follows the hand.
  const bone = body.root.getObjectByName(targetProp);
  if (!bone) return fail(new Error(`hand bone not found: ${targetProp}`));

  // Use the model's attachment for the chosen hand; else the other hand's (offsets
  // are small grip tweaks), else identity.
  const att = (r.attachments && (r.attachments[targetProp] || r.attachments[otherProp(targetProp)])) || null;

  const obj = (await loadGlb(r.meshFile)).scene;
  const tex = r.texture ? await loadTexture(r.texture, true) : getWhiteTex();
  const mat = makeMaterial(tex, lightingObj(), true);
  obj.traverse((o) => {
    if (o.isMesh) {
      if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
      o.material = mat; o.frustumCulled = false;
    }
  });

  const holder = new THREE.Object3D();
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(partMatrix(null, att));
  if (r.scale && r.scale !== 1) obj.scale.setScalar(r.scale);
  holder.add(obj);
  bone.add(holder);
  held.set(name, { obj: holder, prop: targetProp });
  markHeldUI();
}

/** Move an already-held item to the other hand. */
async function switchHand(name) {
  const h = held.get(name);
  if (!h) return;
  const to = otherProp(h.prop);
  unequipHeld(name);
  await equipHeld(name, to);
}

function unequipHeld(name) {
  const h = held.get(name);
  if (h && h.obj.parent) h.obj.parent.remove(h.obj);
  held.delete(name);
  markHeldUI();
}

/** Re-resolve + re-equip everything (used after a gender/body change). */
async function reequipAll() {
  const names = [...equipped.keys()];
  for (const n of names) { const e = equipped.get(n); if (e.kind === 'mesh') rigs.removeKind('cloth:' + n); else if (e.kind === 'static') detachStatic(n); }
  equipped.clear();
  for (const n of names) await equipClothing(n);
  // held items are parented to the old body's bones; re-attach to the new body,
  // preserving whichever hand each was in
  const heldEntries = [...held.entries()].map(([n, h]) => [n, h.prop]);
  for (const [n] of heldEntries) unequipHeld(n);
  for (const [n, p] of heldEntries) await equipHeld(n, p);
  markHeldUI();
}

// ---------- skinned-part loading ----------
/** Load a glb, apply a skinned material, and return its root ready to add as a rig. */
async function loadSkinnedRoot(meshFile, texture, tint) {
  const glb = await loadGlb(meshFile);
  const root = glb.scene;
  const mat = makeSkinnedMaterial(texture, lightingObj());
  if (tint) mat.uniforms.tint.value.set(tint[0], tint[1], tint[2]);
  root.traverse((o) => {
    if (o.isMesh) {
      if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
      o.material = mat;
      o.frustumCulled = false; // skinned bounds are unreliable; never cull
    }
  });
  return root;
}

let currentBody = null;
async function loadBody(body) {
  currentBody = body; // remembered for the thumbnail reference body
  const texture = await loadTexture(body.skinTexture, false);
  const root = await loadSkinnedRoot(body.meshFile, texture);
  const framing = !rigs.bodyRig();
  rigs.removeKind('body');
  rigs.add('body', root);
  root.updateMatrixWorld(true);

  // frame once, on first load: PZ body ~1.0 tall, feet near y=0
  if (framing || !currentClip) {
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    orbit.setTarget(new THREE.Vector3(0, center.y, 0));
    if (framing) { orbit.state.radius = Math.max(size.y, 1) * 1.9; orbit.apply(); }
  }
}

// ---------- hair + beard ----------
const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const rgbToHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
let hairColor = hexToRgb('#5a3a20');
let beardColor = hexToRgb('#5a3a20');
let currentHair = 'None';
let currentBeard = 'None';

async function applyPart(kind, name, color, hatCategory) {
  rigs.removeKind(kind);
  if (!name || name === 'None') return;
  const r = await ipcRenderer.invoke('resolve-hair', { kind, name, hatCategory });
  if (r.error) return fail(new Error(r.error));
  if (r.none) return; // model-less style (e.g. Bald, or tucked fully under a hat)
  const tex = await loadTexture(r.texture, false);
  const root = await loadSkinnedRoot(r.meshFile, tex, color);
  rigs.add(kind, root);
}
const applyHair = () => applyPart('hair', currentHair, hairColor, currentHatCategory());
const applyBeard = () => applyPart('beard', currentBeard, beardColor);

// ---------- tabs ----------
function bindTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const panes = [...document.querySelectorAll('.pane')];
  for (const t of tabs) {
    t.onclick = () => {
      for (const x of tabs) x.classList.toggle('active', x === t);
      for (const p of panes) p.classList.toggle('active', p.dataset.tab === t.dataset.tab);
    };
  }
}

// ---------- controls ----------
function bindControls(data) {
  const toneRow = document.getElementById('tones');
  const clipInfo = document.getElementById('clipInfo');

  async function changeGender(g) {
    for (const b of document.querySelectorAll('#genderSeg button')) b.classList.toggle('active', b.dataset.g === g);
    const r = await ipcRenderer.invoke('set-appearance', { gender: g });
    if (r.error) return fail(new Error(r.error));
    await loadBody(r.body);   // different mesh; orphans hats + gendered cloth rigs
    renderTones(r.body);
    currentHair = 'None';     // hair styles are gender-specific
    await refreshHairList();
    await applyHair();
    await reequipAll();       // re-attach hats + re-resolve gendered clothing meshes
    await recompositeBody();
  }
  for (const b of document.querySelectorAll('#genderSeg button')) {
    b.classList.toggle('active', b.dataset.g === data.gender);
    b.onclick = () => changeGender(b.dataset.g);
  }

  function renderTones(body) {
    toneRow.innerHTML = '';
    body.tones.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'tone' + (t === body.skin ? ' active' : '');
      b.textContent = String(i + 1) + (t.endsWith('a') ? 'h' : '');
      b.title = t + (t.endsWith('a') ? ' (body hair)' : '');
      b.onclick = async () => {
        // skin tone is just the composite base; swap the texture, keep meshes/hats
        const r = await ipcRenderer.invoke('set-appearance', { skin: t });
        if (r.error) return fail(new Error(r.error));
        await recompositeBody();
        renderTones(r.body);
      };
      toneRow.appendChild(b);
    });
  }
  renderTones(data.body);

  clipInfo.textContent = `${data.clipCount} clips (${data.modClipCount} from this mod)`;

  bindTabs();
  bindHairBeard();
  bindClothing();
  bindHeld();
  bindClipList();
  bindBrowser();
  bindExport();
  bindView();
  bindLighting();
  bindTransport();

  document.getElementById('openMod').onclick = async () => {
    const r = await ipcRenderer.invoke('open-mod');
    if (r.canceled) return;
    if (r.error) return fail(new Error(r.error));
    await loadBody(r.body);
    renderTones(r.body);
    document.getElementById('modLabel').textContent = r.modPath;
    clipInfo.textContent = `${r.clipCount} clips (${r.modClipCount} from this mod)`;
  };

  document.getElementById('gameDirBtn').onclick = async () => {
    const r = await ipcRenderer.invoke('choose-game-dir');
    if (r.canceled) return;
    if (r.error) return fail(new Error(r.error));
    setGameDirBadge(r.gameDir);
    if (r.body) { await loadBody(r.body); renderTones(r.body); }
  };

  document.getElementById('iconsBtn').onclick = () => ipcRenderer.invoke('open-icons');
}

/** Show whether a Project Zomboid install is configured (vanilla assets). */
function setGameDirBadge(dir) {
  const b = document.getElementById('gameDirBtn');
  if (!b) return;
  b.textContent = dir ? 'Game folder ✓' : 'Game folder …';
  b.title = dir
    ? `Project Zomboid: ${dir}\nClick to change.`
    : 'No Project Zomboid install set. Vanilla bodies, clothing and animations will not resolve. Click to set it.';
  b.style.borderColor = dir ? '' : '#8a6d3b';
}

// ---------- hair + beard controls ----------
async function refreshHairList() {
  const { hair, beard } = await ipcRenderer.invoke('list-hair');
  const fill = (sel, names, cur) => {
    sel.innerHTML = '';
    for (const n of ['None', ...names]) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      if (n === cur) o.selected = true;
      sel.appendChild(o);
    }
  };
  fill(document.getElementById('hairSel'), hair, currentHair);
  fill(document.getElementById('beardSel'), beard, currentBeard);
}

async function bindHairBeard() {
  await refreshHairList();
  const hairSel = document.getElementById('hairSel');
  const beardSel = document.getElementById('beardSel');
  const hairCol = document.getElementById('hairCol');
  const beardCol = document.getElementById('beardCol');

  hairSel.onchange = async () => { currentHair = hairSel.value; await applyHair(); };
  beardSel.onchange = async () => { currentBeard = beardSel.value; await applyBeard(); };
  hairCol.oninput = () => {
    hairColor = hexToRgb(hairCol.value);
    const rig = rigs.get('hair');
    if (rig) rig.root.traverse((o) => { if (o.material && o.material.uniforms) o.material.uniforms.tint.value.set(...hairColor); });
  };
  beardCol.oninput = () => {
    beardColor = hexToRgb(beardCol.value);
    const rig = rigs.get('beard');
    if (rig) rig.root.traverse((o) => { if (o.material && o.material.uniforms) o.material.uniforms.tint.value.set(...beardColor); });
  };
}

// ---------- clothing list ----------
let allClothing = [];
async function bindClothing() {
  allClothing = await ipcRenderer.invoke('list-clothing');
  const search = document.getElementById('clothSearch');
  const locSel = document.getElementById('clothLoc');
  const list = document.getElementById('clothList');

  // location filter, ordered by frequency
  const counts = {};
  for (const c of allClothing) counts[c.location] = (counts[c.location] || 0) + 1;
  const locs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  locSel.innerHTML = '<option value="">all locations</option>' +
    locs.map((l) => `<option value="${l}">${l} (${counts[l]})</option>`).join('');

  function render() {
    const f = (search.value || '').toLowerCase();
    const loc = locSel.value;
    const rows = allClothing.filter((c) => (!loc || c.location === loc) && (!f || c.name.toLowerCase().includes(f)));
    list.innerHTML = '';
    for (const c of rows.slice(0, 400)) {
      const el = document.createElement('div');
      el.className = 'item' + (c.isMod ? ' mod' : '') + (equipped.has(c.name) ? ' sel' : '');
      el.dataset.name = c.name;
      el.textContent = c.name;
      el.title = `${c.kind} / ${c.location}${c.isMod ? ' (mod)' : ''}`;
      el.onclick = () => equipClothing(c.name);
      list.appendChild(el);
    }
    if (rows.length > 400) {
      const more = document.createElement('div');
      more.className = 'item more';
      more.textContent = `+${rows.length - 400} more, refine search…`;
      list.appendChild(more);
    }
  }
  search.oninput = render;
  locSel.onchange = render;
  render();
}

const clothingLoc = (name) => { const c = allClothing.find((x) => x.name === name); return c ? c.location : ''; };

function markClothingUI() {
  const list = document.getElementById('clothList');
  if (list) for (const el of list.querySelectorAll('.item[data-name]')) el.classList.toggle('sel', equipped.has(el.dataset.name));
  const worn = document.getElementById('wornList');
  const count = document.getElementById('wornCount');
  if (count) count.textContent = equipped.size ? `(${equipped.size})` : '';
  if (!worn) return;
  worn.innerHTML = '';
  for (const [name, e] of equipped) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = name; nm.title = name;
    const tag = document.createElement('span');
    tag.className = 'tag'; tag.textContent = clothingLoc(name);
    const col = document.createElement('input');
    col.type = 'color'; col.className = 'chipcol';
    col.value = e.tint ? rgbToHex(e.tint) : '#ffffff';
    col.title = 'recolour (tint)';
    col.oninput = () => setItemTint(name, hexToRgb(col.value));
    const rm = document.createElement('span');
    rm.className = 'rm'; rm.textContent = '×'; rm.title = 'remove';
    rm.onclick = () => unequipClothing(name);
    chip.append(nm, tag, col, rm);
    worn.appendChild(chip);
  }
}

// ---------- held items list ----------
let allHeld = [];
async function bindHeld() {
  allHeld = await ipcRenderer.invoke('list-items');
  const search = document.getElementById('itemSearch');
  const list = document.getElementById('itemList');
  for (const b of document.querySelectorAll('#handSeg button')) {
    b.classList.toggle('active', b.dataset.p === handTarget);
    b.onclick = () => { handTarget = b.dataset.p; for (const x of document.querySelectorAll('#handSeg button')) x.classList.toggle('active', x === b); };
  }
  function render() {
    const f = (search.value || '').toLowerCase();
    const rows = allHeld.filter((c) => !f || c.name.toLowerCase().includes(f));
    list.innerHTML = '';
    for (const c of rows.slice(0, 400)) {
      const el = document.createElement('div');
      el.className = 'item' + (held.has(c.name) ? ' sel' : '');
      el.dataset.name = c.name;
      el.textContent = c.name;
      el.title = c.name;
      el.onclick = async () => { await equipHeld(c.name); markHeldUI(); };
      list.appendChild(el);
    }
    if (rows.length > 400) {
      const more = document.createElement('div');
      more.className = 'item more';
      more.textContent = `+${rows.length - 400} more, refine search…`;
      list.appendChild(more);
    }
  }
  search.oninput = render;
  render();
}

function markHeldUI() {
  const list = document.getElementById('itemList');
  if (list) for (const el of list.querySelectorAll('.item[data-name]')) el.classList.toggle('sel', held.has(el.dataset.name));
  const worn = document.getElementById('heldList');
  const count = document.getElementById('heldCount');
  if (count) count.textContent = held.size ? `(${held.size})` : '';
  if (!worn) return;
  worn.innerHTML = '';
  for (const [name, h] of held) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = name; nm.title = name;
    const tag = document.createElement('span');
    tag.className = 'tag hand'; tag.textContent = h.prop === 'Bip01_Prop1' ? 'primary' : 'secondary';
    tag.title = 'click to switch hand';
    tag.style.cursor = 'pointer';
    tag.onclick = () => switchHand(name);
    const rm = document.createElement('span');
    rm.className = 'rm'; rm.textContent = '×'; rm.title = 'remove';
    rm.onclick = () => { unequipHeld(name); markHeldUI(); };
    chip.append(nm, tag, rm);
    worn.appendChild(chip);
  }
}

// ---------- camera + facing ----------
// Switch between the free perspective orbit and the vanilla PZ CharacterModelCamera:
// orthographic, pitched 30 deg (PI/6) and yawed 45 deg (PI/4). In orbit spherical
// terms that is polar phi = 60 deg (30 deg above horizontal) and azimuth = 45 deg.
function setCamMode(mode) {
  camera = mode === 'iso' ? isoCam : perspCam;
  const iso = document.getElementById('camIso'), orb = document.getElementById('camOrbit');
  if (iso) iso.classList.toggle('active', mode === 'iso');
  if (orb) orb.classList.toggle('active', mode !== 'iso');
  if (mode === 'iso') { orbit.state.theta = Math.PI / 4; orbit.state.phi = Math.PI / 3; }
  fitCanvas();
}

// Compass layout (3x3, centre empty). S = facing the camera, matching the default
// idle; degrees are the character's Y rotation.
const FACING_GRID = [
  ['NW', 135], ['N', 180], ['NE', 225],
  ['W', 90], null, ['E', 270],
  ['SW', 45], ['S', 0], ['SE', 315],
];
function bindView() {
  const orb = document.getElementById('camOrbit'), iso = document.getElementById('camIso');
  if (orb) orb.onclick = () => setCamMode('orbit');
  if (iso) iso.onclick = () => setCamMode('iso');
  const compass = document.getElementById('compass');
  if (!compass) return;
  compass.innerHTML = '';
  for (const cell of FACING_GRID) {
    if (!cell) { compass.appendChild(document.createElement('span')); continue; }
    const [label, deg] = cell;
    const b = document.createElement('button');
    b.className = 'cbtn'; b.textContent = label;
    b.onclick = () => {
      rigs.setFacing(deg * Math.PI / 180);
      for (const e of compass.querySelectorAll('.cbtn')) e.classList.toggle('active', e === b);
    };
    compass.appendChild(b);
  }
}

// ---------- lighting controls ----------
// Each slider's value label is clickable to reset that one slider to its default;
// the section "Reset" button restores them all.
function bindLighting() {
  const rows = [
    ['ltAmbient', CHAR_LIGHTING.ambient[0], (v) => light.ambient = v, () => light.ambient],
    ['ltKey', CHAR_LIGHTING.keyColour[0], (v) => light.keyBright = v, () => light.keyBright],
    ['ltX', CHAR_LIGHTING.keyDir[0], (v) => light.keyDir[0] = v, () => light.keyDir[0]],
    ['ltY', CHAR_LIGHTING.keyDir[1], (v) => light.keyDir[1] = v, () => light.keyDir[1]],
    ['ltZ', CHAR_LIGHTING.keyDir[2], (v) => light.keyDir[2] = v, () => light.keyDir[2]],
  ];
  const sync = (id, get) => { const el = document.getElementById(id), v = document.getElementById(id + 'V'); if (el) el.value = get(); if (v) v.textContent = (+get()).toFixed(2); };
  for (const [id, def, set, get] of rows) {
    const el = document.getElementById(id), v = document.getElementById(id + 'V');
    if (!el) continue;
    sync(id, get);
    el.oninput = () => { set(Number(el.value)); sync(id, get); applyLighting(); };
    if (v) { v.style.cursor = 'pointer'; v.title = `reset (default ${def.toFixed(2)})`; v.onclick = () => { set(def); sync(id, get); applyLighting(); }; }
  }
  const rst = document.getElementById('ltReset');
  if (rst) rst.onclick = () => { for (const [id, def, set, get] of rows) { set(def); sync(id, get); } applyLighting(); };
}

// ---------- export ----------
// Render the main character (all layers) at each given time onto a transparent
// square target and read back PNG data URLs, using the current orbit view.
function exportFrames(size, times) {
  const target = new THREE.WebGLRenderTarget(size, size);
  const buf = new Uint8Array(size * size * 4);
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');

  grid.visible = false;
  // square the active camera for the export target
  let prevAspect;
  if (camera.isOrthographicCamera) { prevAspect = camera.__aspect || 1; camera.__aspect = 1; orbit.apply(); }
  else { prevAspect = camera.aspect; camera.aspect = 1; camera.updateProjectionMatrix(); }
  const prevClear = renderer.getClearColor(new THREE.Color()); const prevAlpha = renderer.getClearAlpha();
  const prevTime = rigs.time();
  const out = [];
  for (const t of times) {
    if (currentClip) rigs.setTime(t);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, buf);
    renderer.setRenderTarget(null);
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      const sy = size - 1 - y;
      for (let x = 0; x < size; x++) {
        const di = (y * size + x) * 4, si = (sy * size + x) * 4;
        img.data[di] = buf[si]; img.data[di + 1] = buf[si + 1]; img.data[di + 2] = buf[si + 2]; img.data[di + 3] = buf[si + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
    out.push(canvas.toDataURL('image/png'));
  }
  renderer.setClearColor(prevClear, prevAlpha);
  if (camera.isOrthographicCamera) { camera.__aspect = prevAspect; orbit.apply(); }
  else { camera.aspect = prevAspect; camera.updateProjectionMatrix(); }
  grid.visible = true;
  if (currentClip) rigs.setTime(prevTime);
  target.dispose();
  return out;
}

let exportDir = null;
async function ensureExportDir() {
  if (!exportDir) exportDir = await ipcRenderer.invoke('choose-folder');
  return exportDir;
}
function exportName() {
  const clip = currentClip ? currentClip.name : 'bindpose';
  return `character_${clip}`;
}

function bindExport() {
  const status = document.getElementById('exportStatus');
  const sizeOf = () => Number(document.getElementById('exportSize').value) || 512;
  document.getElementById('exportStill').onclick = async () => {
    const dir = await ensureExportDir(); if (!dir) return;
    status.textContent = 'rendering…';
    const [png] = exportFrames(sizeOf(), [rigs.time()]);
    const r = await ipcRenderer.invoke('export-still', { dataUrl: png, dir, name: exportName() });
    status.textContent = r.error ? 'error: ' + r.error : 'saved ' + r.file.split(/[\\/]/).pop();
  };
  document.getElementById('exportSheet').onclick = async () => {
    if (!currentClip) { status.textContent = 'pick an animation first'; return; }
    const dir = await ensureExportDir(); if (!dir) return;
    const n = Math.max(2, Math.min(64, Number(document.getElementById('exportFrames').value) || 16));
    status.textContent = `rendering ${n} frames…`;
    const dur = rigs.duration();
    const times = Array.from({ length: n }, (_, i) => (i / n) * dur);
    const frames = exportFrames(sizeOf(), times);
    const r = await ipcRenderer.invoke('export-sheet', { frames, dir, name: exportName(), cols: Math.ceil(Math.sqrt(n)) });
    status.textContent = r.error ? 'error: ' + r.error : `saved ${r.outPath.split(/[\\/]/).pop()} (${r.columns}x${r.rows})`;
  };
  document.getElementById('exportGif').onclick = () => exportGif(status);
  document.getElementById('exportFolder').onclick = async () => { exportDir = await ipcRenderer.invoke('choose-folder') || exportDir; if (exportDir) status.textContent = 'folder: ' + exportDir; };
}

// Steam Workshop preset: 512x512 looping GIF auto-optimised under 1 MB.
async function exportGif(status) {
  if (!currentClip) { status.textContent = 'pick an animation first'; return; }
  const dir = await ensureExportDir(); if (!dir) return;
  const dur = rigs.duration();
  const N = 24; // render a generous frame set; the optimiser subsamples to fit
  status.textContent = `rendering ${N} frames + optimising GIF…`;
  await new Promise((r) => setTimeout(r, 16)); // let the status paint
  const times = Array.from({ length: N }, (_, i) => (i / N) * dur);
  const frames = exportFrames(512, times);
  const transparent = document.getElementById('gifTransparent').checked;
  const background = document.getElementById('gifBg').value;
  const r = await ipcRenderer.invoke('export-gif', {
    frames, dir, name: exportName() + '_512',
    duration: dur, maxBytes: 1024 * 1024, transparent, background,
  });
  if (r.error) { status.textContent = 'error: ' + r.error; return; }
  const kb = (r.bytes / 1024).toFixed(0);
  status.textContent = `saved ${r.outPath.split(/[\\/]/).pop()} - ${kb}KB, ${r.frames}f/${r.colors}c${r.fit ? '' : ' (could not fit 1MB!)'}`;
}

// ---------- animation browser (thumbnail grid) ----------
let thumbs = null;                 // ThumbRenderer, created lazily
let thumbQueue = [];               // cells awaiting a static thumbnail
let thumbBusy = false;
let hoverCell = null, hoverRaf = 0; // active hover preview

const baseNoExt = (p) => String(p).replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');

const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const cell = e.target;
    if (e.isIntersecting && !cell._done && !cell._queued) {
      cell._queued = true;
      thumbQueue.push(cell);
      pumpThumbs();
    }
  }
}, { rootMargin: '150px' });

async function ensureThumbs() {
  if (!thumbs) thumbs = new ThumbRenderer(renderer);
  if (currentBody && thumbs.gender !== currentBody.gender) {
    await thumbs.setBody(currentBody.meshFile, currentBody.skinTexture, currentBody.gender);
  }
}

async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    if (hoverCell) break; // let a live hover own the thumb renderer
    const cell = thumbQueue.shift();
    if (!cell || cell._done || !cell.isConnected) continue;
    try { await genThumb(cell); } catch (e) { console.error('[thumb] fail', cell._clip && cell._clip.name, e && e.message); }
  }
  thumbBusy = false;
}

async function genThumb(cell) {
  const clip = cell._clip;
  const r = await ipcRenderer.invoke('resolve-clip', clip.id);
  if (r.error) { cell._done = true; return; }
  const key = thumbs.gender + '_' + baseNoExt(r.glbFile);
  const got = await ipcRenderer.invoke('thumb-get', key);
  if (got.file) { cell._img.src = fileUrl(got.file); cell._done = true; return; }
  const glb = await loadGlb(r.glbFile);
  if (!glb.animations || !glb.animations.length) { cell._done = true; return; }
  thumbs.bind(normaliseClip(glb.animations[0], r.format));
  const dataUrl = thumbs.renderAt(0);
  if (dataUrl) { cell._img.src = dataUrl; cell._thumb0 = dataUrl; ipcRenderer.invoke('thumb-put', { key, dataUrl }); }
  cell._done = true;
}

function startHover(cell) {
  if (hoverCell) stopHover(hoverCell);
  hoverCell = cell;
  (async () => {
    const clip = cell._clip;
    const r = await ipcRenderer.invoke('resolve-clip', clip.id);
    if (r.error || hoverCell !== cell) return;
    const glb = await loadGlb(r.glbFile);
    if (!glb.animations || !glb.animations.length || hoverCell !== cell) return;
    thumbs.bind(normaliseClip(glb.animations[0], r.format));
    const dur = thumbs.duration();
    let t0 = null;
    const step = (ts) => {
      if (hoverCell !== cell) return;
      if (t0 === null) t0 = ts;
      const t = ((ts - t0) / 1000) % dur;
      cell._img.src = thumbs.renderAt(t);
      hoverRaf = requestAnimationFrame(step);
    };
    hoverRaf = requestAnimationFrame(step);
  })();
}

function stopHover(cell) {
  if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
  if (hoverCell === cell) hoverCell = null;
  if (cell._thumb0) cell._img.src = cell._thumb0; // restore frozen frame 0
  pumpThumbs(); // resume any queued static thumbnails
}

// Actors that remain after the data-layer filter, grouped for the browser.
function actorGroup(actor) {
  const a = String(actor).toLowerCase();
  if (a === 'zombie') return 'zombie';
  if (a === 'kate') return 'kate';
  return 'player'; // bob
}

// Clip categories by ordered keyword (first match wins). Order matters: e.g. Aim
// before Idle so "IdleAim1Hand" is Aim. "Action" is the catch-all.
const CLIP_CATEGORIES = [
  ['Aim', /aim/i],
  ['Attack', /attack/i],
  ['Reload', /reload|equip|unequip|rack|chamber|holster/i],
  ['Vehicle', /bicycle|vehicle|drive|passenger|mount|dismount|pedal/i],
  ['Sneak', /sneak|stealth/i],
  ['Run', /run/i],
  ['Walk', /walk/i],
  ['Sit', /sit|seated/i],
  ['Fishing', /fish/i],
  ['Climb', /climb|va[lu]+ltover|vault|hop|fence|window/i],
  ['Fall', /fall|death|die|suicide|landing|knock|collapse|trip/i],
  ['React', /react|bite|defend|\bhit\b|stagger|hurt|pain/i],
  ['Emote', /emote|signal|wave|surrender|clap|dance|bow|salute/i],
  ['Farming', /milk|forage|dig|plant|harvest|shovel/i],
  ['Carry', /carry|lift|drag/i],
  ['Turn', /turn/i],
  ['Idle', /idle/i],
];
function categoryOf(name) {
  for (const [label, re] of CLIP_CATEGORIES) if (re.test(name)) return label;
  return 'Action';
}

let browserActor = 'player';
let browserCategory = 'all';

function populateGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  thumbQueue = [];
  const f = (document.getElementById('browserSearch').value || '').toLowerCase();
  const rows = allClips.filter((c) =>
    actorGroup(c.actor) === browserActor &&
    (browserCategory === 'all' || categoryOf(c.name) === browserCategory) &&
    (!f || c.name.toLowerCase().includes(f)));
  document.getElementById('browserCount').textContent = `${rows.length} clips`;
  for (const c of rows) {
    const cell = document.createElement('div');
    cell.className = 'gcell' + (c.best ? '' : ' fbx') + (c.isMod ? ' mod' : '');
    const img = document.createElement('img'); img.className = 'gimg';
    const label = document.createElement('div'); label.className = 'glabel'; label.textContent = c.name;
    cell.append(img, label);
    cell._clip = c; cell._img = img;
    cell.onclick = () => { closeBrowser(); loadClip(c.id); };
    cell.onmouseenter = () => startHover(cell);
    cell.onmouseleave = () => stopHover(cell);
    grid.appendChild(cell);
    thumbObserver.observe(cell);
  }
}

// Category chips for the current actor, only non-empty, with counts.
function buildCategoryChips() {
  const strip = document.getElementById('browserCats');
  if (!strip) return;
  const counts = {};
  let total = 0;
  for (const c of allClips) if (actorGroup(c.actor) === browserActor) { counts[categoryOf(c.name)] = (counts[categoryOf(c.name)] || 0) + 1; total++; }
  const order = [...CLIP_CATEGORIES.map((x) => x[0]), 'Action'].filter((c) => counts[c]);
  strip.innerHTML = '';
  const mk = (label, val, count) => {
    const b = document.createElement('button');
    b.className = 'catchip' + (browserCategory === val ? ' active' : '');
    b.textContent = `${label} ${count}`;
    b.onclick = () => { browserCategory = val; for (const x of strip.querySelectorAll('.catchip')) x.classList.toggle('active', x === b); populateGrid(); };
    strip.appendChild(b);
  };
  mk('All', 'all', total);
  for (const c of order) mk(c, c, counts[c]);
}

async function openBrowser() {
  document.getElementById('browser').style.display = 'flex';
  await ensureThumbs();
  buildCategoryChips();
  populateGrid();
}
function closeBrowser() {
  if (hoverCell) stopHover(hoverCell);
  document.getElementById('browser').style.display = 'none';
  thumbObserver.disconnect();
}

function bindBrowser() {
  document.getElementById('browseBtn').onclick = openBrowser;
  document.getElementById('browserClose').onclick = closeBrowser;
  const search = document.getElementById('browserSearch');
  let deb = null;
  search.oninput = () => { if (deb) clearTimeout(deb); deb = setTimeout(populateGrid, 150); };
  const actor = document.getElementById('browserActor');
  if (actor) actor.onchange = () => { browserActor = actor.value; browserCategory = 'all'; buildCategoryChips(); populateGrid(); };
}

// ---------- clip list ----------
let allClips = [];
async function bindClipList() {
  allClips = await ipcRenderer.invoke('list-clips');
  const search = document.getElementById('clipSearch');
  const list = document.getElementById('clipList');

  function render(filter) {
    const f = (filter || '').toLowerCase();
    const rows = allClips.filter((c) => !f || c.name.toLowerCase().includes(f) || c.actor.toLowerCase().includes(f));
    list.innerHTML = '';
    // cap the rendered rows; the full browser grid is a later phase
    for (const c of rows.slice(0, 400)) {
      const el = document.createElement('div');
      el.className = 'item' + (c.isMod ? ' mod' : '') + (c.best ? '' : ' fbx');
      el.dataset.id = c.id;
      el.textContent = c.name;
      el.title = `${c.actor} / ${c.format}${c.isMod ? ' (mod)' : ''}`;
      el.onclick = () => { markSelected(el); loadClip(c.id); };
      list.appendChild(el);
    }
    if (rows.length > 400) {
      const more = document.createElement('div');
      more.className = 'item more';
      more.textContent = `+${rows.length - 400} more, refine search…`;
      list.appendChild(more);
    }
  }
  function markSelected(el) {
    for (const e of list.querySelectorAll('.item.sel')) e.classList.remove('sel');
    if (el) el.classList.add('sel');
  }
  search.oninput = () => render(search.value);
  render('');
  await playDefaultIdle();
}

// The bind/rest pose has the feet splayed (never shown in-game); default to an
// idle clip so the character stands naturally the moment it loads, like the game.
async function playDefaultIdle() {
  if (currentClip) return;
  const idle = allClips.find((c) => c.name === 'Bob_Idle')
    || allClips.find((c) => /^bob_idle\b/i.test(c.name))
    || allClips.find((c) => c.actor.toLowerCase() === 'bob' && /idle/i.test(c.name));
  if (idle) await loadClip(idle.id);
}

function bindTransport() {
  document.getElementById('playPause').onclick = () => {
    if (!currentClip) return;
    playing = !playing;
    setTransportUI();
  };
  document.getElementById('loopBtn').onclick = () => {
    loopMode = !loopMode;
    rigs.setLoop(loopMode);
    setTransportUI();
  };
  document.getElementById('scrub').oninput = (e) => {
    if (!currentClip) return;
    playing = false; setTransportUI();
    rigs.setTime((Number(e.target.value) / 1000) * rigs.duration());
  };
  const spd = document.getElementById('speed');
  spd.oninput = () => {
    speed = Number(spd.value);
    document.getElementById('speedV').textContent = speed.toFixed(2) + 'x';
  };
  document.getElementById('stopBtn').onclick = () => {
    currentClip = null; playing = false;
    rigs.setClip(null);
    document.getElementById('clipName').textContent = '(bind pose)';
    const np = document.getElementById('nowPlaying'); if (np) np.textContent = '(bind pose)';
    const list = document.getElementById('clipList'); if (list) for (const el of list.querySelectorAll('.item.sel')) el.classList.remove('sel');
    setTransportUI();
  };
}

// headless smoke test: set hair/beard, then report done.
ipcRenderer.on('test-appearance', async (_e, opts) => {
  if (opts.hair) { currentHair = opts.hair; const s = document.getElementById('hairSel'); if (s) s.value = opts.hair; await applyHair(); }
  if (opts.beard) { currentBeard = opts.beard; const s = document.getElementById('beardSel'); if (s) s.value = opts.beard; await applyBeard(); }
  if (opts.clothing) { for (const n of String(opts.clothing).split(',')) { if (n.trim()) await equipClothing(n.trim()); } }
  if (opts.items) { for (const n of String(opts.items).split(',')) { if (n.trim()) await equipHeld(n.trim()); } }
  if (opts.cam) setCamMode(opts.cam);
  if (opts.facing != null && opts.facing !== '') rigs.setFacing(Number(opts.facing) * Math.PI / 180);
  if (opts.tab) { const t = document.querySelector(`.tab[data-tab="${opts.tab}"]`); if (t) t.click(); }
  if (opts.ambient != null && opts.ambient !== '') { light.ambient = Number(opts.ambient); applyLighting(); const el = document.getElementById('ltAmbient'); if (el) el.value = light.ambient; }
  if (opts.zoomHead || opts.zoomBone) {
    const body = rigs.bodyRig();
    const b = body && body.root.getObjectByName(opts.zoomBone || 'Bip01_Head');
    if (b) {
      body.root.updateMatrixWorld(true);
      const p = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
      orbit.setTarget(p); orbit.state.radius = opts.zoomRadius || 0.55; orbit.apply();
    }
  }
  ipcRenderer.send('test-appearance-done');
});

// headless smoke test: export a still + a sprite sheet to a given dir.
ipcRenderer.on('test-export', async (_e, dir) => {
  exportDir = dir;
  const [png] = exportFrames(256, [rigs.time()]);
  await ipcRenderer.invoke('export-still', { dataUrl: png, dir, name: 'test_still' });
  if (currentClip) {
    const times = Array.from({ length: 9 }, (_, i) => (i / 9) * rigs.duration());
    const frames = exportFrames(256, times);
    await ipcRenderer.invoke('export-sheet', { frames, dir, name: 'test', cols: 3 });
    // GIF: 512 auto-optimised under 1MB
    const gt = Array.from({ length: 24 }, (_, i) => (i / 24) * rigs.duration());
    const gframes = exportFrames(512, gt);
    if (window.__dumpFrames) { for (let i = 0; i < gframes.length; i++) await ipcRenderer.invoke('export-still', { dataUrl: gframes[i], dir, name: 'frame' + String(i).padStart(2, '0') }); }
    const budget = Number(window.__gifBudget) || 1024 * 1024;
    const gr = await ipcRenderer.invoke('export-gif', { frames: gframes, dir, name: 'test_512', duration: rigs.duration(), maxBytes: budget, transparent: !!window.__gifTransparent, background: '#1e1e22' });
    console.error('[gif]', JSON.stringify(gr));
  }
  ipcRenderer.send('test-export-done');
});

// headless smoke test: open the browser and let thumbnails generate.
ipcRenderer.on('test-browse', async (_e, filter) => {
  const search = document.getElementById('browserSearch');
  if (filter) search.value = filter;
  await openBrowser();
  // give the queue time to render the first screenful of thumbnails
  setTimeout(() => ipcRenderer.send('test-browse-done'), 9000);
});

// deterministic playback for headless smoke tests: load the first clip whose
// name contains `sub`, then freeze at mid-duration.
ipcRenderer.on('test-play', async (_e, sub) => {
  const c = allClips.find((x) => x.name.toLowerCase().includes(String(sub).toLowerCase()));
  if (!c) { console.error('[test-play] no clip matching', sub); return; }
  await loadClip(c.id);
  playing = false;
  if (currentClip) rigs.setTime(rigs.duration() * 0.5);
  setTransportUI();
  ipcRenderer.send('test-play-done');
});

// ---------- start ----------
async function start() {
  fitCanvas();
  const data = await ipcRenderer.invoke('get-data');
  document.getElementById('modLabel').textContent = data.modPath || '';
  setGameDirBadge(data.gameDir);
  if (data.error || !data.body) throw new Error(data.error || 'no body resolved (set your Game folder)');
  await loadBody(data.body);
  bindControls(data);
  hideBoot();
  renderLoop();
  ipcRenderer.send('ui-ready');
}
