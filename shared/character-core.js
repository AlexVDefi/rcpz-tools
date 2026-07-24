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

// Clothing draw/layer order, ported from PZ's BodyLocations.lua (Build 42). The list index IS the
// render layer: later in the list = drawn on top / outermost. The game keeps worn items sorted by
// this and builds BOTH the body-texture composite and the 3D-mesh list in this order, so e.g. socks
// composite under longjohns (Legs1) under shoes, under pants. Values are the lowercased, namespace-
// stripped BodyLocation ids (matching buildClothingLocations), and the enum->id map from
// ItemBodyLocation.java. Unknown/modded locations -> -1 (drawn first/underneath), like group.indexOf.
const CLOTHING_RENDER_ORDER = [
  'bandage', 'wound', 'beltextra', 'belt', 'bellybutton', 'makeup_fullface', 'makeup_eyes', 'makeup_eyesshadow',
  'makeup_lips', 'mask', 'maskeyes', 'maskfull', 'underwearbottom', 'underweartop', 'underwear', 'underwearextra1',
  'underwearextra2', 'hat', 'fullhat', 'ears', 'eartop', 'nose', 'torso1', 'torso1legs1', 'tanktop', 'tshirt',
  'shortsleeveshirt', 'leftwrist', 'rightwrist', 'shirt', 'rightarm', 'leftarm', 'neck', 'neck_texture', 'necklace',
  'necklace_long', 'right_middlefinger', 'left_middlefinger', 'left_ringfinger', 'right_ringfinger', 'hands',
  'handsleft', 'handsright', 'calf_left_texture', 'calf_right_texture', 'socks', 'legs1', 'shoes', 'codpiece',
  'shortsshort', 'shortpants', 'pants_skinny', 'gaiter_right', 'gaiter_left', 'pants', 'skirt', 'dress', 'legs5',
  'forearm_left', 'forearm_right', 'longskirt', 'longdress', 'vesttexture', 'bodycostume', 'sportshoulderpad',
  'gorget', 'jersey', 'sweater', 'sweaterhat', 'pantsextra', 'jacket', 'jacket_down', 'jacket_bulky', 'jackethat',
  'jackethat_bulky', 'jacketsuit', 'fullsuit', 'boilersuit', 'fullsuithead', 'fullsuitheadscba', 'knee_left',
  'knee_right', 'calf_left', 'calf_right', 'thigh_left', 'thigh_right', 'sportshoulderpadontop', 'shoulderpadright',
  'shoulderpadleft', 'elbow_left', 'elbow_right', 'fulltop', 'bathrobe', 'fannypackfront', 'fannypackback', 'webbing',
  'scba', 'scbanotank', 'ammostrap', 'satchel', 'shoulderholster', 'ankleholster', 'torsoextra', 'torsoextravest',
  'torsoextravestbullet', 'cuirass', 'tail', 'fullrobe', 'back', 'lefteye', 'righteye', 'eyes', 'scarf', 'zeddmg',
];
const CLOTHING_LAYER = new Map(CLOTHING_RENDER_ORDER.map((n, i) => [n, i]));
/** Draw layer (higher = on top) for a clothing BodyLocation id, matching PZ's BodyLocations order. */
export function clothingLayer(location) { const i = CLOTHING_LAYER.get(location); return i === undefined ? -1 : i; }

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
      item.layer = clothingLayer(item.location); // PZ BodyLocations draw order (higher = on top)
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
function dedupByName(styles) {
  const seen = new Set(), out = []; // keep the first occurrence of each name (mods are concatenated first)
  for (const s of styles) { const k = s.name.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(s); }
  return out;
}
export function listHair(index) {
  const hair = { male: [], female: [] }, beards = [];
  // hairXml/beardXml are per-source [{ text, isMod, modName }] (mods first). Parse each, tag every style
  // with its source (so modded hair gets a MOD badge + source filter), then dedup by name (mods win).
  const asSrcs = (v) => Array.isArray(v) ? v : (v ? [{ text: v, isMod: false, modName: null }] : []);
  const hairSrcs = asSrcs(index.hairXml), beardSrcs = asSrcs(index.beardXml);
  for (const g of ['male', 'female']) {
    const styles = [];
    for (const src of hairSrcs) for (const s of hairBlocks(src.text, g).map(hairStyle).filter((s) => s.name)) styles.push({ ...s, isMod: !!src.isMod, modName: src.modName || null });
    hair[g] = dedupByName(styles);
  }
  const bstyles = [];
  for (const src of beardSrcs) for (const s of hairBlocks(src.text, 'style').map(hairStyle).filter((s) => s.name)) bstyles.push({ ...s, isMod: !!src.isMod, modName: src.modName || null });
  beards.push(...dedupByName(bstyles));
  return { hair, beards };
}

