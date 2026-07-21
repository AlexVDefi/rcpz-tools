'use strict';

// Entry point for the standalone "PZ Survivor Studio" desktop app: the web UI (character viewer,
// translations, scene menu, export, optional cloud sign-in/share) with native file access. Built
// with electron-builder-studio.json (extraMetadata.main -> this file).

require('./studioApp/main.js');
