// AssetSource: one platform seam for reading a single "root" directory tree (a folder
// that contains a `media/` dir — a mod version dir, common/, or the PZ install).
//
// A root's contents are addressed by a `/`-separated path RELATIVE to the root. The
// source itself may be case-SENSITIVE (the browser's File System Access API is); callers
// that need the game's case-INSENSITIVE lookup go through path-resolve.js, which walks
// each segment via listDir() and matches case-insensitively. So AssetSource stays dumb:
// list a directory, read a file, stat a file — nothing PZ-specific.
//
// Interface (all async):
//   listDir(relDir)   -> Array<{ name, kind: 'file'|'dir' }>   ([] if missing)
//   readBytes(relPath)-> Uint8Array
//   readText(relPath) -> string
//   stat(relPath)     -> { size, mtimeMs } | null
//   readonly id: string   (stable identity of the root, for cache keys)
//
// Node implementation here; the browser (FSA) implementation lives in web/.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} rootAbs absolute path to a directory that contains `media/`
 * @param {{ id?: string }} [opts]
 */
export function createNodeAssetSource(rootAbs, opts = {}) {
  const root = path.resolve(rootAbs);
  const abs = (rel) => path.join(root, rel.replace(/\\/g, '/'));
  return {
    id: opts.id || root,
    async listDir(relDir) {
      let entries;
      try { entries = await fs.promises.readdir(abs(relDir), { withFileTypes: true }); }
      catch { return []; }
      return entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }));
    },
    async readBytes(relPath) {
      const buf = await fs.promises.readFile(abs(relPath));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async readText(relPath) {
      return fs.promises.readFile(abs(relPath), 'utf8');
    },
    async stat(relPath) {
      try { const s = await fs.promises.stat(abs(relPath)); return { size: s.size, mtimeMs: s.mtimeMs }; }
      catch { return null; }
    },
  };
}