const DEFAULT_HAND = { 'Bip01_Prop1': { offset: [0, 0, 0], rotate: [0, 0, 0], scale: 1 } };

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

// One `ModelWeaponPart = <partItem> <partModel> <attachmentNameSelf> <attachmentNameParent>` line.
// field1 is the attached part's item name, field2 the ModelScript to render, fields 3/4 the socket
// names on the part model (self) and the gun model (parent); "none"/missing -> null.
function parseModelWeaponPart(line) {
  const ss = String(line).trim().split(/\s+/);
  if (ss.length < 2) return null;
  const nz = (v) => (v && v.toLowerCase() !== 'none' ? v : null);
  return { partName: stripModule(ss[0]), modelName: stripModule(ss[1]), attachSelf: nz(ss[2]), attachParent: nz(ss[3]) };
}

/** Attachment slots a held gun model supports: its item's ModelWeaponPart lines, resolved against
 *  the gun model's sockets + each part model, grouped by PartType (falls back to the socket name).
 *  Each option carries the data the engine needs to mount the part (mesh/texture + both sockets). */
function attachmentSlots(gunModelName, models, partsBySprite, weaponParts) {
  const gun = models.get(gunModelName.toLowerCase());
  const parts = partsBySprite.get(gunModelName.toLowerCase());
  if (!gun || !parts || !parts.length) return [];
  const slots = new Map();
  for (const p of parts) {
    if (!p.attachParent) continue;
    const parentAttachment = gun.attachments[p.attachParent];
    if (!parentAttachment) continue;                    // gun model has no such socket -> not renderable
    const pm = models.get(p.modelName.toLowerCase());
    if (!pm || !pm.mesh) continue;                      // part model / mesh missing
    const selfAttachment = (p.attachSelf && pm.attachments[p.attachSelf]) || null;
    const wp = weaponParts.get(p.partName.toLowerCase());
    const slotKey = wp?.partType || p.attachParent;     // PartType is the real slot; socket is the fallback
    if (!slots.has(slotKey)) slots.set(slotKey, { slot: slotKey, options: [] });
    slots.get(slotKey).options.push({
      partName: p.partName, modelName: p.modelName, mesh: pm.mesh, texture: pm.texture || pm.mesh,
      parentAttachment, selfAttachment,
    });
  }
  return [...slots.values()];
}

/** Held items/weapons: a model is "held" if it declares a hand attachment (Bip01_Prop*) OR is
 *  a weapon's equipped sprite (an item's `WeaponSprite = [module.]Model`) - most weapons never
 *  write an explicit attachment (the engine defaults them to Prop1). Floor-display models
 *  (`*_Ground`) are excluded. Each item carries a `group` (facet) + `tags` from its item script. */
