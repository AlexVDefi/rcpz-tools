// Icon path, async: parse item + model scripts into records (SYNC, from the index),
// then resolve a record's mesh/texture/attachments to loadable bytes ON DEMAND (async).
// Ports src/resolve.js resolveMod + buildAttachmentSlots, split so the pickers can list
// thousands of items instantly and only pay mesh/texture I/O when one is rendered.

import { parseScriptText, walkBlocks, prop } from './script-parser.js';

export const MODEL_FIELD_PRIORITY_DEFAULT = ['WorldStaticModel', 'WeaponSprite', 'StaticModel'];

const parseVec3 = (s) => { if (!s) return [0, 0, 0]; const p = String(s).trim().split(/\s+/).map(Number); return [p[0] || 0, p[1] || 0, p[2] || 0]; };
const stripModule = (n) => (String(n).includes('.') ? String(n).split('.').pop() : String(n));

function foodVariantSuffixes(isCookable, daysFresh) {
  const hasDaysFresh = daysFresh !== undefined && daysFresh !== '' && Number.isFinite(Number(daysFresh));
  const out = [];
  if (isCookable) out.push(['cooked', 'Cooked'], ['burnt', 'Burnt']);
  if (hasDaysFresh) out.push(['rotten', 'Rotten']);
  if (isCookable && hasDaysFresh) out.push(['cookedRotten', 'CookedRotten']);
  return out;
}

function parseModelWeaponPart(line) {
  const ss = String(line).trim().split(/\s+/);
  if (ss.length < 2) return null;
  const nz = (v) => (v && v.toLowerCase() !== 'none' ? v : null);
  return { partType: ss[0], modelName: ss[1], attachSelf: nz(ss[2]), attachParent: nz(ss[3]) };
}

/**
 * SYNC parse: scripts (already in the index, priority-ordered, first-wins) -> item
 * records (mesh/texture unresolved) + model map. Mirrors resolve.js's parse loop.
 * @returns {{ records, models: Map, counts }}
 */
export function parseMod(index, opts = {}) {
  const fieldPriority = opts.modelFieldPriority || MODEL_FIELD_PRIORITY_DEFAULT;
  const items = [];
  const seenItems = new Set();
  const models = new Map(); // lower(name) -> { name, mesh, texture, scale, attachments }

  for (const f of index.scriptFiles) {
    let blocks; try { blocks = parseScriptText(f.text); } catch { continue; }
    walkBlocks(blocks, (b) => {
      if (b.type === 'item') {
        const key = b.name.toLowerCase();
        if (seenItems.has(key)) return; seenItems.add(key);
        items.push({ name: b.name, block: b });
      } else if (b.type === 'model') {
        const key = b.name.toLowerCase();
        if (models.has(key)) return;
        const attachments = {};
        for (const c of b.children) {
          if (c.type !== 'attachment') continue;
          attachments[c.name] = { offset: parseVec3(prop(c, 'offset')), rotate: parseVec3(prop(c, 'rotate')), scale: parseFloat(prop(c, 'scale')) || 1 };
        }
        models.set(key, { name: b.name, mesh: prop(b, 'mesh'), texture: prop(b, 'texture'), scale: parseFloat(prop(b, 'scale')) || 1, attachments });
      }
    });
  }

  const records = [];
  for (const it of items) {
    const icon = prop(it.block, 'Icon');
    let modelField = null, modelName = null;
    for (const ff of fieldPriority) { const v = prop(it.block, ff); if (v) { modelField = ff; modelName = v; break; } }
    if (!modelName) continue;
    const model = models.get(stripModule(modelName).toLowerCase());
    records.push({
      item: it.name, icon, baseIcon: icon, variant: 'base', modelField, modelName,
      mesh: model ? model.mesh : null, textureName: model ? model.texture : null,
      scale: model ? model.scale : 1,
      isCookable: String(prop(it.block, 'IsCookable') || '').trim().toLowerCase() === 'true',
      daysFresh: prop(it.block, 'DaysFresh'),
      parts: (it.block.props.get('ModelWeaponPart') || []).map(parseModelWeaponPart).filter(Boolean),
      hasModelBlock: !!model,
    });
  }

  // food-state variants (base icon + conventional suffix); mesh/texture resolved lazily
  const variants = [];
  for (const rec of records) {
    if (!rec.icon) continue;
    for (const [variant, suffix] of foodVariantSuffixes(rec.isCookable, rec.daysFresh)) {
      const variantModelName = rec.modelName ? `${stripModule(rec.modelName)}${suffix}` : null;
      const vm = variantModelName ? models.get(variantModelName.toLowerCase()) : null;
      variants.push({
        ...rec, icon: `${rec.icon}${suffix}`, variant, generatedVariant: true,
        modelName: vm ? vm.name : rec.modelName,
        mesh: vm ? vm.mesh : rec.mesh,
        textureName: vm ? vm.texture : (rec.textureName ? `${rec.textureName}${suffix}` : null),
        scale: vm ? vm.scale : rec.scale,
        variantTextureFallback: !vm, // when no variant model, only texture changes
      });
    }
  }
  records.push(...variants);

  return { records, models, counts: { items: items.length, models: models.size, variants: variants.length } };
}

