// Discover Project Zomboid workshop mods under a picked folder, over the File System
// Access API. Steam layout: <picked>/…/content/108600/<workshopId>/mods/<modId>/…, where
// each mod is either B42 (common/ + version dirs like 42, 42.13 with media/) or B41 (flat
// media/). Returns each mod's ordered media roots (highest priority first) as AssetSources
// the shared resolver/index consume directly. Case-insensitive throughout (FSA is not).
import { createFsaAssetSource, type AssetSource } from './fsa-source';

export interface DiscoveredMod {
  key: string;          // stable id (modId)
  name: string;         // from mod.info, falls back to modId
  workshopId: string;
  modId: string;
  roots: FileSystemDirectoryHandle[]; // highest priority first
}

const VERSION_DIR = /^\d+(\.\d+)*$/;

async function dirsOf(dir: FileSystemDirectoryHandle): Promise<{ name: string; handle: FileSystemDirectoryHandle }[]> {
  const out: { name: string; handle: FileSystemDirectoryHandle }[] = [];
  for await (const h of dir.values()) if (h.kind === 'directory') out.push({ name: h.name, handle: h as FileSystemDirectoryHandle });
  return out;
}
async function childDirCI(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  const want = name.toLowerCase();
  for await (const h of dir.values()) if (h.kind === 'directory' && h.name.toLowerCase() === want) return h as FileSystemDirectoryHandle;
  return null;
}
async function childFileCI(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
  const want = name.toLowerCase();
  for await (const h of dir.values()) if (h.kind === 'file' && h.name.toLowerCase() === want) return h as FileSystemFileHandle;
  return null;
}
async function hasMedia(dir: FileSystemDirectoryHandle): Promise<boolean> {
  return !!(await childDirCI(dir, 'media'));
}

function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

/** Ordered media roots for a mod dir (B42 version+common, or flat), highest priority first. */
async function modRoots(modDir: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle[]> {
  const kids = await dirsOf(modDir);
  const versions: { name: string; handle: FileSystemDirectoryHandle }[] = [];
  for (const k of kids) if (VERSION_DIR.test(k.name) && await hasMedia(k.handle)) versions.push(k);
  if (versions.length) {
    versions.sort((a, b) => compareVersions(a.name, b.name));
    const roots = [versions[versions.length - 1].handle];
    const common = await childDirCI(modDir, 'common');
    if (common && await hasMedia(common)) roots.push(common);
    return roots;
  }
  if (await hasMedia(modDir)) return [modDir];
  const common = await childDirCI(modDir, 'common');
  if (common && await hasMedia(common)) return [common];
  return [];
}

async function readModName(dirs: FileSystemDirectoryHandle[], fallback: string): Promise<string> {
  for (const d of dirs) {
    const f = await childFileCI(d, 'mod.info');
    if (f) {
      try {
        const text = await (await f.getFile()).text();
        const m = text.match(/^\s*name\s*=\s*(.+?)\s*$/mi);
        if (m && m[1]) return m[1].trim();
      } catch { /* ignore */ }
    }
  }
  return fallback;
}

/** Find the content/108600 dir from whatever the user picked (108600 itself, content,
 *  workshop, steamapps, or a Steam root). Returns the 108600 handle or null. */
async function findContentRoot(picked: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> {
  if (picked.name === '108600' || await looksLikeContent(picked)) return picked;
  const paths = [['108600'], ['content', '108600'], ['workshop', 'content', '108600'], ['steamapps', 'workshop', 'content', '108600']];
  for (const segs of paths) {
    let cur: FileSystemDirectoryHandle | null = picked;
    for (const s of segs) { cur = cur ? await childDirCI(cur, s) : null; if (!cur) break; }
    if (cur) return cur;
  }
  return null;
}
async function looksLikeContent(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const h of dir.values()) if (h.kind === 'directory' && /^\d+$/.test(h.name)) return true;
  return false;
}

/**
 * Enumerate all mods under the picked workshop folder.
 * @param onProgress optional per-mod progress callback
 */
export async function discoverWorkshopMods(picked: FileSystemDirectoryHandle, onProgress?: (n: number) => void): Promise<DiscoveredMod[]> {
  const content = await findContentRoot(picked);
  if (!content) return [];
  const mods: DiscoveredMod[] = [];
  const seen = new Set<string>();
  for (const ws of await dirsOf(content)) {
    // <wsId>/mods/<modId> and the occasional <wsId>/Contents/mods/<modId>
    const modsParents = [await childDirCI(ws.handle, 'mods')];
    const contents = await childDirCI(ws.handle, 'Contents');
    if (contents) modsParents.push(await childDirCI(contents, 'mods'));
    for (const modsDir of modsParents) {
      if (!modsDir) continue;
      for (const mod of await dirsOf(modsDir)) {
        if (seen.has(mod.name)) continue;
        const roots = await modRoots(mod.handle);
        if (!roots.length) continue;
        seen.add(mod.name);
        const name = await readModName(roots, mod.name);
        mods.push({ key: mod.name, name, workshopId: ws.name, modId: mod.name, roots });
        onProgress?.(mods.length);
      }
    }
  }
  mods.sort((a, b) => a.name.localeCompare(b.name));
  return mods;
}

/** Turn active mods (in priority order) into ordered AssetSources for buildAssetIndex. */
export function modSources(mods: DiscoveredMod[]): AssetSource[] {
  return mods.flatMap((m) => m.roots.map((h, i) => createFsaAssetSource(h, { id: `mod:${m.modId}:${i}`, isMod: true })));
}
