// Browser AssetSource over a hosted, pre-baked asset bundle (tools/bake-assets.mjs).
//
// The bundle's manifest.json is a VIRTUAL FILESYSTEM: each media/-relative path maps to
// either inline text (scripts, clothing/hair xml) or a content-hashed binary (glb meshes
// and clips, png textures). Because this exposes the exact same { id, isMod, listDir,
// readBytes, readText, stat } shape as the FSA and Node sources, the parity-tested resolver
// (path-resolve.js) and index builder (asset-index.js) consume it unchanged - one code path
// for local installs and hosted vanilla.
//
// glbs in a meshopt bundle are EXT_meshopt_compression; loaders.ts wires MeshoptDecoder so
// GLTFLoader.parse decodes them. Binary assets are content-hashed, hence immutable, so the
// browser HTTP cache is free to keep them forever.
import type { AssetSource } from './fsa-source';

type FileEntry =
  | { kind: 'text'; text: string }
  | { kind: 'bin'; hash: string; ext: string; size: number };

export interface HostedManifest {
  schema: number;
  version: string;
  assetBase: string; // e.g. "assets/"
  meshopt?: boolean;
  kind?: 'vanilla' | 'mod';
  mod?: { id: string; name: string; requires?: string[] };
  counts?: Record<string, number>;
  files: Record<string, FileEntry>;
}

const norm = (rel: string) => rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

export function createHostedAssetSource(
  manifest: HostedManifest,
  baseUrl: string,
  opts: { id?: string } = {},
): AssetSource {
  // Build a directory tree once: lowercased dir path -> Map(lowercased child name -> entry).
  // The resolver matches case-insensitively but wants the real-cased names back, so we key
  // by lowercase and store the original casing from the manifest key.
  const dirs = new Map<string, Map<string, { name: string; kind: 'file' | 'dir' }>>();
  const files = new Map<string, FileEntry>(); // lowercased full path -> entry
  const ensure = (lowerDir: string) => { let m = dirs.get(lowerDir); if (!m) { m = new Map(); dirs.set(lowerDir, m); } return m; };
  ensure('');
  for (const [key, entry] of Object.entries(manifest.files)) {
    files.set(key.toLowerCase(), entry);
    const parts = norm(key).split('/');
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      ensure(cur.toLowerCase()).set(parts[i].toLowerCase(), { name: parts[i], kind: isFile ? 'file' : 'dir' });
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      if (!isFile) ensure(cur.toLowerCase());
    }
  }

  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const assetUrl = (e: Extract<FileEntry, { kind: 'bin' }>) => `${base}${manifest.assetBase}${e.hash}.${e.ext}`;

  return {
    id: opts.id || `hosted:${manifest.version}`,
    isMod: manifest.kind === 'mod',
    modName: manifest.mod?.name,
    modId: manifest.mod?.id,
    infoId: manifest.mod?.id,
    requires: manifest.mod?.requires,
    async listDir(relDir) {
      const m = dirs.get(norm(relDir).toLowerCase());
      return m ? [...m.values()] : [];
    },
    async readText(relPath) {
      const e = files.get(norm(relPath).toLowerCase());
      if (!e) throw new Error(`not found: ${relPath}`);
      if (e.kind === 'text') return e.text;
      const res = await fetch(assetUrl(e));
      if (!res.ok) throw new Error(`fetch ${res.status}: ${relPath}`);
      return res.text();
    },
    async readBytes(relPath) {
      const e = files.get(norm(relPath).toLowerCase());
      if (!e) throw new Error(`not found: ${relPath}`);
      if (e.kind === 'text') return new TextEncoder().encode(e.text);
      const res = await fetch(assetUrl(e));
      if (!res.ok) throw new Error(`fetch ${res.status}: ${relPath}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async stat(relPath) {
      const e = files.get(norm(relPath).toLowerCase());
      if (!e) return null;
      const size = e.kind === 'text' ? new TextEncoder().encode(e.text).length : e.size;
      return { size, mtimeMs: 0 };
    },
  };
}

/** Fetch a hosted bundle's manifest.json and wrap it as an AssetSource. */
export async function loadHostedSource(baseUrl: string, opts: { id?: string } = {}): Promise<{ source: AssetSource; manifest: HostedManifest }> {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const res = await fetch(`${base}manifest.json`);
  if (!res.ok) throw new Error(`manifest fetch failed (${res.status}) at ${base}manifest.json`);
  const manifest = (await res.json()) as HostedManifest;
  return { source: createHostedAssetSource(manifest, base, opts), manifest };
}
