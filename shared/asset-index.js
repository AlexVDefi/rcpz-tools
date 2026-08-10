// Async eager index over ordered AssetSource roots (highest priority first).
//
// Builds only the SMALL text trees the pickers need - scripts (.txt), clothingItems
// (.xml), hairstyle manifests - plus the anims_x clip NAMES (no byte reads). The big
// binary trees (models_x, textures) are never walked here; they resolve lazily through
// path-resolve.js when an asset is actually rendered. This is the eager/lazy split that
// keeps the File System Access API cold-start tractable (~2,800 small files vs ~16,000).
//
// Layering mirrors the game: a lower-numbered (earlier) source overrides a same-path
// entry in a later one, so mods win over vanilla.

import { createResolver } from './path-resolve.js';

const ANIM_EXTS = new Set(['.x', '.fbx', '.glb', '.gltf']);
const ext = (name) => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase(); };
const baseNoExt = (name) => { const i = name.lastIndexOf('.'); return i < 0 ? name : name.slice(0, i); };

/** DFS a subtree under `relRoot`, calling onFile(realRel, name) for every file. */
async function walkTree(source, relRoot, onFile) {
  const entries = await source.listDir(relRoot);
  for (const e of entries) {
    const rel = relRoot ? `${relRoot}/${e.name}` : e.name;
    if (e.kind === 'dir') await walkTree(source, rel, onFile);
    else await onFile(rel, e.name);
  }
}

/** Case-insensitively resolve the real-cased path of a subdir under a source root. */
async function realSubdir(source, relLower) {
  const segs = relLower.toLowerCase().split('/').filter(Boolean);
  let real = '';
  for (const seg of segs) {
    const entries = await source.listDir(real);
    const hit = entries.find((e) => e.name.toLowerCase() === seg && e.kind === 'dir');
    if (!hit) return null;
    real = real ? `${real}/${hit.name}` : hit.name;
  }
  return real;
}

/**
 * @param {Array<{id, isMod?, listDir, readBytes, readText, stat}>} sources ordered, highest priority first
 * @param {{ onProgress?: (msg:string)=>void }} [opts]
 */
// Read one source's raw contribution (no cross-source dedup, no sourceIndex baked in) so it can be cached
// by source id and reused when the mod set changes - only a newly-enabled source has to be read from disk.
async function scanSource(src, reportStep = () => {}) {
  const scripts = [], cloth = [], anims = []; // { rel, text } / { rel, text } / { key, rel, format, actor, clip }
  let hair = null, beard = null;              // hairstyles.xml / beardstyles.xml text (or null)

  const scriptsDir = await realSubdir(src, 'media/scripts');
  if (scriptsDir) await walkTree(src, scriptsDir, async (rel, name) => {
    if (ext(name) !== '.txt') return;
    try { scripts.push({ rel, text: await src.readText(rel) }); } catch {}
  });
  reportStep('scripts', scripts.length);

  const clothDir = await realSubdir(src, 'media/clothing/clothingItems');
  if (clothDir) await walkTree(src, clothDir, async (rel, name) => {
    if (ext(name) !== '.xml') return;
    try { cloth.push({ rel, text: await src.readText(rel) }); } catch {}
  });
  reportStep('clothing', cloth.length);

  const hd = await realSubdir(src, 'media/hairstyles');
  if (hd) {
    const entries = await src.listDir(hd);
    const h = entries.find((e) => e.name.toLowerCase() === 'hairstyles.xml');
    const b = entries.find((e) => e.name.toLowerCase() === 'beardstyles.xml');
    if (h) try { hair = await src.readText(`${hd}/${h.name}`); } catch {}
    if (b) try { beard = await src.readText(`${hd}/${b.name}`); } catch {}
  }

  const animsDir = await realSubdir(src, 'media/anims_x');
  if (animsDir) await walkTree(src, animsDir, async (rel, name) => {
    if (!ANIM_EXTS.has(ext(name))) return;
    const parts = rel.split('/');
    anims.push({ key: rel.toLowerCase(), rel, format: ext(name).slice(1), actor: parts[parts.length - 2] || '', clip: baseNoExt(name) });
  });
  reportStep('anims', anims.length);
  return { scripts, cloth, hair, beard, anims };
}

// opts.cache (optional): a Map<src.id, contribution> reused across rebuilds so toggling a mod only reads the
// newly-enabled source from disk. Sources are immutable within a session (same FSA handles / hosted bundles);
// pass a fresh cache (or clear it) to force a full re-read after files change on disk.
export async function buildAssetIndex(sources, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const cache = opts.cache || null;
  const resolver = createResolver(sources);

  // Phase 1: read every source's raw contribution. Cache hits are instant; misses scan in bounded-concurrency
  // batches so hundreds of mods don't crawl one directory at a time. Progress reports on each completion.
  const contribs = new Array(sources.length);
  let done = 0;
  const scanAt = async (si) => {
    const src = sources[si];
    let c = cache && src.id != null ? cache.get(src.id) : null;
    if (!c) { c = await scanSource(src); if (cache && src.id != null) cache.set(src.id, c); }
    contribs[si] = c;
    done++;
    onProgress({ source: done, total: sources.length, step: 'scanning', count: done, name: src.modName || (src.isMod ? src.id : 'Game install') });
  };
  const LIMIT = 8;
  for (let s = 0; s < sources.length; s += LIMIT) await Promise.all(sources.slice(s, s + LIMIT).map((_, j) => scanAt(s + j)));

  // Phase 2: combine in source order (mods first): the earliest source to define a rel wins (mod overrides vanilla).
  const scriptFiles = [];   // { rel, text, isMod, sourceIndex }
  const clothingFiles = []; // { rel, text, isMod, sourceIndex }
  const animClips = [];     // { key, actor, clip, format, rel, isMod, sourceIndex }
  const seenScript = new Set(), seenCloth = new Set(), seenAnim = new Set();
  const hairXml = [], beardXml = []; // [{ text, isMod, modName }] per source (mods first); merged + tagged in listHair
  for (let si = 0; si < sources.length; si++) {
    const src = sources[si], isMod = !!src.isMod, c = contribs[si];
    for (const s of c.scripts) { const key = s.rel.toLowerCase(); if (seenScript.has(key)) continue; seenScript.add(key); scriptFiles.push({ rel: s.rel, text: s.text, isMod, sourceIndex: si }); }
    for (const cl of c.cloth) { const key = cl.rel.toLowerCase(); if (seenCloth.has(key)) continue; seenCloth.add(key); clothingFiles.push({ rel: cl.rel, text: cl.text, isMod, sourceIndex: si }); }
    const tag = { isMod, modName: src.modName || (isMod ? src.id : null) }; // hair/beard collected from every source (mods first), never deduped here
    if (c.hair != null) hairXml.push({ text: c.hair, ...tag });
    if (c.beard != null) beardXml.push({ text: c.beard, ...tag });
    for (const a of c.anims) { if (seenAnim.has(a.key)) continue; seenAnim.add(a.key); animClips.push({ key: a.key, rel: a.rel, format: a.format, actor: a.actor, clip: a.clip, isMod, sourceIndex: si }); }
  }

  return { sources, resolver, scriptFiles, clothingFiles, hairXml, beardXml, animClips };
}
