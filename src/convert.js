'use strict';

// Convert DirectX .x meshes to .glb so three.js can load them.
//
// three has no .x loader, so we drive assimp's C API directly through koffi (no
// Python, no external tools). Project Zomboid's text .x files contain malformed
// lone-';' lines that break assimp's parser, so those are stripped first.
//
// Results are cached under work/converted/ and keyed by the source mtime.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TOOL_ROOT, dataDir } = require('./runtime');

const CACHE_DIR = path.join(dataDir(), 'work', 'converted');

// assimp postprocess flags (stable values from postprocess.h)
const AI_PROCESS_JOIN_IDENTICAL_VERTICES = 0x2;
const AI_PROCESS_TRIANGULATE = 0x8;
const AI_PROCESS_GEN_SMOOTH_NORMALS = 0x40;

const BROKEN_LINE = /^\s*;\s*$/;

let lib = null;

/** Locate the bundled assimp library (packaged builds unpack it beside the asar). */
function findAssimpDll() {
  const env = process.env.PZICON_ASSIMP_DLL;
  if (env && fs.existsSync(env)) return env;

  const names = ['assimp-vc143-mt.dll', 'libassimp.so', 'libassimp.dylib'];
  const roots = [
    path.join(TOOL_ROOT, 'vendor', 'assimp'),
    TOOL_ROOT.includes('app.asar')
      ? path.join(TOOL_ROOT.replace('app.asar', 'app.asar.unpacked'), 'vendor', 'assimp')
      : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'vendor', 'assimp') : null,
  ].filter(Boolean);

  for (const root of roots) {
    for (const n of names) {
      const p = path.join(root, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function loadAssimp() {
  if (lib) return lib;
  const dll = findAssimpDll();
  if (!dll) throw new Error('assimp library not found (expected under vendor/assimp, or set PZICON_ASSIMP_DLL)');
  const koffi = require('koffi');
  const l = koffi.load(dll);
  lib = {
    importFile: l.func('void* aiImportFile(const char* file, unsigned int flags)'),
    exportScene: l.func('int aiExportScene(void* scene, const char* fmt, const char* file, unsigned int pp)'),
    releaseImport: l.func('void aiReleaseImport(void* scene)'),
    errorString: l.func('const char* aiGetErrorString()'),
  };
  return lib;
}

/** Strip PZ's malformed lone-';' lines. Binary .x files are used as-is. */
function fixSource(src) {
  const buf = fs.readFileSync(src);
  if (buf.includes(0)) return { file: src, tmp: null }; // NUL byte -> binary .x
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  const cleaned = lines.filter((l) => !BROKEN_LINE.test(l));
  if (cleaned.length === lines.length) return { file: src, tmp: null };
  const tmp = path.join(os.tmpdir(), `pzicon_${process.pid}_${path.basename(src)}`);
  fs.writeFileSync(tmp, cleaned.join('\n'));
  return { file: tmp, tmp };
}

// assimp preserves meshes, skins and animations through a glb2 export regardless
// of these mesh-processing flags, so the same converter serves both static item
// meshes and skinned/animated character assets. The lone-';' fix in fixSource
// only rewrites malformed text .x files; binary .x and .fbx pass through untouched.
function convertViaAssimp(src, dst) {
  const a = loadAssimp();
  const { file, tmp } = fixSource(src);
  try {
    const flags = AI_PROCESS_TRIANGULATE | AI_PROCESS_JOIN_IDENTICAL_VERTICES | AI_PROCESS_GEN_SMOOTH_NORMALS;
    const scene = a.importFile(file, flags);
    if (!scene) throw new Error(`assimp import failed: ${a.errorString()}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const rc = a.exportScene(scene, 'glb2', dst, 0);
    a.releaseImport(scene);
    if (rc !== 0) throw new Error(`assimp export failed (rc=${rc}): ${a.errorString()}`);
  } finally {
    if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

/** Cached assimp conversion to glb, keyed by source path + format + mtime. */
function convertCached(src, srcFormat) {
  const abs = path.resolve(src);
  const stat = fs.statSync(abs);
  const key = `${path.basename(abs, path.extname(abs))}_${srcFormat}_${Math.round(stat.mtimeMs)}.glb`;
  const dst = path.join(CACHE_DIR, key);
  if (fs.existsSync(dst)) return dst;
  convertViaAssimp(abs, dst);
  return dst;
}

/**
 * Ensure a mesh is loadable by three.js. `.glb`/`.fbx` pass through; `.x` is
 * converted to `.glb` (cached). Returns { meshFile, meshFormat }.
 * Used by the icon path, which loads .fbx item meshes with three's FBXLoader.
 */
function ensureLoadable(meshFile, meshFormat) {
  if (meshFormat !== 'x') return { meshFile, meshFormat };
  try { return { meshFile: convertCached(meshFile, 'x'), meshFormat: 'glb' }; }
  catch (e) { throw new Error(`.x -> .glb failed for ${meshFile}: ${e.message}`); }
}

/**
 * Ensure an asset is available as glb for the character path, which loads
 * everything (body, clothing, animation clips) through three's GLTFLoader for one
 * consistent import convention. `.glb`/`.gltf` pass through; `.x` and `.fbx` are
 * converted (cached). Returns { file, format:'glb'|'gltf' }.
 */
function ensureGlb(srcFile, srcFormat) {
  const fmt = String(srcFormat).toLowerCase();
  if (fmt === 'glb' || fmt === 'gltf') return { file: srcFile, format: fmt };
  if (fmt === 'x' || fmt === 'fbx') {
    try { return { file: convertCached(srcFile, fmt), format: 'glb' }; }
    catch (e) { throw new Error(`${fmt} -> glb failed for ${srcFile}: ${e.message}`); }
  }
  throw new Error(`cannot convert to glb: unsupported format "${srcFormat}" (${srcFile})`);
}

module.exports = { ensureLoadable, ensureGlb, findAssimpDll };
