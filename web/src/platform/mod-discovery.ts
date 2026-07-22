// Discover Project Zomboid mods under a picked folder, whatever the layout:
//   - Steam workshop:   <picked>/…/content/108600/<workshopId>/mods/<modId>/…
//   - Zomboid/mods:     <picked>/<modId>/…                  (installed / local mods, children ARE mods)
//   - Zomboid/Workshop: <picked>/<project>/Contents/mods/<modId>/…  (staging; also <project>/mods/<modId>)
// A "mod" is a folder whose media lives directly (B41 flat), in versioned dirs (B42: 42, 42.13),
// and/or in common/. We return each mod's ordered media roots (highest priority first) as
// AssetSources the shared resolver/index consume directly. Case-insensitive throughout (FSA is not).
import { createFsaAssetSource, type AssetSource } from './fsa-source';

export interface DiscoveredMod {
  key: string;          // stable id (modId)
  name: string;         // from mod.info, falls back to modId
  author?: string;      // from mod.info (author), if present
  poster?: FileSystemFileHandle; // mod.info poster/icon image (or a poster.png/icon.png beside it), for a thumbnail
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

async function readModInfo(dirs: FileSystemDirectoryHandle[], fallback: string): Promise<{ name: string; author?: string; poster?: FileSystemFileHandle }> {
  for (const d of dirs) {
    const f = await childFileCI(d, 'mod.info');
    if (f) {
      try {
        const text = await (await f.getFile()).text();
        const field = (k: string) => text.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, 'mi'))?.[1]?.trim() || undefined;
        const name = field('name');
        const author = field('author'); // `poster` is an image file, not the author
        // A thumbnail: mod.info's poster/icon image (basename, beside mod.info), else a poster/icon png.
        let poster: FileSystemFileHandle | undefined;
        for (const key of ['poster', 'icon']) {
          const ref = field(key);
          if (ref) poster ||= (await childFileCI(d, ref.replace(/^.*[\\/]/, ''))) || undefined;
        }
        poster ||= (await childFileCI(d, 'poster.png')) || (await childFileCI(d, 'icon.png')) || undefined;
        if (name) return { name, author, poster };
      } catch { /* ignore */ }
    }
  }
  return { name: fallback };
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
 * Enumerate all mods under the picked folder - Steam `108600`, `Zomboid/mods`, `Zomboid/Workshop`,
 * or a parent of any of those.
 * @param onProgress optional per-mod progress callback
 */
export async function discoverWorkshopMods(picked: FileSystemDirectoryHandle, onProgress?: (n: number) => void): Promise<DiscoveredMod[]> {
  const mods: DiscoveredMod[] = [];
  const seen = new Set<string>();
  const add = async (modDir: FileSystemDirectoryHandle, wsId: string, roots: FileSystemDirectoryHandle[]) => {
    if (seen.has(modDir.name) || !roots.length) return;
    seen.add(modDir.name);
    const info = await readModInfo([...roots, modDir], modDir.name); // mod.info sits in a root OR at the mod's top level
    mods.push({ key: modDir.name, name: info.name, author: info.author, poster: info.poster, workshopId: wsId, modId: modDir.name, roots });
    onProgress?.(mods.length);
  };

  // Pull mods out of one container: children that are themselves mods (Zomboid/mods), or wrap them in
  // `mods/` (Steam <wsId>, Workshop <project>) or `Contents/mods/` (Workshop <project>).
  const scanContainer = async (container: FileSystemDirectoryHandle) => {
    for (const child of await dirsOf(container)) {
      const direct = await modRoots(child.handle);
      if (direct.length) { await add(child.handle, container.name, direct); continue; }
      const nested = [await childDirCI(child.handle, 'mods')];
      const contents = await childDirCI(child.handle, 'Contents');
      if (contents) nested.push(await childDirCI(contents, 'mods'));
      for (const modsDir of nested) {
        if (!modsDir) continue;
        for (const mod of await dirsOf(modsDir)) await add(mod.handle, child.name, await modRoots(mod.handle));
      }
    }
  };

  // The containers to scan: the pick itself, a Steam content/108600 it points at (or into), and a
  // `mods` / `workshop` child (so pointing at the Zomboid folder picks up both).
  const containers: FileSystemDirectoryHandle[] = [];
  const push = (h: FileSystemDirectoryHandle | null) => { if (h && !containers.includes(h)) containers.push(h); };
  push(picked);
  push(await findContentRoot(picked));
  push(await childDirCI(picked, 'mods'));
  push(await childDirCI(picked, 'workshop'));

  // The pick (or a mod child) might BE a single mod folder.
  const self = await modRoots(picked);
  if (self.length) await add(picked, picked.name, self);
  for (const c of containers) await scanContainer(c);

  mods.sort((a, b) => a.name.localeCompare(b.name));
  return mods;
}

/** Turn active mods (in priority order) into ordered AssetSources for buildAssetIndex. */
export function modSources(mods: DiscoveredMod[]): AssetSource[] {
  return mods.flatMap((m) => m.roots.map((h, i) => createFsaAssetSource(h, { id: `mod:${m.modId}:${i}`, isMod: true, modName: m.name })));
}
