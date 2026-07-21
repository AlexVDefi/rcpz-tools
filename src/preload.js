'use strict';

// Preload for the studio window (the web UI running inside Electron). Exposes a tiny, safe native
// file bridge as `window.pzDesktop`, which web/src/platform/native-fs.ts wraps into browser-style
// FileSystemDirectoryHandle objects. Native fs has NO File System Access blocklist, so the desktop
// app can open the game even under C:\Program Files. Runs with contextIsolation on.

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs').promises;

async function readDir(p) {
  try {
    const ents = await fs.readdir(p, { withFileTypes: true });
    // A directory junction/symlink (common in modding setups) reports as a symlink, not a directory,
    // so resolve those by following to the target - otherwise junctioned mod folders get skipped.
    return Promise.all(ents.map(async (e) => {
      let dir = e.isDirectory();
      if (!dir && e.isSymbolicLink()) { try { dir = (await fs.stat(path.join(p, e.name))).isDirectory(); } catch { /* dangling link */ } }
      return { name: e.name, dir };
    }));
  } catch { return []; } // missing dir -> empty, matching the FSA source's listDir
}

async function stat(p) {
  try { const s = await fs.stat(p); return { size: s.size, mtimeMs: s.mtimeMs, dir: s.isDirectory() }; }
  catch { return null; }
}

const readText = (p) => fs.readFile(p, 'utf8');
// return a fresh, exactly-sized Uint8Array so structured-clone across the context bridge stays cheap
const readBytes = async (p) => new Uint8Array(await fs.readFile(p));

contextBridge.exposeInMainWorld('pzDesktop', {
  pickDirectory: (id) => ipcRenderer.invoke('pzdesktop:pick', id), // native folder dialog (main process)
  readDir,
  stat,
  readText,
  readBytes,
});
