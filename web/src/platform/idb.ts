// Minimal IndexedDB store for persisted directory handles (and, later, cached glb bytes
// + thumbnail blobs). FileSystemDirectoryHandle is structured-cloneable, so it persists
// across reloads — but its PERMISSION does not. On return we queryPermission first and
// only requestPermission() from an explicit user gesture (the API requires one).

const DB_NAME = 'pz-icon-maker';
const DB_VERSION = 1;
const STORE_HANDLES = 'handles';
const STORE_CACHE = 'cache';

let _db: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_HANDLES)) d.createObjectStore(STORE_HANDLES);
      if (!d.objectStoreNames.contains(STORE_CACHE)) d.createObjectStore(STORE_CACHE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const idbHandles = {
  save: (key: string, handle: FileSystemDirectoryHandle) =>
    tx(STORE_HANDLES, 'readwrite', (s) => s.put(handle, key)) as Promise<unknown>,
  load: (key: string) =>
    tx<FileSystemDirectoryHandle | undefined>(STORE_HANDLES, 'readonly', (s) => s.get(key)),
  remove: (key: string) => tx(STORE_HANDLES, 'readwrite', (s) => s.delete(key)) as Promise<unknown>,
};

export const idbCache = {
  get: (key: string) => tx<unknown>(STORE_CACHE, 'readonly', (s) => s.get(key)),
  put: (key: string, value: unknown) => tx(STORE_CACHE, 'readwrite', (s) => s.put(value, key)) as Promise<unknown>,
  clear: () => tx(STORE_CACHE, 'readwrite', (s) => s.clear()) as Promise<unknown>,
};

/** Has the user granted read permission on this handle in this session? */
export async function hasPermission(handle: FileSystemHandle): Promise<boolean> {
  if (!handle.queryPermission) return true; // older impls grant implicitly
  return (await handle.queryPermission({ mode: 'read' })) === 'granted';
}

/** Request read permission — MUST be called from a user gesture (click). */
export async function requestPermission(handle: FileSystemHandle): Promise<boolean> {
  if (!handle.requestPermission) return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}
