'use strict';

// Single entry point for the packaged app.
//
// The same binary plays several roles, chosen by argv:
//   --pzicon-worker     headless render worker (hidden window, does the GL work)
//   --pzicon-preview    the classic batch icon-maker / preview UI
//   (default)           PZ Survivor Studio - the web UI, at parity with the browser version
//
// The CLI (src/cli.js) is reached by running this binary with ELECTRON_RUN_AS_NODE=1,
// which gives a real Node process with a working stdout. It then re-spawns this same
// binary (without that variable) for the worker/preview roles. See runtime.js.

const argv = process.argv;

if (argv.includes('--pzicon-worker')) {
  require('./renderWorker/main.js');
} else if (argv.includes('--pzicon-preview')) {
  require('./previewApp/main.js');
} else {
  require('./studioApp/main.js');
}
