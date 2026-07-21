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
//   models_x  : item + character (Skinned/) meshes
//   models    : vehicle-style text meshes (detected, not rendered)
//   textures  : item textures, plus Body/ skins & masks and Hair/ colour maps
//   clothing  : clothingItems/*.xml + clothing decals
//   hairstyles: hairStyles/beardStyles manifests
//   anims_x   : animation clips (.x/.fbx/.glb)
//   animsets  : AnimSet definitions (not needed for direct playback, cheap to have)
// Entries are lowercase: resolveSubdir matches them against the real (mixed-case)
// dirs case-insensitively, and indexDir builds keys from this prefix verbatim, so
// a mixed-case prefix here would produce keys our lowercase lookups never match.
const INDEXED_SUBDIRS = [
  'media/models_x', 'media/models', 'media/textures',
  'media/clothing', 'media/hairstyles', 'media/anims_x', 'media/animsets',
  'media/scripts',
];

// Animation clip formats we can load: .x and .fbx via assimp, .glb natively.
const ANIM_EXTS = ['.x', '.fbx', '.glb', '.gltf'];

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
  // Most scripts give a bare name relative to media/models_x ("skinned/clothes/foo"),
  // but some clothing XMLs give a full media path with an extension
  // ("media/models_X/Skinned/Clothes/Foo.X"). Normalise both to the bare name.
  const lower = String(meshName).replace(/\\/g, '/').toLowerCase()
    .replace(/^x:/, '') // some clothing XMLs prefix the model with the models_x namespace ("x:skinned\...")
    .replace(/^media\/models_x\//, '')
    .replace(/\.(fbx|x|glb|gltf)$/, '');
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
  const lower = String(textureName).replace(/\\/g, '/').toLowerCase().replace(/\.png$/, '');
  const key = lower.includes('media/') ? `${lower}.png` : `media/textures/${lower}.png`;
  return lookup(vfs, key);
}

/** Resolve a texture that is already a full media-relative path (no extension juggling). */
function resolveMediaPath(vfs, mediaRelPath) {
  if (!mediaRelPath) return null;
  return lookup(vfs, String(mediaRelPath).replace(/\\/g, '/').toLowerCase());
}

/**
 * Enumerate animation clips under media/anims_X, respecting mod-over-vanilla
 * precedence (a mod clip shadows a same-path vanilla one). Each entry:
 *   { key, file, format, actor, clip, isMod }
 * `modRootDirs` are absolute mod root paths; a resolved file under one is marked
 * isMod so the UI can list mod clips first.
 */
function listAnims(vfs, modRootDirs = []) {
  const roots = modRootDirs.map((r) => String(r).replace(/\\/g, '/').toLowerCase());
  const isModFile = (file) => {
    const f = String(file).replace(/\\/g, '/').toLowerCase();
    return roots.some((r) => f.startsWith(r));
  };
  const seen = new Map();
  for (const layer of vfs.layers) {
    for (const [key, file] of layer) {
      if (!key.startsWith('media/anims_x/') || seen.has(key)) continue;
      const ext = path.extname(file).toLowerCase();
      if (!ANIM_EXTS.includes(ext)) continue;
      seen.set(key, {
        key, file, format: ext.slice(1),
        actor: path.basename(path.dirname(file)),
        clip: path.basename(file, path.extname(file)),
        isMod: isModFile(file),
      });
    }
  }
  return [...seen.values()];
}

module.exports = {
  buildVfs, lookup, resolveMesh, resolveTexture, resolveMediaPath, listAnims,
  MESH_EXTS, ANIM_EXTS, INDEXED_SUBDIRS,
};
