'use strict';

// Shared: turn a config `attachments` selection into render-job attachment specs.
// Used by both the batch CLI and the interactive preview.

const { buildAttachmentSlots } = require('./resolve');
const { ensureLoadable } = require('./convert');

/**
 * @param {string} icon           for warning messages
 * @param {object} rec            resolved item record (must have .parts + .modelName)
 * @param {object} selection      { "<slot>": "<partType>" | null }
 * @param {object} vfs            asset index from resolveMod()
 * @returns {Array<{meshFile,meshFormat,textureFile,parentAttachment,selfAttachment}>}
 */
function resolveAttachments(icon, rec, selection, models, vfs, warn = console.error) {
  if (!selection || !rec || !rec.parts || !rec.parts.length) return [];
  const slots = buildAttachmentSlots(rec, models, vfs);
  const out = [];
  for (const [slot, partType] of Object.entries(selection)) {
    if (!partType) continue; // explicit "none"
    const s = slots.find((x) => x.slot === slot);
    if (!s) { warn(`  ${icon}: unknown attachment slot "${slot}"`); continue; }
    const o = s.options.find((x) => x.partType === partType);
    if (!o) { warn(`  ${icon}: slot "${slot}" has no part "${partType}"`); continue; }
    if (!o.available) { warn(`  ${icon}: ${slot}=${partType} unavailable (${o.missing.join('; ')})`); continue; }
    let mesh;
    try { mesh = ensureLoadable(o.meshFile, o.meshFormat); }
    catch (e) { warn(`  ${icon}: ${slot}=${partType} ${e.message}`); continue; }
    out.push({
      meshFile: mesh.meshFile, meshFormat: mesh.meshFormat, textureFile: o.textureFile,
      parentAttachment: s.parentAttachment, selfAttachment: o.selfAttachment,
    });
  }
  return out;
}

module.exports = { resolveAttachments };
