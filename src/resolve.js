'use strict';

const fs = require('fs');
const path = require('path');
const { parseScriptText, walkBlocks, prop } = require('./scriptParser');
const { buildVfs, resolveMesh, resolveTexture } = require('./vfs');

const MODEL_FIELD_PRIORITY_DEFAULT = ['WorldStaticModel', 'WeaponSprite', 'StaticModel'];

/** "0.0000 0.1659 -0.3877" -> [0, 0.1659, -0.3877] */
function parseVec3(s) {
  if (!s) return [0, 0, 0];
  const p = s.trim().split(/\s+/).map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

/** Script names may be module-qualified ("Base.Foo"); models are keyed bare. */
function stripModule(n) { return String(n).includes('.') ? String(n).split('.').pop() : String(n); }

/**
 * Parse one `ModelWeaponPart = <partType> <modelName> <attachmentNameSelf> <attachmentParent>`
 * line, as the game does: whitespace separated, "none" means null, and a bare name
 * is qualified with the declaring module.
 */
function parseModelWeaponPart(line) {
  const ss = String(line).trim().split(/\s+/);
  if (ss.length < 2) return null;
  const nz = (v) => (v && v.toLowerCase() !== 'none' ? v : null);
  return { partType: ss[0], modelName: ss[1], attachSelf: nz(ss[2]), attachParent: nz(ss[3]) };
}

/** Recursively list files under dir (returns absolute paths). Missing dir -> []. */
function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

/**
 * Find the mod's `media` directory. Accepts either the media dir itself, a mod
 * root containing media/, or a versioned subdir (e.g. Bicycle/42.13). Searches a
 * couple of levels deep for a directory literally named "media".
 */
function findMediaDir(modPath) {
  const abs = path.resolve(modPath);
  const candidates = [abs, path.join(abs, 'media')];
  // one level down (e.g. <mod>/42.13/media, <mod>/common/media)
  try {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) candidates.push(path.join(abs, e.name, 'media'));
    }
  } catch { /* ignore */ }
  for (const c of candidates) {
    if (path.basename(c).toLowerCase() === 'media' && isDir(c)) return c;
  }
  // maybe abs already IS media's parent with unusual name
  return null;
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/**
 * All directories of this mod that contain a `media/` dir (a B42 mod may ship both
 * `<mod>/42/media` and `<mod>/common/media`). The dir holding the primary media/
 * comes first; these become the highest-priority VFS layers.
 */
function collectModRoots(modPath, primaryMediaDir) {
  const roots = [path.dirname(primaryMediaDir)];
  const abs = path.resolve(modPath);
  const seen = new Set(roots.map((r) => r.toLowerCase()));
  for (const base of [abs, path.dirname(primaryMediaDir)]) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cand = path.join(base, e.name);
      if (isDir(path.join(cand, 'media')) && !seen.has(cand.toLowerCase())) {
        seen.add(cand.toLowerCase()); roots.push(cand);
      }
    }
  }
  return roots;
}

/**
 * Scan a mod for item + model definitions and resolve each renderable item to a
 * mesh file + texture file.
 *
 * Assets are resolved exactly as the engine does, by their script-declared path
 * relative to `media/` (see vfs.js). `extraRoots` are additional directories that
 * contain a `media/` dir, searched AFTER the mod's own (so the mod always wins) --
 * typically the Project Zomboid install, for vanilla assets a mod reuses.
 *
 * @param {string} modPath
 * @param {{modelFieldPriority?: string[], extraRoots?: string[]}} [opts]
 */
