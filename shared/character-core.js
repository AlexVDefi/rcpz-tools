// Platform-agnostic character pipeline: turn the eager AssetIndex into picker lists,
// and resolve a picked asset (body, clothing, hair, held item, animation clip) into
// LOADABLE BYTES — glb mesh bytes (via the WASM converter) and PNG texture bytes — that
// either renderer (Electron or browser) feeds straight to three's GLTFLoader.parse /
// TextureLoader. No file paths, no disk. Ports src/character/{assets,clothing,hair,items}.js
// and the relevant bits of src/resolve.js to async.
//
// ctx = { index, resolver, converter, readBytes(resolved) } where `resolver`/`converter`
// come from asset-index.js / mesh-converter.js. Callers may wrap `converter` with a
// cache (keyed by realPath+mtime) — the core stays cache-agnostic.

import { parseScriptText, walkBlocks, prop } from './script-parser.js';

// ---- constants (from character/assets.js, clothing.js, items.js) ----
const HUMAN_ACTORS = new Set(['bob', 'kate', 'zombie']);
const SKIN_TONES = {
  male: ['MaleBody01', 'MaleBody02', 'MaleBody03', 'MaleBody04', 'MaleBody05',
         'MaleBody01a', 'MaleBody02a', 'MaleBody03a', 'MaleBody04a', 'MaleBody05a'],
  female: ['FemaleBody01', 'FemaleBody02', 'FemaleBody03', 'FemaleBody04', 'FemaleBody05'],
};
const BODY_MESH = { male: 'Skinned/MaleBody', female: 'Skinned/FemaleBody' };
const PROP_BONES = new Set(['Bip01_Prop1', 'Bip01_Prop2']);
const MASK_PART = {
  0: 'Head', 1: 'Torso', 2: 'Pelvis', 3: 'LeftArm', 4: 'LeftHand', 5: 'RightArm',
  6: 'RightHand', 7: 'LeftLeg', 8: 'LeftFoot', 9: 'RightLeg', 10: 'RightFoot',
  11: 'Dress', 12: 'Chest', 13: 'Waist', 14: 'Belt', 15: 'Crotch',
};

const parseVec3 = (s) => { if (!s) return [0, 0, 0]; const p = String(s).trim().split(/\s+/).map(Number); return [p[0] || 0, p[1] || 0, p[2] || 0]; };
const stripModule = (n) => (String(n).includes('.') ? String(n).split('.').pop() : String(n));

// ---- tiny XML scalar helpers (from clothing.js / hair.js) ----
const xScalar = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
function xScalarAll(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'); const out = []; let m;
  while ((m = re.exec(xml))) { const v = m[1].trim(); if (v) out.push(v); }
  return out;
}
const xBool = (xml, tag) => xScalar(xml, tag).toLowerCase() === 'true';

// ============================ LIST (sync, from index) ============================

/** Animation clips for the browser (human actors only), mod clips first. */
export function listClips(index) {
  const clips = index.animClips
    .filter((a) => HUMAN_ACTORS.has(String(a.actor).toLowerCase()))
    .map((a) => ({
      id: a.key, name: a.clip, actor: a.actor, format: a.format, isMod: a.isMod, rel: a.rel,
      sourceIndex: a.sourceIndex,
      best: a.format === 'x' || a.format === 'glb' || a.format === 'gltf',
    }));
  clips.sort((a, b) => (b.isMod - a.isMod) || a.actor.localeCompare(b.actor) || a.name.localeCompare(b.name));
  return clips;
}

/** ClothingItem -> body location, from item scripts (BodyLocation lives in the script). */
const ITEM_BLOCK = /\bitem\s+[\w.]+\s*\{([\s\S]*?)\n\s*\}/g;
function buildClothingLocations(index) {
  const map = new Map();
  for (const f of index.scriptFiles) {
    if (!f.text.includes('ClothingItem')) continue;
    let m;
    const re = new RegExp(ITEM_BLOCK.source, 'g');
    while ((m = re.exec(f.text))) {
      const ci = m[1].match(/ClothingItem\s*=\s*([\w.]+)/);
      const bl = m[1].match(/BodyLocation\s*=\s*([\w.:]+)/);
      if (ci && bl && !map.has(ci[1])) map.set(ci[1], bl[1].split(':').pop().toLowerCase());
    }
  }
  return map;
}

