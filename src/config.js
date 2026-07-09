'use strict';

const fs = require('fs');
const path = require('path');
const { MODEL_FIELD_PRIORITY_DEFAULT } = require('./resolve');

// Global defaults. Lighting values are neutral icon defaults (brighter than the
// engine's world-dependent ambient*0.4) and are meant to be tuned at calibration.
const DEFAULTS = {
  outSize: 32,
  supersample: 8,
  downscale: 'nearest',     // 'nearest' | 'lanczos3'
  padding: 0.03,            // final frame margin after alpha-trim (0 = touch the edges)
  mirror: true,             // replicate PZ projection X-flip
  flipY: true,              // texture V flip (validation knob)
  doubleSide: true,
  modelFieldPriority: MODEL_FIELD_PRIORITY_DEFAULT,
  extraRoots: [],           // extra dirs containing media/ (searched after the mod)
  pitch: 30, yaw: 45,       // the game's isometric "icon look"
  extraYaw: 0, extraPitch: 0, extraRoll: 0,
  ambient: [0.6, 0.6, 0.6],
  keyDir: [0, -2, 5],
  keyColour: [0.5, 0.5, 0.5],
};

const PER_ITEM_KEYS = [
  'outSize', 'downscale', 'padding', 'mirror', 'flipY', 'doubleSide',
  'pitch', 'yaw', 'extraYaw', 'extraPitch', 'extraRoll',
  'ambient', 'keyDir', 'keyColour', 'scaleMul', 'model', 'item',
  'attachments',            // { "<slot>": "<partType>" } weapon parts to render attached
];

/**
 * Load icons.config.json for a mod. Search order: explicit --config path, then
 * <modPath>/icons.config.json. Missing config -> defaults only.
 */
function loadConfig(modPath, explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(String(explicitPath)));
  candidates.push(path.join(path.resolve(modPath), 'icons.config.json'));

  let raw = {};
  for (const c of candidates) {
    if (fs.existsSync(c)) { raw = JSON.parse(fs.readFileSync(c, 'utf8')); break; }
  }
  return {
    defaults: { ...DEFAULTS, ...(raw.defaults || {}) },
    items: raw.items || {},
    include: raw.include || [],
    exclude: raw.exclude || [],
  };
}

/** Merge defaults with a single item's overrides. */
function mergeItemParams(cfg, icon) {
  const over = cfg.items[icon] || {};
  const p = { ...cfg.defaults };
  for (const k of PER_ITEM_KEYS) if (k in over) p[k] = over[k];
  return p;
}

/**
 * Build a stub config object listing every renderable icon with an empty override,
 * so the user only fills in per-item tweaks (extraYaw, model, etc.).
 * @param {string[]} icons
 */
function buildStubConfig(icons) {
  const items = {};
  for (const ic of icons) items[ic] = {};
  return { defaults: { ...DEFAULTS }, items, include: [], exclude: [] };
}

module.exports = { loadConfig, mergeItemParams, buildStubConfig, DEFAULTS };
