'use strict';

// Path-exact asset resolution, mirroring how the game locates assets.
//
// The game keys every asset by its LOWERCASE path relative to the dir containing
// `media/`, and overlays active mods on top of vanilla. Model scripts then look up:
//
//   mesh    -> media/models_x/<lower(mesh)>.fbx  |  .x  |  media/models/<lower(mesh)>.txt
//   texture -> media/textures/<lower(texture)>.png
//              (a name that already contains "media/" is used as-is)
//
// So a model script's `mesh = animals/Bicycle_Chicken` resolves to
// `media/models_x/animals/bicycle_chicken.fbx` -- subfolders are part of the name.
// We never match on basename, which would risk grabbing a same-named mesh from the
// wrong folder.

const fs = require('fs');
const path = require('path');

// Only these subtrees hold the assets we resolve; indexing the whole game media/
// dir would be needlessly slow.
const INDEXED_SUBDIRS = ['media/models_x', 'media/models', 'media/textures'];

// Engine order: .fbx wins over .x. .glb is not in checkMesh but the engine has a
// glTF loader and three loads it natively, so accept it last.
const MESH_EXTS = ['.fbx', '.x', '.glb'];

/** Case-insensitively find a child entry of `dir` named `name`. */
function childCI(dir, name) {
  const want = name.toLowerCase();
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const hit = entries.find((e) => e.name.toLowerCase() === want);
  return hit ? path.join(dir, hit.name) : null;
}

/** Resolve `media/models_x` style relative dirs case-insensitively under a root. */
function resolveSubdir(root, rel) {
  let cur = root;
  for (const seg of rel.split('/')) {
    cur = childCI(cur, seg);
    if (!cur) return null;
  }
  return cur;
}

function indexDir(absDir, keyPrefix, map) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    const key = keyPrefix + '/' + e.name.toLowerCase();
    if (e.isDirectory()) indexDir(abs, key, map);
    else if (!map.has(key)) map.set(key, abs);
  }
}

/**
 * Build an ordered VFS. `roots` are directories that CONTAIN a `media/` dir
 * (mod version dir, then the game install). Earlier roots win, like mod overrides.
 * @returns {{roots: string[], layers: Array<Map<string,string>>}}
 */
function buildVfs(roots) {
  const layers = [];
  const used = [];
  for (const root of roots) {
    if (!root) continue;
    const map = new Map();
    for (const sub of INDEXED_SUBDIRS) {
      const abs = resolveSubdir(root, sub);
      if (abs) indexDir(abs, sub, map);
    }
    if (map.size) { layers.push(map); used.push(root); }
  }
  return { roots: used, layers };
}

/** First layer that has the key wins (mods override vanilla). */
function lookup(vfs, key) {
  for (const layer of vfs.layers) {
    const hit = layer.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve a model script `mesh` value.
 * @returns {{file:string, format:string}|{unsupported:true, format:'txt', file:string}|null}
 */
function resolveMesh(vfs, meshName) {
  if (!meshName) return null;
  const lower = String(meshName).replace(/\\/g, '/').toLowerCase();
  for (const ext of MESH_EXTS) {
    const hit = lookup(vfs, `media/models_x/${lower}${ext}`);
    if (hit) return { file: hit, format: ext.slice(1) };
  }
  // vehicle-style custom text mesh: found, but three.js cannot load it
  const txt = lookup(vfs, `media/models/${lower}.txt`);
  if (txt) return { file: txt, format: 'txt', unsupported: true };
  return null;
}

/** Resolve a model script `texture` value (already-media-relative names pass through). */
function resolveTexture(vfs, textureName) {
  if (!textureName) return null;
  const lower = String(textureName).replace(/\\/g, '/').toLowerCase();
  const key = lower.includes('media/') ? `${lower}.png` : `media/textures/${lower}.png`;
  return lookup(vfs, key);
}

module.exports = { buildVfs, lookup, resolveMesh, resolveTexture, MESH_EXTS, INDEXED_SUBDIRS };
