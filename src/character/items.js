'use strict';

// Held items / weapons (main process). Scans model scripts for models that
// declare a hand attachment (attachment Bip01_Prop1 / Bip01_Prop2) and resolves
// each to a loadable mesh + texture + the hand-attachment transform. The engine
// places a held item as boneWorld(Prop) * attachment(offset, rotate, scale), the
// same maths the icon path already uses for weapon parts.

const fs = require('fs');
const { parseScriptText, walkBlocks, prop } = require('../scriptParser');
const { resolveMesh, resolveTexture } = require('../vfs');
const { parseVec3 } = require('../resolve');
const { ensureGlb } = require('../convert');

const PROP_BONES = new Set(['Bip01_Prop1', 'Bip01_Prop2']);

/** All models that attach to a hand bone, across every root (mod + game). */
function listHeldItems(vfs) {
  const seen = new Set();
  const items = new Map();
  for (const layer of vfs.layers) {
    for (const [key, file] of layer) {
      if (!key.startsWith('media/scripts/') || !key.endsWith('.txt') || seen.has(key)) continue;
      seen.add(key);
      let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (!text.includes('Bip01_Prop')) continue;
      let blocks; try { blocks = parseScriptText(text); } catch { continue; }
      walkBlocks(blocks, (b) => {
        if (b.type !== 'model' || items.has(b.name.toLowerCase())) return;
        let propName = null, att = null;
        for (const c of b.children) {
          if (c.type === 'attachment' && PROP_BONES.has(c.name)) {
            propName = c.name;
            att = { offset: parseVec3(prop(c, 'offset')), rotate: parseVec3(prop(c, 'rotate')), scale: parseFloat(prop(c, 'scale')) || 1 };
            break;
          }
        }
        if (!propName || !prop(b, 'mesh')) return;
        items.set(b.name.toLowerCase(), {
          name: b.name, mesh: prop(b, 'mesh'), texture: prop(b, 'texture'),
          scale: parseFloat(prop(b, 'scale')) || 1, prop: propName, attachment: att,
        });
      });
    }
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve one held item's mesh + texture. Falls back to the mesh path for the texture. */
function resolveHeldItem(vfs, item) {
  const mesh = resolveMesh(vfs, item.mesh);
  if (!mesh || mesh.unsupported) return { name: item.name, error: `mesh not found: ${item.mesh}` };
  const glb = ensureGlb(mesh.file, mesh.format);
  const texture = (item.texture && resolveTexture(vfs, item.texture)) || resolveTexture(vfs, item.mesh) || null;
  return {
    name: item.name, meshFile: glb.file, texture,
    prop: item.prop, attachment: item.attachment, scale: item.scale,
  };
}

module.exports = { listHeldItems, resolveHeldItem };