function resolveMod(modPath, opts = {}) {
  const mediaDir = findMediaDir(modPath);
  if (!mediaDir) throw new Error(`Could not find a media/ directory under: ${modPath}`);

  const scriptsDir = path.join(mediaDir, 'scripts');
  const modRoots = collectModRoots(modPath, mediaDir);
  const extraRoots = (opts.extraRoots || []).map((r) => path.resolve(r)).filter(isDir);
  const vfs = buildVfs([...modRoots, ...extraRoots]);

  // Parse every script file, collecting item + model blocks globally.
  const items = [];
  const models = new Map(); // lowercased model name -> {name, mesh, texture, scale, file}
  const scriptFiles = listFilesRecursive(scriptsDir).filter((f) => f.toLowerCase().endsWith('.txt'));
  for (const file of scriptFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const blocks = parseScriptText(text);
    walkBlocks(blocks, (b) => {
      if (b.type === 'item') {
        items.push({ name: b.name, block: b, file });
      } else if (b.type === 'model') {
        const key = b.name.toLowerCase();
        if (!models.has(key)) {
          const attachments = {};
          for (const c of b.children) {
            if (c.type !== 'attachment') continue;
            attachments[c.name] = {
              offset: parseVec3(prop(c, 'offset')),
              rotate: parseVec3(prop(c, 'rotate')),
              scale: parseFloat(prop(c, 'scale')) || 1,
            };
          }
          models.set(key, {
            name: b.name,
            mesh: prop(b, 'mesh'),
            texture: prop(b, 'texture'),
            scale: parseFloat(prop(b, 'scale')) || 1,
            attachments,
            file,
          });
        }
      }
    });
  }

  const fieldPriority = opts.modelFieldPriority || MODEL_FIELD_PRIORITY_DEFAULT;
  const records = [];
  const unresolved = [];

  for (const it of items) {
    const icon = prop(it.block, 'Icon');
    // pick the first model field present, in priority order
    let modelField = null, modelName = null;
    for (const f of fieldPriority) {
      const v = prop(it.block, f);
      if (v) { modelField = f; modelName = v; break; }
    }
    if (!modelName) continue; // no 3D model -> nothing to render

    const rec = {
      item: it.name, icon, modelField, modelName,
      file: it.file,
      mesh: null, meshFile: null, meshFormat: null,
      textureName: null, textureFile: null, scale: 1,
      // weapon attachment points (empty for non-weapons)
      parts: (it.block.props.get('ModelWeaponPart') || []).map(parseModelWeaponPart).filter(Boolean),
      issues: [],
    };

    const model = models.get(stripModule(modelName).toLowerCase());
    if (!model) {
      rec.issues.push(`model block "${modelName}" not found`);
    } else {
      rec.mesh = model.mesh;
      rec.textureName = model.texture;
      rec.scale = model.scale;
      const m = model.mesh ? resolveMesh(vfs, model.mesh) : null;
      if (m && !m.unsupported) { rec.meshFile = m.file; rec.meshFormat = m.format; }
      else if (m && m.unsupported) rec.issues.push(`mesh "${model.mesh}" is a ${m.format} mesh (unsupported)`);
      else if (model.mesh) rec.issues.push(`no mesh media/models_x/${model.mesh.toLowerCase()}.fbx|.x`);

      rec.textureFile = model.texture ? resolveTexture(vfs, model.texture) : null;
      if (model.texture && !rec.textureFile) rec.issues.push(`no texture media/textures/${model.texture.toLowerCase()}.png`);
    }

    if (!icon) rec.issues.push('item has no Icon field');
    if (rec.issues.length) unresolved.push(rec);
    records.push(rec);
  }

  return { mediaDir, roots: vfs.roots, records, unresolved, models, vfs, counts: {
    items: items.length, models: models.size,
    renderable: records.filter((r) => r.meshFile && r.textureFile && r.icon).length,
  } };
}

/**
 * Build the attachment slots for a weapon item record.
 *
 * Mirrors the game's placement maths:
 *   partTransform = A(parentAttachment) * A(selfAttachment)
 * where A = T(offset) * Rx * Ry * Rz * S(uniform scale). The part's own attachment
 * transform is composed directly, not inverted.
 * A part is only placeable if the PARENT model declares the named attachment.
 *
 * @returns {Array<{slot:string, parentAttachment:object|null, options:Array}>}
 */
function buildAttachmentSlots(rec, models, vfs) {
  if (!rec || !rec.parts || !rec.parts.length || !rec.modelName) return [];
  const parent = models.get(stripModule(rec.modelName).toLowerCase());
  if (!parent) return [];

  const slots = new Map();
  for (const p of rec.parts) {
    if (!p.attachParent) continue; // nothing to hang it on
    const parentAttachment = parent.attachments[p.attachParent] || null;

    const m = models.get(stripModule(p.modelName).toLowerCase());
    const mesh = m && m.mesh ? resolveMesh(vfs, m.mesh) : null;
    const meshFile = mesh && !mesh.unsupported ? mesh.file : null;
    const textureFile = m && m.texture ? resolveTexture(vfs, m.texture) : null;
    const selfAttachment = m && p.attachSelf ? (m.attachments[p.attachSelf] || null) : null;

    const missing = [];
    if (!parentAttachment) missing.push(`parent has no attachment "${p.attachParent}"`);
    if (!m) missing.push(`model "${p.modelName}" not found`);
    else {
      if (mesh && mesh.unsupported) missing.push(`mesh "${m.mesh}" is a ${mesh.format} mesh (unsupported)`);
      else if (!meshFile) missing.push(`no mesh media/models_x/${String(m.mesh).toLowerCase()}.fbx|.x`);
      if (!textureFile) missing.push(`no texture media/textures/${String(m.texture).toLowerCase()}.png`);
    }

    const option = {
      partType: stripModule(p.partType), modelName: stripModule(p.modelName),
      attachSelf: p.attachSelf, selfAttachment,
      meshFile, meshFormat: meshFile ? mesh.format : null,
      textureFile, available: missing.length === 0, missing,
    };
    if (!slots.has(p.attachParent)) slots.set(p.attachParent, { slot: p.attachParent, parentAttachment, options: [] });
    slots.get(p.attachParent).options.push(option);
  }
  return [...slots.values()];
}

module.exports = {
  resolveMod, findMediaDir, buildAttachmentSlots,
  parseModelWeaponPart, parseVec3, stripModule, MODEL_FIELD_PRIORITY_DEFAULT,
};
