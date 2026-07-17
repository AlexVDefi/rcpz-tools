// The shared/ domain modules are plain ESM JavaScript (parity-tested in Node). Vite
// bundles them directly; here we just declare them so TS treats their exports as untyped.
declare module '@shared/*';

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
