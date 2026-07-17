// Shared assimp-WASM MeshConverter for BOTH the Electron app and the web app.
//
// three.js has no .x loader, and the game's .x/.fbx meshes must become glb to load.
// Phase 0.2 verified that assimpjs (WASM) produces rig + animation data byte-identical
// to the vendored native assimp DLL (same node names, skin joints, animation tracks,
// and inverse-bind matrices), so a single WASM converter serves both platforms and the
// character retarget (anim.js retargetRestDelta, character.js normalizeClothingRig,
// renderCore.js toThreeSpace) behaves identically everywhere. This replaces the native
// koffi/DLL path in src/convert.js.
//
// Bytes-in / bytes-out (no disk): the browser has no filesystem, and callers cache the
// resulting glb bytes themselves (IndexedDB in the browser, work/converted in Node).

import assimpjsFactory from 'assimpjs';

/**
 * Strip Project Zomboid's malformed lone-';' lines from a TEXT .x file. Binary .x
 * (contains a NUL byte) and .fbx pass through untouched. Pure, in-memory (no temp file).
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Uint8Array}
 */
export function fixPzMeshBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.includes(0)) return u8; // NUL byte -> binary .x, leave as-is
  const text = new TextDecoder().decode(u8);
  const lines = text.split(/\r?\n/);
  const cleaned = lines.filter((l) => !/^\s*;\s*$/.test(l));
  if (cleaned.length === lines.length) return u8; // nothing stripped
  return new TextEncoder().encode(cleaned.join('\n'));
}

let _mod = null;
let _initPromise = null;

/** Lazily instantiate the assimpjs WASM module (one instance, shared). */
function init(opts) {
  if (_mod) return Promise.resolve(_mod);
  if (!_initPromise) {
    const factoryOpts = {};
    // Browser: point emscripten at the Vite-served .wasm URL. Node: default resolution.
    if (opts && typeof opts.locateFile === 'function') factoryOpts.locateFile = opts.locateFile;
    _initPromise = assimpjsFactory(factoryOpts).then((m) => { _mod = m; return m; });
  }
  return _initPromise;
}

// Conversions are serialized through one queue: a single WASM heap + FileList lifecycle
// must not be driven concurrently. The WASM is fast; callers cache results, so this is a
// cold-path cost only.
let _queue = Promise.resolve();

/**
 * Create a MeshConverter.
 * @param {{ locateFile?: (name:string)=>string }} [opts]  browser passes locateFile to
 *        resolve `assimpjs.wasm`; omit in Node.
 * @returns {{ ready(): Promise<void>, convertToGlb(bytes: Uint8Array|ArrayBuffer, srcFormat: string): Promise<Uint8Array> }}
 */
export function createMeshConverter(opts = {}) {
  const convertToGlb = (bytes, srcFormat) => {
    const run = async () => {
      const fmt = String(srcFormat || '').toLowerCase();
      if (fmt === 'glb' || fmt === 'gltf') {
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      }
      if (fmt !== 'x' && fmt !== 'fbx') throw new Error(`unsupported mesh format: "${srcFormat}"`);
      const ajs = await init(opts);
      const input = fmt === 'x'
        ? fixPzMeshBytes(bytes)
        : (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      const list = new ajs.FileList();
      list.AddFile(`mesh.${fmt}`, input);
      const result = ajs.ConvertFileList(list, 'glb2'); // single-binary glb, self-contained
      if (!result.IsSuccess() || result.FileCount() === 0) {
        throw new Error(`assimp convert failed (${fmt}): ${result.GetErrorCode()}`);
      }
      return new Uint8Array(result.GetFile(0).GetContent());
    };
    const p = _queue.then(run, run); // run regardless of prior outcome
    _queue = p.catch(() => {}); // a failure must not poison the chain
    return p;
  };
  return { ready: () => init(opts).then(() => undefined), convertToGlb };
}
