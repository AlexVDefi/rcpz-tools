'use strict';

// How to re-launch ourselves for the GUI / render-worker roles.
//
// In development the CLI runs under plain Node, so it spawns the `electron`
// dev-dependency binary with a script path. In a packaged build there is no
// `electron` module and no script paths: the app binary IS the runtime, so we
// re-spawn `process.execPath` with a role flag that src/app.js dispatches on.

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** True when running from inside a packaged asar archive. */
const PACKAGED = __dirname.includes('app.asar');

const TOOL_ROOT = path.resolve(__dirname, '..');

/**
 * A writable directory for caches and scratch files. The packaged app root lives
 * inside a read-only asar archive, so it cannot be used.
 */
function dataDir() {
  return PACKAGED ? path.join(os.homedir(), '.pz-icon-maker') : TOOL_ROOT;
}

const ROLE_SCRIPT = {
  worker: ['renderWorker', 'main.js'],
  preview: ['previewApp', 'main.js'],
  character: ['characterApp', 'main.js'],
};

/**
 * Build [command, args] to run one of our roles.
 * @param {'worker'|'preview'|'character'} role
 * @param {string[]} extra role arguments
 */
function roleCommand(role, extra) {
  if (PACKAGED) {
    return [process.execPath, [`--pzicon-${role}`, ...extra]];
  }
  const electron = require('electron'); // dev: resolves to the electron binary path
  const parts = ROLE_SCRIPT[role] || ROLE_SCRIPT.preview;
  return [electron, [path.join(__dirname, ...parts), ...extra]];
}

/**
 * Spawn a role as a real Electron app. ELECTRON_RUN_AS_NODE must be stripped or
 * the binary starts as plain Node and `require('electron')` yields no app API.
 */
function spawnRole(role, extra, opts = {}) {
  const [cmd, args] = roleCommand(role, extra);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(cmd, args, { stdio: 'inherit', env, ...opts });
}

module.exports = { PACKAGED, TOOL_ROOT, dataDir, roleCommand, spawnRole };
