'use strict';

// Electron main process for the Character viewer. Resolves a mod (plus the game
// install for vanilla assets), serves the character description + loadable asset
// paths to the renderer, and converts assets on demand. Mirrors previewApp/main.js.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolveMod, resolveModLayout } = require('../resolve');
const { resolveGameDir, setGameDir } = require('../settings');
const { resolveBody, listClips, resolveClip } = require('../character/assets');
const { parseHairStyles, parseBeardStyles, resolveStyle } = require('../character/hair');
const { listClothing, resolveClothing, buildClothingLocations } = require('../character/clothing');
const { listHeldItems, resolveHeldItem } = require('../character/items');
const { composeBody } = require('../character/compose');
const { saveStill, saveSpriteSheet } = require('../character/export');
const { saveGifAuto } = require('../character/gif');
const { spawnRole } = require('../runtime');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

let modPath = argVal('--mod');
let gameDir = resolveGameDir(argVal('--game-dir')).gameDir;

// current character description
const desc = { gender: 'male', skin: null };

let state = null; // { resolved, modRoots, clips }

function loadState() {
  const extraRoots = gameDir ? [gameDir] : [];
  const resolved = resolveMod(modPath, { extraRoots });
  const modRoots = resolveModLayout(modPath).roots;
  const clips = listClips(resolved.vfs, modRoots);
  const hair = parseHairStyles(resolved.vfs);
  const beards = parseBeardStyles(resolved.vfs);
  const locations = buildClothingLocations(resolved.vfs);
  const clothing = listClothing(resolved.vfs, modRoots, locations);
  const held = listHeldItems(resolved.vfs);
  state = { resolved, modRoots, clips, hair, beards, clothing, held };
  return state;
}

function bodyPayload() {
  const b = resolveBody(state.resolved.vfs, desc);
  desc.gender = b.gender;
  desc.skin = b.skin;
  return b;
}

