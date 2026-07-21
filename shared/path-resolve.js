// Case-insensitive, mod-over-vanilla asset resolution over one or more AssetSources.
//
// The game keys every asset by its LOWERCASE path relative to the dir containing
// `media/`, while files on disk are mixed-case. The File System Access API is
// case-SENSITIVE, so we can never getFile('skinned/malebody.x') directly - we must, per
// path segment, list the parent directory and match case-insensitively. This ports
// vfs.js's childCI/resolveSubdir/resolveMesh/resolveTexture semantics to async, layered
// across ordered sources (earlier source wins, i.e. a mod overrides vanilla), with a
// per-source directory-listing cache so the segment walk is cheap after warm-up.
//
// Engine mesh order: .fbx over .x; .glb accepted last (three loads it natively).
export const MESH_EXTS = ['.fbx', '.x', '.glb'];
export const ANIM_EXTS = ['.x', '.fbx', '.glb', '.gltf'];

/**
 * A layered resolver over ordered AssetSources (highest priority first).
 * @param {Array<{id:string, listDir, readBytes, readText, stat}>} sources
 */
export function createResolver(sources) {
  // cache: `${sourceId}\0${lowerDir}` -> Map(lowerName -> realName|{name,kind})
  const dirCache = new Map();

  async function dirIndex(src, realDir) {
    const key = src.id + '\0' + realDir.toLowerCase();
    let idx = dirCache.get(key);
    if (idx) return idx;
    idx = new Map();
    for (const e of await src.listDir(realDir)) idx.set(e.name.toLowerCase(), e);
    dirCache.set(key, idx);
    return idx;
  }

  /** Resolve a `/`-separated lowercase relPath to the REAL-cased path in one source, or null. */
  async function realPathIn(src, relLower) {
    const segs = relLower.split('/').filter(Boolean);
    let realDir = '';
    for (let i = 0; i < segs.length; i++) {
      const idx = await dirIndex(src, realDir);
      const hit = idx.get(segs[i]);
      if (!hit) return null;
      const last = i === segs.length - 1;
      if (!last && hit.kind !== 'dir') return null;
      realDir = realDir ? `${realDir}/${hit.name}` : hit.name;
    }
    return realDir;
  }

  /** First source (in order) that has `relLower`; returns { src, realPath } or null. */
  async function locate(relLower) {
    for (const src of sources) {
      const real = await realPathIn(src, relLower);
      if (real) return { src, realPath: real };
    }
    return null;
  }

  /** Resolve a model-script `mesh` value -> { src, realPath, format } | { unsupported } | null. */
  async function resolveMesh(meshName) {
    if (!meshName) return null;
    // Some clothing XMLs prefix the model with the `x:` namespace ("x:skinned\clothes\bob_apron");
    // it just means "under models_x", which we already prepend, so strip it (as the game does).
    const lower = String(meshName).replace(/\\/g, '/').toLowerCase()
      .replace(/^x:/, '')
      .replace(/^media\/models_x\//, '').replace(/\.(fbx|x|glb|gltf)$/, '');
    for (const ext of MESH_EXTS) {
      const hit = await locate(`media/models_x/${lower}${ext}`);
      if (hit) return { ...hit, format: ext.slice(1) };
    }
    const txt = await locate(`media/models/${lower}.txt`); // vehicle-style text mesh (three can't load)
    if (txt) return { ...txt, format: 'txt', unsupported: true };
    return null;
  }

  /** Resolve a model-script `texture` value (already-media-relative names pass through). */
  async function resolveTexture(textureName) {
    if (!textureName) return null;
    const lower = String(textureName).replace(/\\/g, '/').toLowerCase().replace(/\.png$/, '');
    const rel = lower.includes('media/') ? `${lower}.png` : `media/textures/${lower}.png`;
    return locate(rel);
  }

  /** Resolve an already-media-relative path verbatim (masks, etc.). */
  async function resolveMediaPath(mediaRel) {
    if (!mediaRel) return null;
    return locate(String(mediaRel).replace(/\\/g, '/').toLowerCase());
  }

  return { locate, realPathIn, resolveMesh, resolveTexture, resolveMediaPath, sources,
    invalidate: () => dirCache.clear() };
}