/** Async: resolve a record's mesh (-> glb bytes) + texture (-> png bytes). */
export async function resolveIconAssets(ctx, rec) {
  const out = { item: rec.item, icon: rec.icon, meshGlb: null, texture: null, scale: rec.scale, issues: [] };
  if (!rec.icon) out.issues.push('item has no Icon field');
  if (!rec.hasModelBlock && !rec.mesh) { out.issues.push(`model block "${rec.modelName}" not found`); return out; }

  const m = rec.mesh ? await ctx.resolver.resolveMesh(rec.mesh) : null;
  if (m && !m.unsupported) out.meshGlb = await ctx.converter.convertToGlb(await m.src.readBytes(m.realPath), m.format);
  else if (m && m.unsupported) out.issues.push(`mesh "${rec.mesh}" is a ${m.format} mesh (unsupported)`);
  else if (rec.mesh) out.issues.push(`no mesh media/models_x/${String(rec.mesh).toLowerCase()}.fbx|.x`);

  const tHit = rec.textureName ? await ctx.resolver.resolveTexture(rec.textureName) : null;
  if (tHit) out.texture = await tHit.src.readBytes(tHit.realPath);
  else if (rec.textureName) out.issues.push(`no texture media/textures/${String(rec.textureName).toLowerCase()}.png`);

  return out;
}

/** Async: weapon attachment slots for a record (mirrors resolve.js buildAttachmentSlots). */
export async function buildAttachmentSlots(ctx, rec, models) {
  if (!rec || !rec.parts || !rec.parts.length || !rec.modelName) return [];
  const parent = models.get(stripModule(rec.modelName).toLowerCase());
  if (!parent) return [];
  const slots = new Map();
  for (const p of rec.parts) {
    if (!p.attachParent) continue;
    const parentAttachment = parent.attachments[p.attachParent] || null;
    const m = models.get(stripModule(p.modelName).toLowerCase());
    const meshHit = m && m.mesh ? await ctx.resolver.resolveMesh(m.mesh) : null;
    const okMesh = meshHit && !meshHit.unsupported;
    const texHit = m && m.texture ? await ctx.resolver.resolveTexture(m.texture) : null;
    const selfAttachment = m && p.attachSelf ? (m.attachments[p.attachSelf] || null) : null;
    const missing = [];
    if (!parentAttachment) missing.push(`parent has no attachment "${p.attachParent}"`);
    if (!m) missing.push(`model "${p.modelName}" not found`);
    else { if (meshHit && meshHit.unsupported) missing.push(`mesh is a ${meshHit.format} mesh (unsupported)`); else if (!okMesh) missing.push(`no mesh for ${m.mesh}`); if (!texHit) missing.push(`no texture for ${m.texture}`); }
    const option = {
      partType: stripModule(p.partType), modelName: stripModule(p.modelName), attachSelf: p.attachSelf, selfAttachment,
      meshHit: okMesh ? meshHit : null, meshFormat: okMesh ? meshHit.format : null, texHit,
      available: missing.length === 0, missing,
    };
    if (!slots.has(p.attachParent)) slots.set(p.attachParent, { slot: p.attachParent, parentAttachment, options: [] });
    slots.get(p.attachParent).options.push(option);
  }
  return [...slots.values()];
}

export { parseModelWeaponPart, foodVariantSuffixes, stripModule, parseVec3 };
