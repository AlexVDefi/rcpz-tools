'use strict';

// Electron main process for the interactive preview / adjust UI.
// Resolves a mod, serves the icon list + current config to the renderer, and
// handles mesh conversion, live post-processing, and saving per-item overrides.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolveMod, buildAttachmentSlots, stripModule } = require('../resolve');
const { resolveMesh, resolveTexture } = require('../vfs');
const { loadConfig, mergeItemParams } = require('../config');
const { ensureLoadable } = require('../convert');
const { renderIconPng } = require('../post');
const { resolveAttachments } = require('../attachments');
const { resolveGameDir, setGameDir } = require('../settings');
const { spawnRole } = require('../runtime');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

let modPath = argVal('--mod'); // mutable: the UI can open a different mod folder
const configPath = argVal('--config');
const startIcon = argVal('--icon');
// --game-dir > saved setting > auto-detect, so a double-clicked app still finds
// the vanilla assets that mods reuse.
let gameDir = resolveGameDir(argVal('--game-dir')).gameDir;

// Build the same icon target list the batch builder uses: deduped renderable
// records, plus config `item`/`model` overrides and synthetic (renamed) icons.
function buildTargets(cfg, resolved) {
  const { records, models, vfs } = resolved;
  const byIcon = new Map();
  const chosen = new Map();
  for (const r of records) {
    if (!r.icon) continue;
    const renderable = r.meshFile && r.textureFile;
    const cur = chosen.get(r.icon);
    if (!cur || (!(cur.meshFile && cur.textureFile) && renderable)) chosen.set(r.icon, r);
  }
  for (const r of chosen.values()) {
    if (r.meshFile && r.textureFile) {
      byIcon.set(r.icon, { icon: r.icon, meshFile: r.meshFile, meshFormat: r.meshFormat, textureFile: r.textureFile, modelName: r.modelName, rec: r });
    }
  }
  for (const [icon, over] of Object.entries(cfg.items)) {
    if (!over || (!over.model && !over.item)) continue;
    const res = resolveOverride(over, records, models, vfs);
    if (res) byIcon.set(icon, { icon, ...res });
  }
  return [...byIcon.values()].sort((a, b) => a.icon.localeCompare(b.icon));
}

function resolveOverride(over, records, models, vfs) {
  if (over.item) {
    const rec = records.find((r) => r.item.toLowerCase() === String(over.item).toLowerCase());
    if (rec && rec.meshFile && rec.textureFile) return { meshFile: rec.meshFile, meshFormat: rec.meshFormat, textureFile: rec.textureFile, modelName: rec.modelName, rec };
    return null;
  }
  if (over.model) {
    const m = models.get(stripModule(over.model).toLowerCase());
    if (!m || !m.mesh) return null;
    const mesh = resolveMesh(vfs, m.mesh);
    const textureFile = m.texture ? resolveTexture(vfs, m.texture) : null;
    if (!mesh || mesh.unsupported || !textureFile) return null;
    return { meshFile: mesh.file, meshFormat: mesh.format, textureFile, modelName: over.model };
  }
  return null;
}

let state = null; // { cfg, resolved, targets }

function loadState() {
  const cfg = loadConfig(modPath, configPath);
  const extraRoots = [...(cfg.defaults.extraRoots || []), ...(gameDir ? [gameDir] : [])];
  const resolved = resolveMod(modPath, { modelFieldPriority: cfg.defaults.modelFieldPriority, extraRoots });
  const targets = buildTargets(cfg, resolved);
  state = { cfg, resolved, targets };
  return state;
}

/** Ask the user for a mod folder (used when launched with no --mod, e.g. double-click). */
function promptForMod(parent) {
  const r = dialog.showOpenDialogSync(parent, {
    properties: ['openDirectory'],
    title: 'Select a Project Zomboid mod folder',
  });
  return r && r.length ? r[0] : null;
}