function parseClothingXml(text, rel) {
  const name = rel.split('/').pop().replace(/\.xml$/i, '');
  const maleModel = xScalar(text, 'm_MaleModel');
  const femaleModel = xScalar(text, 'm_FemaleModel');
  const isStatic = xBool(text, 'm_Static');
  const kind = !maleModel && !femaleModel ? 'composite' : (isStatic ? 'static' : 'mesh');
  return {
    name, kind, maleModel, femaleModel,
    attachBone: xScalar(text, 'm_AttachBone') || null,
    masks: xScalarAll(text, 'm_Masks').map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)),
    textureChoices: xScalarAll(text, 'textureChoices'),
    baseTextures: xScalarAll(text, 'm_BaseTextures'),
    allowTint: xBool(text, 'm_AllowRandomTint'),
    allowHue: xBool(text, 'm_AllowRandomHue'),
    hatCategory: xScalar(text, 'm_HatCategory') || null,
  };
}

/** Every clothing item (light metadata), mod items first. Also stashes the parsed
 *  descriptor on each entry for resolveClothing. */
export function listClothing(index) {
  const locations = buildClothingLocations(index);
  const items = [];
  for (const f of index.clothingFiles) {
    try {
      const item = parseClothingXml(f.text, f.rel);
      item.isMod = f.isMod;
      item.location = locations.get(item.name) || 'other';
      items.push(item);
    } catch { /* skip malformed */ }
  }
  items.sort((a, b) => (b.isMod - a.isMod) || a.name.localeCompare(b.name));
  return items;
}

