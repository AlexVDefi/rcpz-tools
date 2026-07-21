// One seam over "pick a folder" + "remember a folder", so the same UI runs on the web (File System
// Access API) and in the desktop app (native fs, no blocklist). Everything else - reading the
// files, discovering mods, resolving meshes - is identical, because desktop hands back handles that
// duck-type the browser's (see native-fs.ts).
import { idbHandles } from './idb';
import { nativeBridge, nativeDirHandle, nativePathOf } from './native-fs';

export const isDesktop = nativeBridge() != null;

// True when the app can read local folders at all: always on desktop, else the FSA-capable browsers.
export const fileAccessSupported =
  isDesktop || (typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function');

// Open a folder chooser. Returns null if the user cancels (never throws for cancel). Guarded so a
// second call while a picker is already open is ignored (the FSA picker throws "already active").
let picking = false;
export async function pickDirectory(id: string): Promise<FileSystemDirectoryHandle | null> {
  if (picking) return null;
  picking = true;
  try {
    const b = nativeBridge();
    if (b) { const path = await b.pickDirectory(id); return path ? nativeDirHandle(path) : null; }
    try { return await window.showDirectoryPicker({ id, mode: 'read' }); }
    catch (e) { if ((e as Error).name === 'AbortError') return null; throw e; }
  } finally { picking = false; }
}

// Persist / restore a chosen folder. Browser handles are stored as-is (structured-cloneable); native
// handles are stored as their path and rebuilt on load (a native handle isn't cloneable).
export async function saveDir(key: string, h: FileSystemDirectoryHandle): Promise<void> {
  const p = nativePathOf(h);
  await idbHandles.save(key, (p ? { __nativePath: p, name: h.name } : h) as FileSystemDirectoryHandle);
}
export async function loadDir(key: string): Promise<FileSystemDirectoryHandle | undefined> {
  const v = (await idbHandles.load(key)) as (FileSystemDirectoryHandle & { __nativePath?: string }) | undefined;
  if (!v) return undefined;
  return v.__nativePath ? nativeDirHandle(v.__nativePath, v.name) : v;
}
