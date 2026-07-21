'use strict';

// The Survivor Studio desktop app's main window: it runs the SAME web UI (character viewer,
// translations, scene menu, export, optional cloud sign-in/share) built for the desktop
// (web/dist-desktop). Native file access comes from ../preload.js, so it can open the game anywhere,
// including C:\Program Files. The icon-maker is a separate app / download.

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');

const INDEX = path.join(__dirname, '..', '..', 'web', 'dist-desktop', 'index.html');
let mainWin = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 600,
    title: 'PZ Survivor Studio',
    backgroundColor: '#1e1e22',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload needs Node's fs to expose the native file bridge; a sandboxed preload can't
      // require('fs'), so disable the sandbox (contextIsolation still isolates the page).
      sandbox: false,
      // The window only ever loads our own local build; turning off webSecurity lets it load ES
      // modules over file:// and reach the sign-in/share backend (cross-origin) without a CORS shim.
      webSecurity: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(INDEX);
  // external links (Discord, Ko-fi, Steam, share URLs) open in the OS browser, not a new window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { mainWin = null; });
  return win;
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
  ]));
}

app.whenReady().then(() => {
  ipcMain.handle('pzdesktop:pick', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWin;
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a folder' });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });
  buildMenu();
  mainWin = createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWin = createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
