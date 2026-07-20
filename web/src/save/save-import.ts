// Import a character's look from a Project Zomboid save. Reads players.db (SQLite) fully in
// the browser via sql.js (WASM), then hands the localPlayers.data blob to the shared parser.
// Nothing leaves the machine.
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { parsePlayerSave } from '@shared/save-parser.js';

export interface ParsedChar {
  ok: boolean;
  name?: string; // survivor name from the save
  gender?: 'male' | 'female';
  skinTexture?: number;
  skinTextureName?: string;
  bodyHair?: number;
  hair?: { model: string; color: number[] | null };
  beard?: { model: string; color: number[] | null };
  clothing?: Array<{ fullType: string; clothingItemName: string; tint: number[] | null; textureChoice: number | null; hue: number | null }>;
  warnings: string[];
}
export interface SaveEntry { mode: string; save: string; name: string; worldVersion: number; lastModified: number; dbFile: FileSystemFileHandle }

let sqlPromise: Promise<SqlJsStatic> | null = null;
const getSql = () => (sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl }));

async function openDb(dbFile: FileSystemFileHandle): Promise<Database> {
  const bytes = new Uint8Array(await (await dbFile.getFile()).arrayBuffer());
  const SQL = await getSql();
  return new SQL.Database(bytes);
}

/** Enumerate saves under a picked folder (accepts the Zomboid root or the Saves folder):
 *  <mode>/<saveName>/players.db, reading each character's name + world version. */
export async function discoverSaves(root: FileSystemDirectoryHandle): Promise<SaveEntry[]> {
  // if they picked the Zomboid root, descend into Saves
  let savesRoot = root;
  try {
    for await (const e of root.values()) if (e.kind === 'directory' && e.name.toLowerCase() === 'saves') { savesRoot = e as FileSystemDirectoryHandle; break; }
  } catch { /* use root */ }

  const out: SaveEntry[] = [];
  for await (const mode of savesRoot.values()) {
    if (mode.kind !== 'directory') continue;
    for await (const save of (mode as FileSystemDirectoryHandle).values()) {
      if (save.kind !== 'directory') continue;
      let dbFile: FileSystemFileHandle;
      try { dbFile = await (save as FileSystemDirectoryHandle).getFileHandle('players.db'); } catch { continue; }
      try {
        const file = await dbFile.getFile();
        const SQL = await getSql();
        const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
        try {
          const res = db.exec('SELECT name, worldversion FROM localPlayers LIMIT 1');
          const row = res[0]?.values?.[0];
          if (row) out.push({ mode: mode.name, save: save.name, name: String(row[0] ?? '?'), worldVersion: Number(row[1] ?? 0), lastModified: file.lastModified, dbFile });
        } finally { db.close(); }
      } catch { /* skip unreadable/locked db */ }
    }
  }
  out.sort((a, b) => b.lastModified - a.lastModified); // most-recently-played first
  return out;
}

/** Read + parse the character look from a save entry. */
export async function importCharacter(entry: SaveEntry): Promise<ParsedChar> {
  const db = await openDb(entry.dbFile);
  try {
    const res = db.exec('SELECT name, worldversion, data FROM localPlayers LIMIT 1');
    const row = res[0]?.values?.[0];
    if (!row) return { ok: false, warnings: ['no character in this save'] };
    const data = row[2] as Uint8Array;
    const name = String(row[0] ?? '');
    return { ...(parsePlayerSave(data, { name, worldVersion: Number(row[1] ?? 247) }) as ParsedChar), name };
  } finally { db.close(); }
}