function promptForMod(parent) {
  const r = dialog.showOpenDialogSync(parent, {
    properties: ['openDirectory'],
    title: 'Select a Project Zomboid mod folder (or your PZ install to browse vanilla)',
  });
  return r && r.length ? r[0] : null;
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1320, height: 860, title: 'pz-icon-maker | Character',
    backgroundColor: '#1e1e22',
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });

  const say = (msg) => { if (!win.isDestroyed()) win.webContents.send('boot-status', msg); };

  function startup() {
    if (!modPath) { say('Choose a mod folder…'); modPath = promptForMod(win); }
    if (!modPath) { console.error('[character] no mod folder selected'); app.exit(2); return; }
    say(`Reading ${path.basename(modPath)}…`);
    try { loadState(); }
    catch (e) {
      if (!win.isDestroyed()) win.webContents.send('boot-error', e.message);
      dialog.showErrorBox('pz-icon-maker', `Could not read that mod folder:\n\n${e.message}`);
      app.exit(2); return;
    }
    say('Loading character…');
    if (!win.isDestroyed()) win.webContents.send('boot-ready');
  }

  win.webContents.once('did-finish-load', () => setImmediate(startup));
  win.loadFile(path.join(__dirname, 'index.html'));

  // headless capture hook for smoke tests
  const shot = process.env.PZICON_SHOT;
  if (shot) {
    const autoClip = process.env.PZICON_AUTOCLIP;
    const hair = process.env.PZICON_HAIR, beard = process.env.PZICON_BEARD;
    const cap = async () => {
      try { const img = await win.webContents.capturePage(); fs.writeFileSync(shot, img.toPNG()); console.log('[character] shot ->', shot); }
      catch (e) { console.error('[character] shot failed:', e.message); }
      app.exit(0);
    };
    const once = (evt) => new Promise((res) => ipcMain.once(evt, res));
    ipcMain.once('ui-ready', async () => {
      const clothing = process.env.PZICON_CLOTHING;
      const items = process.env.PZICON_ITEMS;
      const zoomBone = process.env.PZICON_ZOOMBONE;
      const cam = process.env.PZICON_CAM, facing = process.env.PZICON_FACING;
      if (hair || beard || clothing || items || zoomBone || cam || facing) { win.webContents.send('test-appearance', { hair, beard, clothing, items, cam, facing, zoomHead: !!process.env.PZICON_ZOOMHEAD, zoomBone, zoomRadius: Number(process.env.PZICON_ZOOMR) || undefined }); await once('test-appearance-done'); }
      if (autoClip) { win.webContents.send('test-play', autoClip); await once('test-play-done'); }
      if (process.env.PZICON_BROWSE) { win.webContents.send('test-browse', process.env.PZICON_BROWSE_FILTER || ''); await once('test-browse-done'); }
      if (process.env.PZICON_EXPORT_DIR) {
        if (process.env.PZICON_GIF_BUDGET) await win.webContents.executeJavaScript(`window.__gifBudget=${Number(process.env.PZICON_GIF_BUDGET)}`);
        if (process.env.PZICON_GIF_TRANSPARENT) await win.webContents.executeJavaScript('window.__gifTransparent=true');
        if (process.env.PZICON_DUMP_FRAMES) await win.webContents.executeJavaScript('window.__dumpFrames=true');
        win.webContents.send('test-export', process.env.PZICON_EXPORT_DIR); await once('test-export-done');
      }
      setTimeout(cap, 700);
    });
    setTimeout(() => { if (!win.isDestroyed()) cap(); }, 25000);
  }

  // --- IPC ---
  ipcMain.handle('get-data', () => {
    let body = null, error = null;
    try { body = bodyPayload(); } catch (e) { error = e.message; }
    return {
      modPath, gameDir: gameDir || null,
      gender: desc.gender, skin: desc.skin,
      tones: body ? body.tones : [],
      body, error,
      clipCount: state.clips.length,
      modClipCount: state.clips.filter((c) => c.isMod).length,
    };
  });

  ipcMain.handle('set-appearance', (_e, next) => {
    if (next.gender) desc.gender = next.gender === 'female' ? 'female' : 'male';
    if (typeof next.skin === 'string') desc.skin = next.skin;
    try { return { body: bodyPayload() }; }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('list-clips', () => state.clips.map((c) => ({
    id: c.id, name: c.name, actor: c.actor, format: c.format, isMod: c.isMod, best: c.best,
  })));

  ipcMain.handle('resolve-clip', (_e, id) => {
    const clip = state.clips.find((c) => c.id === id);
    if (!clip) return { error: `clip not found: ${id}` };
    try { const r = resolveClip(clip); return { id, glbFile: r.glbFile, format: clip.format, name: clip.name }; }
    catch (e) { return { error: e.message }; }
  });

  // hair + beard: names up front (with a 'None' first), meshes resolved on pick
  ipcMain.handle('list-hair', () => ({
    hair: (state.hair[desc.gender] || []).map((s) => s.name),
    beard: state.beards.map((s) => s.name),
  }));

  // clothing: light list up front, assets resolved + body composited on demand
  ipcMain.handle('list-clothing', () => state.clothing.map((c) => ({
    name: c.name, kind: c.kind, isMod: c.isMod, location: c.location,
    allowTint: c.allowTint, allowHue: c.allowHue,
  })));

  ipcMain.handle('resolve-clothing', (_e, name) => {
    const item = state.clothing.find((c) => c.name === name);
    if (!item) return { error: `clothing not found: ${name}` };
    try { return resolveClothing(state.resolved.vfs, item, desc.gender); }
    catch (e) { return { error: e.message }; }
  });

  // animation-browser thumbnail disk cache (keyed by gender + glb basename, which
  // carries the source mtime, so a re-exported mod clip invalidates automatically)
  const THUMB_DIR = path.join(require('../runtime').dataDir(), 'work', 'thumbs');
  ipcMain.handle('thumb-get', (_e, key) => {
    const p = path.join(THUMB_DIR, key + '.png');
    return fs.existsSync(p) ? { file: p } : { miss: true };
  });
  ipcMain.handle('thumb-put', async (_e, { key, dataUrl }) => {
    try {
      const p = path.join(THUMB_DIR, key + '.png');
      await fs.promises.mkdir(THUMB_DIR, { recursive: true });
      await fs.promises.writeFile(p, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
      return { file: p };
    } catch (e) { return { error: e.message }; }
  });

  // held items / weapons: attach to a hand bone (Prop1/Prop2)
  ipcMain.handle('list-items', () => state.held.map((h) => ({ name: h.name, prop: h.prop })));
  ipcMain.handle('resolve-item', (_e, name) => {
    const item = state.held.find((h) => h.name === name);
    if (!item) return { error: `item not found: ${name}` };
    try { return resolveHeldItem(state.resolved.vfs, item); }
    catch (e) { return { error: e.message }; }
  });

  // rebuild the body diffuse from the skin + equipped composite layers + masks
  ipcMain.handle('compose-body', async (_e, { layers, maskFiles }) => {
    try {
      const body = resolveBody(state.resolved.vfs, desc);
      const file = await composeBody(body.skinTexture, layers || [], maskFiles || []);
      return { file };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('resolve-hair', (_e, { kind, name, hatCategory }) => {
    const source = kind === 'beard' ? state.beards : (state.hair[desc.gender] || []);
    if (!name || name === 'None') return { none: true };
    let style = source.find((s) => s.name === name);
    if (!style) return { error: `${kind} style not found: ${name}` };
    // hair tucks under a hat: swap to the style's alternate for that hat category
    if (kind === 'hair' && hatCategory && style.alternates) {
      const altName = style.alternates[String(hatCategory).toLowerCase()];
      if (altName) { const alt = source.find((s) => s.name === altName); if (alt) style = alt; }
    }
    try {
      const r = resolveStyle(state.resolved.vfs, style);
      if (!r.hasMesh) return { none: true, note: r.error || 'model-less style' };
      return { meshFile: r.meshFile, texture: r.texture, name: r.name };
    } catch (e) { return { error: e.message }; }
  });

  // export: pick an output folder, then save a still or a sprite sheet
  ipcMain.handle('choose-folder', () => {
    const r = dialog.showOpenDialogSync(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose an export folder' });
    return r && r.length ? r[0] : null;
  });
  ipcMain.handle('export-still', async (_e, { dataUrl, dir, name }) => {
    try { return { file: await saveStill(dataUrl, path.join(dir, `${name}.png`)) }; }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('export-sheet', async (_e, { frames, dir, name, cols }) => {
    try { return await saveSpriteSheet(frames, path.join(dir, `${name}_sheet.png`), cols); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('export-gif', async (_e, { frames, dir, name, duration, maxBytes, transparent, background }) => {
    try { return await saveGifAuto(frames, path.join(dir, `${name}.gif`), { duration, maxBytes, transparent, background }); }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('get-game-dir', () => gameDir || null);

  ipcMain.handle('open-icons', () => {
    const extra = ['--mod', path.resolve(modPath)];
    if (gameDir) extra.push('--game-dir', gameDir);
    const child = spawnRole('preview', extra, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  });

  ipcMain.handle('choose-game-dir', () => {
    const r = dialog.showOpenDialogSync(win, { properties: ['openDirectory'], title: 'Select your Project Zomboid install folder' });
    if (!r || !r.length) return { canceled: true };
    try { setGameDir(r[0]); } catch (e) { return { error: e.message }; }
    gameDir = r[0];
    loadState();
    let body = null, error = null;
    try { body = bodyPayload(); } catch (e) { error = e.message; }
    return { canceled: false, gameDir, body, error, clipCount: state.clips.length };
  });

  ipcMain.handle('open-mod', () => {
    const picked = promptForMod(win);
    if (!picked) return { canceled: true };
    const prev = modPath;
    modPath = picked;
    try { loadState(); }
    catch (e) { modPath = prev; loadState(); return { error: `Not a mod folder: ${e.message}` }; }
    let body = null, error = null;
    try { body = bodyPayload(); } catch (e) { error = e.message; }
    return { canceled: false, modPath, body, error, clipCount: state.clips.length, modClipCount: state.clips.filter((c) => c.isMod).length };
  });
});

app.on('window-all-closed', () => app.quit());