app.whenReady().then(() => {
  // Show the window first, painted in the app's own colour. Electron's default is
  // white, and the renderer needs a moment to parse three.js out of the asar, so
  // creating the window up front (with a loading overlay in index.html) is what
  // keeps the first seconds from looking like a hung white screen.
  const win = new BrowserWindow({
    width: 1320, height: 820, title: 'pz-icon-maker',
    backgroundColor: '#1e1e22',
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  // surface renderer errors on the terminal (otherwise they vanish into devtools)
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });

  const say = (msg) => { if (!win.isDestroyed()) win.webContents.send('boot-status', msg); };

  /** Ask for the mod folder (if needed), then index its assets, then let the UI boot. */
  function startup() {
    if (!modPath) {
      say('Choose a mod folder…');
      modPath = promptForMod(win);
    }
    if (!modPath) { console.error('[preview] no mod folder selected'); app.exit(2); return; }

    say(`Reading ${path.basename(modPath)}…`);
    try { loadState(); }
    catch (e) {
      if (!win.isDestroyed()) win.webContents.send('boot-error', e.message);
      dialog.showErrorBox('pz-icon-maker', `Could not read that mod folder:\n\n${e.message}`);
      app.exit(2); return;
    }
    say('Loading model…');
    if (!win.isDestroyed()) win.webContents.send('boot-ready');
  }

  // Wait for the page to paint its overlay before doing any blocking work.
  win.webContents.once('did-finish-load', () => setImmediate(startup));
  win.loadFile(path.join(__dirname, 'index.html'));

  // Optional: capture the window once the UI is ready, then quit. Used by the
  // project's own smoke tests; harmless otherwise.
  const shot = process.env.PZICON_SHOT;
  if (shot) {
    const cap = async () => {
      try { const img = await win.webContents.capturePage(); fs.writeFileSync(shot, img.toPNG()); console.log('[preview] shot ->', shot); }
      catch (e) { console.error('[preview] shot failed:', e.message); }
      app.exit(0);
    };
    ipcMain.once('ui-ready', () => setTimeout(cap, 800));
    setTimeout(() => { if (!win.isDestroyed()) cap(); }, 15000); // fallback
  }

  // --- IPC ---
  ipcMain.handle('get-game-dir', () => gameDir || null);

  // open the character viewer on the same mod, as a detached sibling process
  ipcMain.handle('open-character', () => {
    const extra = ['--mod', path.resolve(modPath)];
    if (gameDir) extra.push('--game-dir', gameDir);
    const child = spawnRole('character', extra, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  });

  /** Pick the Project Zomboid install and remember it. */
  ipcMain.handle('choose-game-dir', () => {
    const r = dialog.showOpenDialogSync(win, {
      properties: ['openDirectory'],
      title: 'Select your Project Zomboid install folder',
    });
    if (!r || !r.length) return { canceled: true };
    try { setGameDir(r[0]); }
    catch (e) { return { error: e.message }; }
    gameDir = r[0];
    loadState();
    return {
      canceled: false, gameDir,
      icons: state.targets.map((t) => ({ icon: t.icon, modelName: t.modelName })),
    };
  });

  ipcMain.handle('get-data', () => ({
    modPath, mediaDir: state.resolved.mediaDir, gameDir: gameDir || null,
    defaults: state.cfg.defaults,
    items: state.cfg.items,
    startIcon: startIcon || null,
    icons: state.targets.map((t) => ({ icon: t.icon, modelName: t.modelName })),
  }));

  // full render spec for one icon (params merged with per-item overrides)
  ipcMain.handle('get-icon', async (_e, icon) => {
    const t = state.targets.find((x) => x.icon === icon);
    if (!t) return { error: `icon not found: ${icon}` };
    let mesh;
    try { mesh = ensureLoadable(t.meshFile, t.meshFormat); }
    catch (e) { return { error: e.message }; }
    const p = mergeItemParams(state.cfg, icon);
    const { models, vfs } = state.resolved;

    // weapon attachment slots (empty for non-weapons); strip file paths for the UI
    let slots = [];
    if (t.rec && t.rec.parts && t.rec.parts.length) {
      slots = buildAttachmentSlots(t.rec, models, vfs).map((s) => ({
        slot: s.slot,
        options: s.options.map((o) => ({ partType: o.partType, available: o.available, missing: o.missing })),
      }));
    }
    return {
      icon, meshFile: mesh.meshFile, meshFormat: mesh.meshFormat, textureFile: t.textureFile,
      modelName: t.modelName, params: p, slots, attachments: p.attachments || {},
    };
  });

  // switch to a different mod folder without restarting
  ipcMain.handle('open-mod', () => {
    const picked = promptForMod(win);
    if (!picked) return { canceled: true };
    const prev = modPath;
    modPath = picked;
    try { loadState(); }
    catch (e) { modPath = prev; loadState(); return { error: `Not a mod folder: ${e.message}` }; }
    return {
      canceled: false, modPath, mediaDir: state.resolved.mediaDir,
      defaults: state.cfg.defaults, items: state.cfg.items,
      icons: state.targets.map((t) => ({ icon: t.icon, modelName: t.modelName })),
    };
  });

  // every renderable icon + whether its PNG already exists in the mod
  ipcMain.handle('build-plan', () => {
    const texDir = path.join(state.resolved.mediaDir, 'textures');
    return state.targets.map((t) => ({
      icon: t.icon,
      exists: fs.existsSync(path.join(texDir, `Item_${t.icon}.png`)),
    }));
  });

  /** Which of these output paths already exist (for the overwrite check). */
  ipcMain.handle('check-exists', (_e, paths) => paths.map((p) => fs.existsSync(p)));

  /** Pick an arbitrary output folder (for renders that are not mod icons). */
  ipcMain.handle('choose-folder', () => {
    const r = dialog.showOpenDialogSync(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose an output folder',
    });
    return r && r.length ? r[0] : null;
  });

  // resolve a { slot: partType } selection into loadable attachment specs
  ipcMain.handle('resolve-attachments', (_e, { icon, selection }) => {
    const t = state.targets.find((x) => x.icon === icon);
    if (!t || !t.rec) return { specs: [] };
    const { models, vfs } = state.resolved;
    const warnings = [];
    const specs = resolveAttachments(icon, t.rec, selection, models, vfs, (m) => warnings.push(m));
    return { specs, warnings };
  });

  ipcMain.handle('resolve-override', (_e, over) => {
    const { records, models, vfs } = state.resolved;
    const res = resolveOverride(over, records, models, vfs);
    if (!res) return { error: 'override did not resolve' };
    let mesh;
    try { mesh = ensureLoadable(res.meshFile, res.meshFormat); }
    catch (e) { return { error: e.message }; }
    return { meshFile: mesh.meshFile, meshFormat: mesh.meshFormat, textureFile: res.textureFile, modelName: res.modelName };
  });

  // raw RGBA (as array) -> final icon PNG data URL for the live 32px preview
  ipcMain.handle('post-process', async (_e, { rgba, width, height, opts }) => {
    const png = await renderIconPng(Buffer.from(rgba), width, height, opts);
    return 'data:image/png;base64,' + png.toString('base64');
  });

  // merge one icon's override into the mod's icons.config.json
  ipcMain.handle('save-config', (_e, { icon, override, alsoWritePng }) => {
    const file = path.join(path.resolve(modPath), 'icons.config.json');
    let raw = { defaults: {}, items: {}, include: [], exclude: [] };
    if (fs.existsSync(file)) { try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* keep default */ } }
    raw.items = raw.items || {};
    if (override && Object.keys(override).length) raw.items[icon] = override;
    else delete raw.items[icon];
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
    loadState(); // reflect the new override in memory
    return { file };
  });

  ipcMain.handle('write-png', async (_e, { rgba, width, height, opts, outPath }) => {
    const png = await renderIconPng(Buffer.from(rgba), width, height, opts);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, png);
    return { outPath };
  });
});

app.on('window-all-closed', () => app.quit());
