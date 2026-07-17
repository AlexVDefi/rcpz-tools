// Browser AssetSource over a File System Access API directory handle.
//
// Exposes the SAME shape as shared/asset-source.js's Node source
// ({ id, isMod, listDir, readBytes, readText, stat }), so the parity-tested resolver
// (shared/path-resolve.js) and index builder (shared/asset-index.js) consume it unchanged.
//
// FSA getDirectoryHandle/getFileHandle are case-SENSITIVE, but callers only ever pass
// paths whose casing came from a prior listDir() (the resolver walks segment-by-segment
// and matches case-insensitively), so exact-case handle lookups always hit. A dir-handle
// cache keeps the segment walk cheap.

export interface AssetSource {
  id: string;
  isMod: boolean;
  listDir(relDir: string): Promise<Array<{ name: string; kind: 'file' | 'dir' }>>;
  readBytes(relPath: string): Promise<Uint8Array>;
  readText(relPath: string): Promise<string>;
  stat(relPath: string): Promise<{ size: number; mtimeMs: number } | null>;
}

const norm = (rel: string) => rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const split = (rel: string) => norm(rel).split('/').filter(Boolean);

export function createFsaAssetSource(
  root: FileSystemDirectoryHandle,
  opts: { id: string; isMod?: boolean },
): AssetSource {
  const dirCache = new Map<string, Promise<FileSystemDirectoryHandle | null>>();

  function dirHandle(relDir: string): Promise<FileSystemDirectoryHandle | null> {
    const key = norm(relDir);
    let p = dirCache.get(key);
    if (!p) {
      p = (async () => {
        let h: FileSystemDirectoryHandle = root;
        for (const seg of split(relDir)) {
          try { h = await h.getDirectoryHandle(seg); } catch { return null; }
        }
        return h;
      })();
      dirCache.set(key, p);
    }
    return p;
  }

  async function fileHandle(relPath: string): Promise<FileSystemFileHandle | null> {
    const segs = split(relPath);
    if (!segs.length) return null;
    const name = segs.pop()!;
    const dir = await dirHandle(segs.join('/'));
    if (!dir) return null;
    try { return await dir.getFileHandle(name); } catch { return null; }
  }

  return {
    id: opts.id,
    isMod: !!opts.isMod,
    async listDir(relDir) {
      const dir = await dirHandle(relDir);
      if (!dir) return [];
      const out: Array<{ name: string; kind: 'file' | 'dir' }> = [];
      for await (const entry of dir.values()) {
        out.push({ name: entry.name, kind: entry.kind === 'directory' ? 'dir' : 'file' });
      }
      return out;
    },
    async readBytes(relPath) {
      const fh = await fileHandle(relPath);
      if (!fh) throw new Error(`not found: ${relPath}`);
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async readText(relPath) {
      const fh = await fileHandle(relPath);
      if (!fh) throw new Error(`not found: ${relPath}`);
      return (await fh.getFile()).text();
    },
    async stat(relPath) {
      const fh = await fileHandle(relPath);
      if (!fh) return null;
      const file = await fh.getFile();
      return { size: file.size, mtimeMs: file.lastModified };
    },
  };
}