export function listHeldItems(index) {
  const models = new Map();        // nameLower -> model descriptor (mesh/texture/ALL attachment sockets)
  const catBySprite = new Map();   // model name (lower, from WeaponSprite) -> { sc, dc, tags }
  const catByItem = new Map();     // item name (lower) -> { sc, dc, tags }
  const partsBySprite = new Map(); // gun model name (lower) -> parsed ModelWeaponPart[]
  const weaponParts = new Map();   // WeaponPart item name (lower) -> { partType, mountOn[] }
  const atBySprite = new Map();    // model name (lower) -> item AttachmentType (body-attach category)
  const atByItem = new Map();      // item name (lower) -> item AttachmentType
  for (const f of index.scriptFiles) {
    if (!f.text.includes('model ') && !f.text.includes('DisplayCategory') && !f.text.includes('WeaponSprite')) continue;
    let blocks; try { blocks = parseScriptText(f.text); } catch { continue; }
    walkBlocks(blocks, (b) => {
      if (b.type === 'model' && prop(b, 'mesh') && !models.has(b.name.toLowerCase())) {
        const attachments = {}; let firstProp = null;    // capture EVERY socket (hand props + scope/canon/...)
        for (const c of b.children) {
          if (c.type !== 'attachment' || !c.name) continue;
          attachments[c.name] = { offset: parseVec3(prop(c, 'offset')), rotate: parseVec3(prop(c, 'rotate')), scale: parseFloat(prop(c, 'scale')) || 1 };
          if (PROP_BONES.has(c.name) && !firstProp) firstProp = c.name;
        }
        models.set(b.name.toLowerCase(), { name: b.name, mesh: prop(b, 'mesh'), texture: prop(b, 'texture'), scale: parseFloat(prop(b, 'scale')) || 1, attachments, handProp: firstProp, isMod: f.isMod, modName: sourceMod(index, f.sourceIndex) });
      } else if (b.type === 'item') {
        const dc = prop(b, 'DisplayCategory'), sc = prop(b, 'SubCategory');
        const ws = prop(b, 'WeaponSprite');
        if (dc || sc) {
          const info = { sc, dc, tags: cleanTags(prop(b, 'Tags')) };
          catByItem.set(b.name.toLowerCase(), info);
          if (ws) catBySprite.set(ws.split('.').pop().toLowerCase(), info);
        }
        const at = prop(b, 'AttachmentType'); // body-attach category (Rifle/Knife/Holster/...)
        if (at) { atByItem.set(b.name.toLowerCase(), at); if (ws) atBySprite.set(ws.split('.').pop().toLowerCase(), at); }
        const mwp = b.props.get('ModelWeaponPart');
        if (mwp && ws) partsBySprite.set(ws.split('.').pop().toLowerCase(), mwp.map(parseModelWeaponPart).filter(Boolean));
        const partType = prop(b, 'PartType');
        if (partType) weaponParts.set(b.name.toLowerCase(), { partType, mountOn: (prop(b, 'MountOn') || '').split(';').map((s) => stripModule(s.trim())).filter(Boolean) });
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
      allAttachments: m.attachments, // every socket on the model, incl. any body-location self-attachment
      attachmentType: atBySprite.get(key) || atByItem.get(key) || atByItem.get(stripStateSuffix(m.name).toLowerCase()) || null,
      attachSlots: attachmentSlots(m.name, models, partsBySprite, weaponParts),
      isMod: m.isMod, modName: m.modName,
      group: heldGroup(info.sc, info.dc, tags), tags,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Items that PROVIDE body-attach slots when worn (holsters/belts/webbing/bags): item name (lower) ->
 *  { provided:[slotType], replacement:'Bag'|null } from AttachmentsProvided / AttachmentReplacement. */
export function attachmentProviders(index) {
  const out = new Map();
  for (const f of index.scriptFiles) {
    if (!f.text.includes('AttachmentsProvided') && !f.text.includes('AttachmentReplacement')) continue;
    let blocks; try { blocks = parseScriptText(f.text); } catch { continue; }
    walkBlocks(blocks, (b) => {
      if (b.type !== 'item') return;
      const prov = prop(b, 'AttachmentsProvided'), repl = prop(b, 'AttachmentReplacement');
      if (!prov && !repl) return;
      out.set(b.name.toLowerCase(), {
        provided: prov ? prov.split(';').map((s) => s.trim()).filter(Boolean) : [],
        replacement: repl ? repl.trim() : null,
      });
    });
  }
  return out;
}

// ============================ RESOLVE (async → bytes) ============================

async function readResolved(hit) { return hit ? hit.src.readBytes(hit.realPath) : null; }

async function meshToGlb(ctx, meshName) {
  const m = await ctx.resolver.resolveMesh(meshName);
  if (!m || m.unsupported) return { error: `mesh not found: ${meshName}`, meshHit: m || null };
  const srcBytes = await readResolved(m);
  const glb = await ctx.converter.convertToGlb(srcBytes, m.format);
  return { glb, realPath: m.realPath, format: m.format, subMesh: m.subMesh || null };
}

/** Body mesh (glb bytes) + chosen skin texture (png bytes). `bodySource`/`textureSource` optionally
 *  pin the mesh / the skin texture to a specific source (Vanilla vs a mod), bypassing mod-over-vanilla. */
export async function resolveBody(ctx, { gender = 'male', skin, bodySource, textureSource } = {}) {
  const g = gender === 'female' ? 'female' : 'male';
  let meshGlb;
  if (bodySource && bodySource.srcRef && bodySource.realPath) {
    // A specific source's body model was picked (a body mod replaces the default, and the user chose
    // which one). Read it straight from that source instead of the mod-over-vanilla winner.
    const bytes = await bodySource.srcRef.readBytes(bodySource.realPath);
    meshGlb = await ctx.converter.convertToGlb(bytes, bodySource.format || 'fbx');
  } else {
    const mesh = await meshToGlb(ctx, BODY_MESH[g]);
    if (mesh.error) throw new Error(`${mesh.error} (is the game folder set?)`);
    meshGlb = mesh.glb;
  }
  const tones = SKIN_TONES[g];
  const chosen = tones.includes(skin) ? skin : tones[0];
  const tex = await resolveSkinTexture(ctx, chosen, textureSource);
  if (!tex) throw new Error(`skin texture not found: Body/${chosen}.png`);
  return { gender: g, skin: chosen, tones, meshGlb, skinTexture: tex.bytes, skinTexturePath: tex.realPath };
}

/** Read one Body/<tone>.png, from a specific source if `textureSource` is given (a skin-texture mod the
 *  user picked), else mod-over-vanilla. Returns { bytes, realPath } | null. */
export async function resolveSkinTexture(ctx, tone, textureSource) {
  const r = ctx.resolver;
  if (textureSource && textureSource.srcRef && r.realPathIn) {
    try {
      const real = await r.realPathIn(textureSource.srcRef, `media/textures/body/${String(tone).toLowerCase()}.png`);
      if (real) return { bytes: await textureSource.srcRef.readBytes(real), realPath: real };
    } catch { /* fall back to the default resolution */ }
  }
  const hit = await r.resolveTexture(`Body/${tone}`);
  return hit ? { bytes: await readResolved(hit), realPath: hit.realPath } : null;
}

/** Which sources provide the body model for a gender (a body mod "replaces" it: same file name, so
 *  several sources can have it). Returns [{ id, label, isMod, srcRef, realPath, format }] in priority
 *  order (mods first, then vanilla) - so [0] is the mod-over-vanilla default. Lets the UI offer a
 *  "which body" picker; each entry can be handed to resolveBody as `bodySource`. */
export async function listBodySources(ctx, gender = 'male') {
  const r = ctx && ctx.resolver;
  if (!r || !r.sources || !r.realPathIn) return [];
  const g = gender === 'female' ? 'female' : 'male';
  const base = `media/models_x/skinned/${g}body`;
  const exts = ['.fbx', '.x', '.glb'];
  const out = [];
  for (const src of r.sources) {
    for (const e of exts) {
      let real = null; try { real = await r.realPathIn(src, base + e); } catch { real = null; }
      if (real) { out.push({ id: src.id, label: src.modName || (src.isMod ? src.id : 'Vanilla'), isMod: !!src.isMod, srcRef: src, realPath: real, format: e.slice(1) }); break; }
    }
  }
  return out;
}

/** Which sources provide body SKIN textures for a gender (a skin/texture mod ships its own
 *  media/textures/Body/<tone>.png). Probes the first tone as the marker. Returns
 *  [{ id, label, isMod, srcRef }] mods-first; each entry can be handed to resolveBody/setSkin as
 *  `textureSource` to pin the skin texture to Vanilla or a specific mod. */
export async function listBodyTextureSources(ctx, gender = 'male') {
  const r = ctx && ctx.resolver;
  if (!r || !r.sources || !r.realPathIn) return [];
  const g = gender === 'female' ? 'female' : 'male';
  const probe = `media/textures/body/${SKIN_TONES[g][0].toLowerCase()}.png`;
  const out = [];
  for (const src of r.sources) {
    let real = null; try { real = await r.realPathIn(src, probe); } catch { real = null; }
    if (real) out.push({ id: src.id, label: src.modName || (src.isMod ? src.id : 'Vanilla'), isMod: !!src.isMod, srcRef: src });
  }
  return out;
}

/** Discover zombie ("Zed") body-skin textures under media/textures/Body across every source (mods
 *  included), for a gender. Returns the texture base names (e.g. 'M_ZedBody02') - setSkin/resolveBody
 *  accept them exactly like the human tones. Vanilla B42 ships one (M_ZedBody02, male); mods can add
 *  more, which is why the picker switches to a browsable modal when there are many. */
export async function listZombieSkins(ctx, gender = 'male') {
  const r = ctx && ctx.resolver;
  if (!r || !r.sources || !r.realPathIn) return [];
  const seen = new Map(); // name(lower) -> real base name, highest-priority (mod) source wins
  for (const src of r.sources) {
    let real = null; try { real = await r.realPathIn(src, 'media/textures/body'); } catch { real = null; }
    if (!real) continue;
    let entries = []; try { entries = await src.listDir(real); } catch { entries = []; }
    for (const e of entries) {
      if (e.kind !== 'file') continue;
      const m = /^(.+)\.png$/i.exec(e.name); if (!m) continue;
      const base = m[1], lower = base.toLowerCase();
      if (!/zed|zombie/.test(lower) || /dmg/.test(lower)) continue; // full zombie skins only, not the ZedDmg wound decals
      if (!seen.has(lower)) seen.set(lower, base);
    }
  }
  const g = gender === 'female' ? 'female' : 'male';
  const out = [];
  for (const base of seen.values()) {
    const which = /^m_/i.test(base) ? 'male' : /^f_/i.test(base) ? 'female' : 'both';
    if (which === 'both' || which === g) out.push(base);
  }
  return out.sort();
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
    name: item.name, kind: item.kind, meshGlb: mesh.glb, subMesh: mesh.subMesh, texture, maskTextures,
    attachBone: item.attachBone, hatCategory: item.hatCategory, allowTint: item.allowTint, allowHue: item.allowHue,
  };
}

/** Resolve one held item's mesh + texture (falls back to mesh path for texture). */
export async function resolveHeldItem(ctx, item) {
  const mesh = await meshToGlb(ctx, item.mesh);
  if (mesh.error) return { name: item.name, error: mesh.error };
  let texHit = item.texture ? await ctx.resolver.resolveTexture(item.texture) : null;
  if (!texHit) texHit = await ctx.resolver.resolveTexture(item.mesh);
  return { name: item.name, meshGlb: mesh.glb, subMesh: mesh.subMesh, texture: texHit ? await readResolved(texHit) : null, prop: item.prop, attachments: item.attachments, scale: item.scale };
}

/** Resolve one weapon-part attachment option (from an item's attachSlots) to mesh + texture bytes. */
export async function resolveAttachmentPart(ctx, option) {
  const mesh = await meshToGlb(ctx, option.mesh);
  if (mesh.error) return { error: mesh.error };
  let texHit = option.texture ? await ctx.resolver.resolveTexture(option.texture) : null;
  if (!texHit) texHit = await ctx.resolver.resolveTexture(option.mesh);
  return { meshGlb: mesh.glb, subMesh: mesh.subMesh, texture: texHit ? await readResolved(texHit) : null, parentAttachment: option.parentAttachment, selfAttachment: option.selfAttachment };
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
