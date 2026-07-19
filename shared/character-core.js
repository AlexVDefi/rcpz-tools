// Platform-agnostic character pipeline: turn the eager AssetIndex into picker lists,
// and resolve a picked asset (body, clothing, hair, held item, animation clip) into
// LOADABLE BYTES - glb mesh bytes (via the WASM converter) and PNG texture bytes - that
// either renderer (Electron or browser) feeds straight to three's GLTFLoader.parse /
// TextureLoader. No file paths, no disk. Ports src/character/{assets,clothing,hair,items}.js
// and the relevant bits of src/resolve.js to async.
//
// ctx = { index, resolver, converter, readBytes(resolved) } where `resolver`/`converter`
// come from asset-index.js / mesh-converter.js. Callers may wrap `converter` with a
// cache (keyed by realPath+mtime) - the core stays cache-agnostic.

import { parseScriptText, walkBlocks, prop } from './script-parser.js';

/** Human mod name for the source that provided item at `sourceIndex` (null = vanilla). */
const sourceMod = (index, sourceIndex) => index.sources?.[sourceIndex]?.modName || null;

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
      sourceIndex: a.sourceIndex, modName: sourceMod(index, a.sourceIndex),
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
      item.modName = sourceMod(index, f.sourceIndex);
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

// Weapons without their own prop attachment: PZ meshes run the barrel down local +Y, but the
// prop bone's weapon axis (what animations point the gun along, e.g. straight up in a reload) is
// +Z. rotate x=-90 maps the barrel onto that axis through partMatrix's hand-space flip; without it
// the gun lies sideways. Verified against the musket reload (barrel up-alignment 1.00).
const DEFAULT_HAND = { 'Bip01_Prop1': { offset: [0, 0, 0], rotate: [-90, 0, 0], scale: 1 } };

// Group a held item for the picker facet, from its item script's SubCategory (weapon kind:
// Firearm/Swinging/Stab/Spear) and DisplayCategory (purpose: Weapon/Tool/Cooking/Food/...).
// Firearm first (the common case people hunt for), then purpose, then coarse melee, else Other.
export const HELD_GROUP_ORDER = ['firearm', 'melee', 'spear', 'explosive', 'tool', 'cooking', 'food', 'instrument', 'misc', 'other'];
function heldGroup(sc, dc, tags) {
  const s = (sc || '').toLowerCase(), d = (dc || '').toLowerCase();
  if (s === 'firearm' || tags.includes('firearm')) return 'firearm';
  if (d.includes('explosive')) return 'explosive';
  if (s === 'spear') return 'spear';
  if (d.includes('tool')) return 'tool';
  if (d.includes('instrument')) return 'instrument';
  if (d.includes('cooking')) return 'cooking';
  if (s === 'swinging' || s === 'stab') return 'melee';
  if (d === 'food') return 'food';
  return dc ? 'misc' : 'other';
}
const cleanTags = (raw) => raw ? raw.split(';').map((t) => t.trim().replace(/^base:/i, '')).filter(Boolean) : [];
// "Apple_GroundCooked" / "BaconStrip_Hand" -> base item name, to inherit its category
const stripStateSuffix = (n) => n.replace(/_(Ground|Hand)(Cooked|Rotten|Burnt|Overdone|Stale)?$/i, '').replace(/_(Cooked|Rotten|Burnt|Overdone|Stale)$/i, '');

/** Held items/weapons: a model is "held" if it declares a hand attachment (Bip01_Prop*) OR is
 *  a weapon's equipped sprite (an item's `WeaponSprite = [module.]Model`) - most weapons never
 *  write an explicit attachment (the engine defaults them to Prop1). Floor-display models
 *  (`*_Ground`) are excluded. Each item carries a `group` (facet) + `tags` from its item script. */
