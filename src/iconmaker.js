'use strict';

// Entry point for the standalone "PZ Icon Maker" desktop app: the classic batch item-icon renderer
// / preview UI, plus its headless render worker role (chosen by argv, e.g. when the CLI or the
// preview UI re-spawns this binary). Built with electron-builder-iconmaker.json.

const argv = process.argv;

if (argv.includes('--pzicon-worker')) {
  require('./renderWorker/main.js');
} else {
  require('./previewApp/main.js');
}