// hair/beard manifest parsing (from hair.js)
function hairBlocks(xml, tag) { const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'); const out = []; let m; while ((m = re.exec(xml))) out.push(m[1]); return out; }
function hairStyle(block) {
  const alternates = {}; const altRe = /<alternate\s+category="([^"]*)"\s+style="([^"]*)"\s*\/>/g; let a;
  while ((a = altRe.exec(block))) alternates[a[1].toLowerCase()] = a[2];
  return {
    name: xScalar(block, 'name'), model: xScalar(block, 'model'),
    texture: xScalar(block, 'texture') || 'F_Hair_White',
    level: parseInt(xScalar(block, 'level'), 10) || 0, alternates,
  };
}
export function listHair(index) {
  const hair = { male: [], female: [] }, beards = [];
  if (index.hairXml) {
    for (const g of ['male', 'female']) hair[g] = hairBlocks(index.hairXml, g).map(hairStyle).filter((s) => s.name);
  }
  if (index.beardXml) beards.push(...hairBlocks(index.beardXml, 'style').map(hairStyle).filter((s) => s.name));
  return { hair, beards };
}

/** Held items/weapons: models that attach to a hand bone (Prop1/Prop2). */
export function listHeldItems(index) {
  const items = new Map();
  for (const f of index.scriptFiles) {
    if (!f.text.includes('Bip01_Prop')) continue;
    let blocks; try { blocks = parseScriptText(f.text); } catch { continue; }
    walkBlocks(blocks, (b) => {
      if (b.type !== 'model' || items.has(b.name.toLowerCase())) return;
      const attachments = {}; let firstProp = null;
      for (const c of b.children) {
        if (c.type === 'attachment' && PROP_BONES.has(c.name)) {
          attachments[c.name] = { offset: parseVec3(prop(c, 'offset')), rotate: parseVec3(prop(c, 'rotate')), scale: parseFloat(prop(c, 'scale')) || 1 };
          if (!firstProp) firstProp = c.name;
        }
      }
      if (!firstProp || !prop(b, 'mesh')) return;
      items.set(b.name.toLowerCase(), { name: b.name, mesh: prop(b, 'mesh'), texture: prop(b, 'texture'), scale: parseFloat(prop(b, 'scale')) || 1, prop: firstProp, attachments });
    });
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ============================ RESOLVE (async → bytes) ============================

async function readResolved(hit) { return hit ? hit.src.readBytes(hit.realPath) : null; }

async function meshToGlb(ctx, meshName) {
  const m = await ctx.resolver.resolveMesh(meshName);
  if (!m || m.unsupported) return { error: `mesh not found: ${meshName}`, meshHit: m || null };
  const srcBytes = await readResolved(m);
  const glb = await ctx.converter.convertToGlb(srcBytes, m.format);
  return { glb, realPath: m.realPath, format: m.format };
}

/** Body mesh (glb bytes) + chosen skin texture (png bytes). */
export async function resolveBody(ctx, { gender = 'male', skin } = {}) {
  const g = gender === 'female' ? 'female' : 'male';
  const mesh = await meshToGlb(ctx, BODY_MESH[g]);
  if (mesh.error) throw new Error(`${mesh.error} (is the game folder set?)`);
  const tones = SKIN_TONES[g];
  const chosen = tones.includes(skin) ? skin : tones[0];
  const texHit = await ctx.resolver.resolveTexture(`Body/${chosen}`);
  if (!texHit) throw new Error(`skin texture not found: Body/${chosen}.png`);
  return { gender: g, skin: chosen, tones, meshGlb: mesh.glb, skinTexture: await readResolved(texHit), skinTexturePath: texHit.realPath };
}

/** Convert one clip to glb bytes on demand. */
export async function resolveClip(ctx, clip) {
  const hit = await ctx.resolver.locate(clip.rel.toLowerCase());
  if (!hit) return { error: `clip not found: ${clip.rel}` };
  const srcBytes = await readResolved(hit);
  return { id: clip.id, name: clip.name, format: clip.format, glb: await ctx.converter.convertToGlb(srcBytes, clip.format) };
}

async function resolveMasks(ctx, masks) {
  const out = [];
  for (const m of masks || []) {
    const nm = MASK_PART[m]; if (!nm) continue;
    const hit = await ctx.resolver.resolveMediaPath(`media/textures/body/masks/${nm.toLowerCase()}.png`);
    if (hit) out.push(await readResolved(hit));
  }
  return out;
}

/** Resolve one clothing item for a gender into loadable bytes. */
export async function resolveClothing(ctx, item, gender) {
  const modelName = gender === 'female' ? (item.femaleModel || item.maleModel) : (item.maleModel || item.femaleModel);
  const maskTextures = await resolveMasks(ctx, item.masks);
  const texHit = item.textureChoices.length ? await ctx.resolver.resolveTexture(item.textureChoices[0]) : null;
  const texture = texHit ? await readResolved(texHit) : null;

  if (item.kind === 'composite') {
    const baseTextures = [];
    for (const t of item.baseTextures) { const h = await ctx.resolver.resolveTexture(t); if (h) baseTextures.push(await readResolved(h)); }
    return { name: item.name, kind: 'composite', baseTextures, maskTextures, allowTint: item.allowTint, allowHue: item.allowHue };
  }
  const mesh = await meshToGlb(ctx, modelName);
  if (mesh.error) return { name: item.name, kind: item.kind, error: mesh.error, maskTextures };
  return {
    name: item.name, kind: item.kind, meshGlb: mesh.glb, texture, maskTextures,
    attachBone: item.attachBone, hatCategory: item.hatCategory, allowTint: item.allowTint, allowHue: item.allowHue,
  };
}

/** Resolve one held item's mesh + texture (falls back to mesh path for texture). */
export async function resolveHeldItem(ctx, item) {
  const mesh = await meshToGlb(ctx, item.mesh);
  if (mesh.error) return { name: item.name, error: mesh.error };
  let texHit = item.texture ? await ctx.resolver.resolveTexture(item.texture) : null;
  if (!texHit) texHit = await ctx.resolver.resolveTexture(item.mesh);
  return { name: item.name, meshGlb: mesh.glb, texture: texHit ? await readResolved(texHit) : null, prop: item.prop, attachments: item.attachments, scale: item.scale };
}

/** Resolve one hair/beard style's mesh + texture. Model-less (bald/none) -> {hasMesh:false}. */
export async function resolveHairStyle(ctx, style) {
  if (!style || !style.model) return { name: style ? style.name : 'None', hasMesh: false };
  const mesh = await meshToGlb(ctx, style.model);
  if (mesh.error) return { name: style.name, hasMesh: false, error: mesh.error };
  const texHit = await ctx.resolver.resolveTexture(style.texture);
  if (!texHit) return { name: style.name, hasMesh: false, error: `texture not found: ${style.texture}` };
  return { name: style.name, hasMesh: true, meshGlb: mesh.glb, texture: await readResolved(texHit) };
}

export { SKIN_TONES, BODY_MESH, MASK_PART, HUMAN_ACTORS };
