// The shared/ domain modules are plain ESM JavaScript (parity-tested in Node). Vite
// bundles them directly; here we just declare them so TS treats their exports as untyped.
declare module '@shared/*';

// sql.js ships no types; the bits we use to read players.db.
declare module 'sql.js' {
  export interface Database {
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    close(): void;
  }
  export interface SqlJsStatic { Database: new (data?: Uint8Array) => Database }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
declare module 'sql.js/dist/sql-wasm.wasm?url' { const url: string; export default url; }

// gifenc ships no types; the bits we use.
declare module 'gifenc' {
  interface Encoder { writeFrame(index: Uint8Array, w: number, h: number, opts?: Record<string, unknown>): void; finish(): void; bytes(): Uint8Array; }
  export function GIFEncoder(): Encoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: Record<string, unknown>): number[][];
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
}

// --- File System Access API bits not always present in lib.dom, and permission methods ---
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}
interface FileSystemHandle {
  queryPermission?(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}
interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle & { kind: 'file' | 'directory'; name: string }>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle & { kind: 'file' | 'directory'; name: string }]>;
}
interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: FileSystemHandle | string;
  }): Promise<FileSystemDirectoryHandle>;
}