export function listHeldItems(index) {
  const models = new Map();      // nameLower -> model descriptor (mesh/texture/hand attach)
  const catBySprite = new Map(); // model name (lower, from WeaponSprite) -> { sc, dc, tags }
  const catByItem = new Map();   // item name (lower) -> { sc, dc, tags }
  for (const f of index.scriptFiles) {
    if (!f.text.includes('model ') && !f.text.includes('DisplayCategory') && !f.text.includes('WeaponSprite')) continue;
    let blocks; try { blocks = parseScriptText(f.text); } catch { continue; }
    walkBlocks(blocks, (b) => {
      if (b.type === 'model' && prop(b, 'mesh') && !models.has(b.name.toLowerCase())) {
        const attachments = {}; let firstProp = null;
        for (const c of b.children) {
          if (c.type === 'attachment' && PROP_BONES.has(c.name)) {
            attachments[c.name] = { offset: parseVec3(prop(c, 'offset')), rotate: parseVec3(prop(c, 'rotate')), scale: parseFloat(prop(c, 'scale')) || 1 };
            if (!firstProp) firstProp = c.name;
          }
        }
        models.set(b.name.toLowerCase(), { name: b.name, mesh: prop(b, 'mesh'), texture: prop(b, 'texture'), scale: parseFloat(prop(b, 'scale')) || 1, attachments, handProp: firstProp, isMod: f.isMod, modName: sourceMod(index, f.sourceIndex) });
      } else if (b.type === 'item') {
        const dc = prop(b, 'DisplayCategory'), sc = prop(b, 'SubCategory');
        if (dc || sc) {
          const info = { sc, dc, tags: cleanTags(prop(b, 'Tags')) };
          catByItem.set(b.name.toLowerCase(), info);
          const ws = prop(b, 'WeaponSprite');
          if (ws) catBySprite.set(ws.split('.').pop().toLowerCase(), info);
        }
      }
    });
  }
  const out = [];
  for (const [key, m] of models) {
    if (/_Ground\w*$/i.test(m.name)) continue;            // floor-display model, not held
    const isWeapon = catBySprite.has(key);
    if (!m.handProp && !isWeapon) continue;               // not a hand item
    const info = catBySprite.get(key) || catByItem.get(key) || catByItem.get(stripStateSuffix(m.name).toLowerCase()) || { tags: [] };
    const tags = info.tags || [];
    out.push({
      name: m.name, mesh: m.mesh, texture: m.texture, scale: m.scale,
      prop: m.handProp || 'Bip01_Prop1',
      attachments: m.handProp ? m.attachments : DEFAULT_HAND,
      isMod: m.isMod, modName: m.modName,
      group: heldGroup(info.sc, info.dc, tags), tags,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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

// ============================ CLOTHING GROUPING ============================
// Collapse PZ's ~110 raw BodyLocations into a handful of focused, browsable groups.
// Primary signal: the item's BodyLocation, mapped via a curated table built from the
// game's own BodyLocations.lua (authoritative slot semantics). Fallback for modded /
// unmapped locations: the m_Masks coverage regions (mod-safe, since a garment must mask
// the skin it covers), then keywords in the item name. Order below is body top->bottom.
export const CLOTHING_GROUP_ORDER = ['head', 'torso', 'arms', 'hands', 'legs', 'feet', 'skirts', 'outfits', 'backpacks', 'accessories', 'other'];

// lowercased BodyLocation -> group
const LOCATION_GROUP = {
  // head / face
  hat: 'head', fullhat: 'head', mask: 'head', maskeyes: 'head', maskfull: 'head',
  eyes: 'head', left_eye: 'head', right_eye: 'head',
  makeup_fullface: 'head', makeup_eyes: 'head', makeup_eyesshadow: 'head', makeup_lips: 'head',
  // torso
  torso1: 'torso', tanktop: 'torso', tshirt: 'torso', shortsleeveshirt: 'torso', shirt: 'torso',
  sweater: 'torso', sweaterhat: 'torso', jacket: 'torso', jacket_down: 'torso', jacket_bulky: 'torso',
  jackethat: 'torso', jacket_hat_bulky: 'torso', jacketsuit: 'torso', jersey: 'torso', gorget: 'torso',
  cuirass: 'torso', vesttexture: 'torso', torsoextra: 'torso', torsoextravest: 'torso',
  torsoextravestbullet: 'torso', underweartop: 'torso', underwear: 'torso', fulltop: 'torso',
  neck: 'torso', scba: 'torso', scbanotank: 'torso', shoulderpadleft: 'torso', shoulderpadright: 'torso',
  sportshoulderpad: 'torso', sportshoulderpadontop: 'torso', ammostrap: 'torso',
  // arms (both underscore and bare CamelCase-lowered forms appear in the wild)
  left_arm: 'arms', right_arm: 'arms', leftarm: 'arms', rightarm: 'arms',
  forearm_left: 'arms', forearm_right: 'arms', elbow_left: 'arms', elbow_right: 'arms',
  // hands
  hands: 'hands', hands_left: 'hands', hands_right: 'hands', handsleft: 'hands', handsright: 'hands',
  // legs
  pants: 'legs', pants_skinny: 'legs', pants_extra: 'legs', shortpants: 'legs', shortsshort: 'legs',
  legs1: 'legs', codpiece: 'legs', knee_left: 'legs', knee_right: 'legs', calf_left: 'legs',
  calf_right: 'legs', calf_left_texture: 'legs', calf_right_texture: 'legs', thigh_left: 'legs',
  thigh_right: 'legs', gaiter_left: 'legs', gaiter_right: 'legs', underwearbottom: 'legs',
  underwearextra1: 'legs', underwearextra2: 'legs',
  // feet
  shoes: 'feet', socks: 'feet',
  // skirts
  skirt: 'skirts', longskirt: 'skirts',
  // full-body outfits
  fullsuit: 'outfits', fullsuithead: 'outfits', fullsuitheadscba: 'outfits', boilersuit: 'outfits',
  bodycostume: 'outfits', fullrobe: 'outfits', full_robe: 'outfits', dress: 'outfits', longdress: 'outfits',
  torso1legs1: 'outfits', bathrobe: 'outfits',
  // bags
  back: 'backpacks', satchel: 'backpacks', fannypackfront: 'backpacks', fannypackback: 'backpacks', webbing: 'backpacks',
  // accessories (jewellery, belts, small add-ons)
  belt: 'accessories', beltextra: 'accessories', leftwrist: 'accessories', rightwrist: 'accessories',
  necklace: 'accessories', necklace_long: 'accessories', neck_texture: 'accessories', scarf: 'accessories',
  ears: 'accessories', ear_top: 'accessories', nose: 'accessories', bellybutton: 'accessories',
  left_middlefinger: 'accessories', right_middlefinger: 'accessories', left_ringfinger: 'accessories',
  right_ringfinger: 'accessories', shoulder_holster: 'accessories', ankle_holster: 'accessories', tail: 'accessories',
  // non-wearable overlays
  bandage: 'other', wound: 'other', zeddmg: 'other',
};

function groupFromMasks(maskNames) {
  const has = (n) => maskNames.has(n);
  const legs = has('LeftLeg') || has('RightLeg');
  const torso = has('Torso') || has('Chest');
  if (has('Head')) return 'head';
  if (has('LeftFoot') || has('RightFoot')) return 'feet';
  if (has('LeftHand') || has('RightHand')) return 'hands';
  if (legs && torso) return 'outfits';
  if (has('Dress')) return 'skirts';
  if (legs) return 'legs';
  if (torso) return 'torso';
  return null;
}

function groupFromName(name) {
  const n = String(name).toLowerCase();
  if (/(^|_)(bag|backpack|rucksack|knapsack|satchel|duffel)/.test(n)) return 'backpacks';
  if (/(boilersuit|jumpsuit|coverall|overall|hazmat|\bdress\b|gown|\brobe\b|costume|onesie|catsuit|wetsuit|fullsuit|ghillie)/.test(n)) return 'outfits';
  if (/skirt/.test(n)) return 'skirts';
  if (/(shoe|boot|sneaker|sandal|\bsock)/.test(n)) return 'feet';
  if (/(glove|gauntlet|mitten)/.test(n)) return 'hands';
  if (/(hat|helmet|\bcap\b|mask|hood|beanie|balaclava|bandana|glasses|goggle|visor|crown|tiara|headband|earmuff)/.test(n)) return 'head';
  if (/(vambrace|bracer|armband|elbow|forearm|\bsleeve)/.test(n)) return 'arms';
  if (/(pants|trouser|jean|short|legging|\bthigh|shin|kneepad|greave|stocking|codpiece)/.test(n)) return 'legs';
  if (/(shirt|jacket|\bvest|\bcoat|sweater|hoodie|apron|armou?r|cuirass|tunic|blouse|poncho|cardigan|corset|jersey|shoulderpad|ammostrap|webbing|holster|bandolier)/.test(n)) return 'torso';
  if (/(belt|watch|necklace|\bring\b|earring|bracelet|scarf|\btie\b|pendant|choker|piercing|brooch)/.test(n)) return 'accessories';
  return null;
}

/** Map one clothing item (from listClothing) to a focused browse group. */
export function clothingGroup(item) {
  const loc = String(item.location || '').toLowerCase();
  if (LOCATION_GROUP[loc]) return LOCATION_GROUP[loc];
  const maskNames = new Set((item.masks || []).map((m) => MASK_PART[m]).filter(Boolean));
  return groupFromName(item.name) || groupFromMasks(maskNames) || 'other';
}

export { SKIN_TONES, BODY_MESH, MASK_PART, HUMAN_ACTORS };
