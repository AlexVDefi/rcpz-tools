// Async eager index over ordered AssetSource roots (highest priority first).
//
// Builds only the SMALL text trees the pickers need — scripts (.txt), clothingItems
// (.xml), hairstyle manifests — plus the anims_x clip NAMES (no byte reads). The big
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
export async function buildAssetIndex(sources, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const resolver = createResolver(sources);

  const scriptFiles = [];   // { rel, text, isMod, sourceIndex }
  const clothingFiles = []; // { rel, text, isMod }
  const animClips = [];     // { key, actor, clip, format, rel, isMod, sourceIndex }
  const seenScript = new Set(), seenCloth = new Set(), seenAnim = new Set();
  let hairXml = null, beardXml = null;

  for (let si = 0; si < sources.length; si++) {
    const src = sources[si];
    const isMod = !!src.isMod;

    // scripts (read text)
    const scriptsDir = await realSubdir(src, 'media/scripts');
    if (scriptsDir) await walkTree(src, scriptsDir, async (rel, name) => {
      if (ext(name) !== '.txt') return;
      const key = rel.toLowerCase();
      if (seenScript.has(key)) return; seenScript.add(key);
      try { scriptFiles.push({ rel, text: await src.readText(rel), isMod, sourceIndex: si }); } catch {}
    });
    onProgress(`scripts: ${scriptFiles.length}`);

    // clothingItems (read xml)
    const clothDir = await realSubdir(src, 'media/clothing/clothingItems');
    if (clothDir) await walkTree(src, clothDir, async (rel, name) => {
      if (ext(name) !== '.xml') return;
      const key = rel.toLowerCase();
      if (seenCloth.has(key)) return; seenCloth.add(key);
      try { clothingFiles.push({ rel, text: await src.readText(rel), isMod, sourceIndex: si }); } catch {}
    });
    onProgress(`clothing: ${clothingFiles.length}`);

    // hairstyle manifests (first source that has them wins)
    if (hairXml == null) {
      const hd = await realSubdir(src, 'media/hairstyles');
      if (hd) {
        const entries = await src.listDir(hd);
        const h = entries.find((e) => e.name.toLowerCase() === 'hairstyles.xml');
        const b = entries.find((e) => e.name.toLowerCase() === 'beardstyles.xml');
        if (h) try { hairXml = await src.readText(`${hd}/${h.name}`); } catch {}
        if (b) try { beardXml = await src.readText(`${hd}/${b.name}`); } catch {}
      }
    }

    // anims_x (names only)
    const animsDir = await realSubdir(src, 'media/anims_x');
    if (animsDir) await walkTree(src, animsDir, async (rel, name) => {
      if (!ANIM_EXTS.has(ext(name))) return;
      const key = rel.toLowerCase();
      if (seenAnim.has(key)) return; seenAnim.add(key);
      const parts = rel.split('/');
      animClips.push({
        key, rel, isMod, sourceIndex: si,
        format: ext(name).slice(1),
        actor: parts[parts.length - 2] || '',
        clip: baseNoExt(name),
      });
    });
    onProgress(`anims: ${animClips.length}`);
  }

  return { sources, resolver, scriptFiles, clothingFiles, hairXml, beardXml, animClips };
}
