'use strict';

// Clothing items (main process). Parses clothingItems/*.xml, classifies each as
// meshed / static / composited, and resolves a chosen item to loadable assets.
//
//   meshed     m_MaleModel set, m_Static false -> skinned mesh on the body skeleton
//   static     m_Static true                   -> rigid mesh bone-parented to m_AttachBone
//   composite  m_MaleModel empty               -> m_BaseTextures baked onto the body atlas
//
// m_Masks are CharacterMask.Part ordinals; each hides its body-part region so bare
// skin doesn't show under the garment (see character/compose.js).

const fs = require('fs');
const path = require('path');
const { resolveMesh, resolveTexture, lookup } = require('../vfs');
const { ensureGlb } = require('../convert');

// CharacterMask.Part ordinal -> mask PNG basename in textures/Body/Masks.
const MASK_PART = {
  0: 'Head', 1: 'Torso', 2: 'Pelvis', 3: 'LeftArm', 4: 'LeftHand', 5: 'RightArm',
  6: 'RightHand', 7: 'LeftLeg', 8: 'LeftFoot', 9: 'RightLeg', 10: 'RightFoot',
  11: 'Dress', 12: 'Chest', 13: 'Waist', 14: 'Belt', 15: 'Crotch',
};

function scalar(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}
function scalarAll(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const out = []; let m;
  while ((m = re.exec(xml))) { const v = m[1].trim(); if (v) out.push(v); }
  return out;
}
function boolTag(xml, tag) { return scalar(xml, tag).toLowerCase() === 'true'; }

/** Parse one clothingItem XML into a normalised descriptor. */
function parseClothingItem(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const maleModel = scalar(xml, 'm_MaleModel');
  const femaleModel = scalar(xml, 'm_FemaleModel');
  const isStatic = boolTag(xml, 'm_Static');
  const name = path.basename(file, '.xml');
  const kind = !maleModel && !femaleModel ? 'composite' : (isStatic ? 'static' : 'mesh');
  return {
    name, kind,
    maleModel, femaleModel,
    attachBone: scalar(xml, 'm_AttachBone') || null,
    masks: scalarAll(xml, 'm_Masks').map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)),
    textureChoices: scalarAll(xml, 'textureChoices'),
    baseTextures: scalarAll(xml, 'm_BaseTextures'),
    allowTint: boolTag(xml, 'm_AllowRandomTint'),
    allowHue: boolTag(xml, 'm_AllowRandomHue'),
    hatCategory: scalar(xml, 'm_HatCategory') || null,
  };
}

// A clothing item's body location lives in its item SCRIPT (BodyLocation=), not
// its XML. Scan the indexed scripts for ClothingItem=/BodyLocation= pairs.
const ITEM_BLOCK = /\bitem\s+[\w.]+\s*\{([\s\S]*?)\n\s*\}/g;
function buildClothingLocations(vfs) {
  const map = new Map();
  const seen = new Set();
  for (const layer of vfs.layers) {
    for (const [key, file] of layer) {
      if (!key.startsWith('media/scripts/') || !key.endsWith('.txt') || seen.has(key)) continue;
      seen.add(key);
      let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (!text.includes('ClothingItem')) continue;
      let m;
      while ((m = ITEM_BLOCK.exec(text))) {
        const ci = m[1].match(/ClothingItem\s*=\s*([\w.]+)/);
        const bl = m[1].match(/BodyLocation\s*=\s*([\w.:]+)/);
        if (ci && bl && !map.has(ci[1])) map.set(ci[1], bl[1].split(':').pop().toLowerCase());
      }
    }
  }
  return map;
}

/**
 * List every clothing item across all roots, mod items marked and sorted first.
 * Light metadata only (name/kind/isMod/location) so listing 1795 items stays instant.
 */
function listClothing(vfs, modRootDirs = [], locations = new Map()) {
  const roots = modRootDirs.map((r) => String(r).replace(/\\/g, '/').toLowerCase());
  const isModFile = (f) => roots.some((r) => String(f).replace(/\\/g, '/').toLowerCase().startsWith(r));
  const seen = new Map();
  for (const layer of vfs.layers) {
    for (const [key, file] of layer) {
      if (!key.startsWith('media/clothing/clothingitems/') || !key.endsWith('.xml') || seen.has(key)) continue;
      try {
        const item = parseClothingItem(file);
        item.isMod = isModFile(file);
        item.file = file;
        item.location = locations.get(item.name) || 'other';
        seen.set(key, item);
      } catch { /* skip malformed */ }
    }
  }
  const items = [...seen.values()];
  items.sort((a, b) => (b.isMod - a.isMod) || a.name.localeCompare(b.name));
  return items;
}

/** Mask ordinals -> resolved mask PNG paths (existing files only). */
function resolveMasks(vfs, masks) {
  const out = [];
  for (const m of masks || []) {
    const nm = MASK_PART[m];
    if (!nm) continue;
    const p = lookup(vfs, `media/textures/body/masks/${nm.toLowerCase()}.png`);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Resolve one clothing item for a gender into loadable assets.
 * Returns { kind, meshFile?, texture?, attachBone?, baseTextures:[path], maskFiles:[path], ... }.
 */
function resolveClothing(vfs, item, gender) {
  const modelName = gender === 'female' ? (item.femaleModel || item.maleModel) : (item.maleModel || item.femaleModel);
  const maskFiles = resolveMasks(vfs, item.masks);
  const texture = item.textureChoices.length ? resolveTexture(vfs, item.textureChoices[0]) : null;

  if (item.kind === 'composite') {
    const baseTextures = item.baseTextures.map((t) => resolveTexture(vfs, t)).filter(Boolean);
    return { name: item.name, kind: 'composite', baseTextures, maskFiles, allowTint: item.allowTint, allowHue: item.allowHue };
  }

  const mesh = modelName ? resolveMesh(vfs, modelName) : null;
  if (!mesh || mesh.unsupported) return { name: item.name, kind: item.kind, error: `mesh not found: ${modelName}`, maskFiles };
  const glb = ensureGlb(mesh.file, mesh.format);
  return {
    name: item.name, kind: item.kind,
    meshFile: glb.file, texture, maskFiles,
    attachBone: item.attachBone, hatCategory: item.hatCategory,
    allowTint: item.allowTint, allowHue: item.allowHue,
  };
}

module.exports = { parseClothingItem, listClothing, resolveClothing, resolveMasks, buildClothingLocations, MASK_PART };
