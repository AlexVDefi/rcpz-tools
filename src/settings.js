'use strict';

// Persisted user settings, chiefly the Project Zomboid install directory used to
// resolve vanilla assets that mods reuse (e.g. `clothes/bag/ToolBox`, `Body/Chick`).

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_FILE = path.join(os.homedir(), '.pz-icon-maker.json');

// Common Steam/GOG install locations, checked for a real `media/` dir.
const CANDIDATES = [
  'C:/Program Files (x86)/Steam/steamapps/common/ProjectZomboid',
  'C:/Program Files/Steam/steamapps/common/ProjectZomboid',
  'D:/Games/Steam/steamapps/common/ProjectZomboid',
  'D:/Steam/steamapps/common/ProjectZomboid',
  'E:/Steam/steamapps/common/ProjectZomboid',
  path.join(os.homedir(), '.steam/steam/steamapps/common/ProjectZomboid'),
  path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/ProjectZomboid'),
];

function isGameDir(p) {
  try { return !!p && fs.statSync(path.join(p, 'media')).isDirectory(); } catch { return false; }
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + '\n');
  return SETTINGS_FILE;
}

function setGameDir(dir) {
  const abs = path.resolve(dir);
  if (!isGameDir(abs)) throw new Error(`not a Project Zomboid install (no media/ dir): ${abs}`);
  const s = loadSettings();
  s.gameDir = abs;
  return { file: saveSettings(s), gameDir: abs };
}

function autodetect() {
  return CANDIDATES.filter(isGameDir).map((p) => path.resolve(p));
}

/**
 * Resolve the game dir: explicit flag > saved setting > auto-detect.
 * Auto-detect only commits when exactly one install is found; otherwise the caller
 * is told to set it. Returns { gameDir|null, source, message|null }.
 */
function resolveGameDir(explicit) {
  if (explicit) {
    const abs = path.resolve(String(explicit));
    if (!isGameDir(abs)) return { gameDir: null, source: 'flag', message: `--game-dir is not a PZ install (no media/): ${abs}` };
    return { gameDir: abs, source: 'flag', message: null };
  }
  const saved = loadSettings().gameDir;
  if (isGameDir(saved)) return { gameDir: saved, source: 'settings', message: null };

  const found = autodetect();
  if (found.length === 1) {
    return { gameDir: found[0], source: 'autodetect', message: `Using detected Project Zomboid install: ${found[0]}\n  (run \`set-game-dir <path>\` to save it, or pass --game-dir)` };
  }
  if (found.length > 1) {
    return { gameDir: null, source: 'autodetect', message: `Multiple Project Zomboid installs found:\n${found.map((f) => '    ' + f).join('\n')}\n  Pick one: \`set-game-dir <path>\` (or pass --game-dir).` };
  }
  return { gameDir: null, source: 'none', message: 'No Project Zomboid install configured. Run `set-game-dir <path>` (or pass --game-dir) so vanilla assets a mod reuses can be resolved.' };
}

module.exports = { loadSettings, saveSettings, setGameDir, autodetect, resolveGameDir, isGameDir, SETTINGS_FILE };
