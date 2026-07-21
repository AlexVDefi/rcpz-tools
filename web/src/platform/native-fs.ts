// Desktop (Electron) file access. We expose a tiny native fs bridge on `window.pzDesktop` (see the
// Electron preload) and wrap it in objects that duck-type the browser File System Access API's
// FileSystemDirectoryHandle / FileSystemFileHandle. Because the rest of the app (fsa-source,
// mod-discovery, the resolver) only ever calls that interface, everything works unchanged - the
// only difference is these handles read straight from disk with NO blocklist, so the desktop app
// can open the game even under C:\Program Files.

export interface NativeStat { size: number; mtimeMs: number; dir: boolean }
export interface NativeBridge {
  pickDirectory(id: string): Promise<string | null>;                 // native folder dialog -> absolute path
  readDir(path: string): Promise<{ name: string; dir: boolean }[]>;  // [] if missing
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<NativeStat | null>;
}

export const nativeBridge = (): NativeBridge | null =>
  (typeof window !== 'undefined' ? (window as unknown as { pzDesktop?: NativeBridge }).pzDesktop ?? null : null);

const bridge = (): NativeBridge => {
  const b = nativeBridge();
  if (!b) throw new Error('Native file bridge unavailable');
  return b;
};

const join = (path: string, name: string) => `${path}/${name}`;
const notFound = () => new DOMException('A requested file or directory could not be found.', 'NotFoundError');

// A File System Access-style file handle backed by a native path (reads on demand).
function makeFileHandle(path: string, name: string) {
  return {
    kind: 'file' as const,
    name,
    async getFile() {
      const st = await bridge().stat(path);
      return {
        name,
        size: st?.size ?? 0,
        lastModified: st?.mtimeMs ?? 0,
        text: () => bridge().readText(path),
        async arrayBuffer() {
          const b = await bridge().readBytes(path);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        },
      };
    },
  };
}

// A File System Access-style directory handle backed by a native path. `__nativePath` marks it so
// the persistence layer can store a path instead of a (non-cloneable) handle.
function makeDirHandle(path: string, name: string) {
  const self = {
    kind: 'directory' as const,
    name,
    __nativePath: path,
    async *values() {
      for (const e of await bridge().readDir(path)) {
        yield e.dir ? makeDirHandle(join(path, e.name), e.name) : makeFileHandle(join(path, e.name), e.name);
      }
    },
    async getDirectoryHandle(childName: string) {
      const st = await bridge().stat(join(path, childName));
      if (!st || !st.dir) throw notFound();
      return makeDirHandle(join(path, childName), childName);
    },
    async getFileHandle(childName: string) {
      const st = await bridge().stat(join(path, childName));
      if (!st || st.dir) throw notFound();
      return makeFileHandle(join(path, childName), childName);
    },
    async queryPermission() { return 'granted' as PermissionState; },
    async requestPermission() { return 'granted' as PermissionState; },
  };
  return self;
}

// Public: create a directory handle (typed as the browser's, so callers are none the wiser).
export const nativeDirHandle = (path: string, name?: string): FileSystemDirectoryHandle =>
  makeDirHandle(path, name || path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path) as unknown as FileSystemDirectoryHandle;

// Read the native absolute path back off one of our handles (null for a real browser handle).
export const nativePathOf = (h: unknown): string | null =>
  (h && typeof h === 'object' && '__nativePath' in h) ? (h as { __nativePath: string }).__nativePath : null;
