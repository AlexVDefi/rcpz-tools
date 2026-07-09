'use strict';

// Electron main process for the render worker. Reads a job file, drives the
// hidden three.js window, and post-processes each returned frame with sharp
// (correct GL vertical flip, PZ horizontal mirror, nearest downscale, PNG).

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { renderIconPng } = require('../post');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const jobPath = argVal('--job');

app.whenReady().then(() => {
  if (!jobPath) { console.error('[worker] missing --job <file>'); app.exit(2); return; }
  let job;
  try { job = JSON.parse(fs.readFileSync(jobPath, 'utf8')); }
  catch (e) { console.error('[worker] bad job file:', e.message); app.exit(2); return; }

  const renders = job.renders || [];
  const byId = new Map(renders.map((r) => [r.id, r]));
  let remaining = renders.length;
  let failures = 0;

  const win = new BrowserWindow({
    show: false,
    width: 64, height: 64,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      offscreen: false,
    },
  });

  ipcMain.on('ready', () => {
    win.webContents.send('render-batch', renders);
  });

  ipcMain.on('render-result', async (_e, res) => {
    const spec = byId.get(res.id);
    if (!res.ok) {
      failures++; remaining--;
      console.error(`[worker] FAIL ${res.id}: ${res.error}`);
      if (remaining <= 0) finish();
      return;
    }
    try {
      const raw = Buffer.from(res.rgba.buffer || res.rgba);
      const outSize = spec.outSize || spec.size || res.width;
      const png = await renderIconPng(raw, res.width, res.height, {
        outSize, downscale: spec.downscale, mirror: spec.mirror !== false, padding: spec.padding,
      });
      await fs.promises.mkdir(path.dirname(spec.outPath), { recursive: true });
      await fs.promises.writeFile(spec.outPath, png);
      console.log(`[worker] OK   ${res.id} -> ${spec.outPath}`);
    } catch (e) {
      failures++;
      console.error(`[worker] post FAIL ${res.id}: ${e.message}`);
    }
    remaining--;
    if (remaining <= 0) finish();
  });

  ipcMain.on('render-done', () => { /* per-item results drive completion */ });

  function finish() {
    console.log(`[worker] done: ${renders.length - failures}/${renders.length} ok`);
    app.exit(failures ? 1 : 0);
  }

  win.loadFile(path.join(__dirname, 'render.html'));
});
