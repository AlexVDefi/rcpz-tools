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

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** A version-named mod subdirectory: "42", "42.13", "41.78". */
const VERSION_DIR = /^\d+(\.\d+)*$/;

/** Compare "42.13" > "42.12" > "42" numerically, segment by segment. */
function compareVersionNames(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Version-named subdirectories of `abs` that actually ship a media/ folder. */
function versionDirsOf(abs) {
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && VERSION_DIR.test(e.name) && isDir(path.join(abs, e.name, 'media')))
    .map((e) => e.name)
    .sort(compareVersionNames);
}

/**
 * Work out which directories make up a mod, the way the game does.
 *
 * A Build 42 mod root holds `common/` plus one or more version directories
 * (`42`, `42.13`, ...), with `mod.info` inside the version directory. The game
 * picks the highest version directory that its build supports, then reads
 * `common/media` first and the version's `media` second, so the version
 * directory overrides `common`. Older mods are flat: `<mod>/mod.info` + `<mod>/media`.
 *
 * Accepts the mod root (preferred, so `common/` is picked up), a version
 * directory, or any directory that simply contains `media/` (e.g. a game install).
 * Only `common` and version-named directories are ever considered, so unrelated
 * siblings -- stray `media/` folders, symlinks to a game install -- are ignored.
 *
 * @returns {{roots: string[], versionDir: string|null, commonDir: string|null}}
 *          `roots` are directories containing `media/`, highest priority first.
 */
function resolveModLayout(modPath) {
  const abs = path.resolve(modPath);
  const roots = [];
  let versionDir = null, commonDir = null;

  const addCommon = (base) => {
    const c = path.join(base, 'common');
    if (isDir(path.join(c, 'media'))) { commonDir = c; return true; }
    return false;
  };

  const versions = versionDirsOf(abs);
  if (versions.length) {
    // `abs` is a mod root: newest version wins, common sits underneath it
    versionDir = path.join(abs, versions[versions.length - 1]);
    roots.push(versionDir);
    if (addCommon(abs)) roots.push(commonDir);
    return { roots, versionDir, commonDir };
  }

  if (isDir(path.join(abs, 'media'))) {
    roots.push(abs);
    // `abs` may itself be a version dir -- pick up its sibling common/
    if (isFile(path.join(abs, 'mod.info')) && VERSION_DIR.test(path.basename(abs))) {
      if (addCommon(path.dirname(abs))) roots.push(commonDir);
      versionDir = abs;
    }
    return { roots, versionDir, commonDir };
  }

  // last resort: a bare `common/` with no version dir
  if (addCommon(abs)) roots.push(commonDir);
  return { roots, versionDir, commonDir };
}

/** Back-compat: the primary media dir (the one icons are written into). */
function findMediaDir(modPath) {
  const { roots } = resolveModLayout(modPath);
  if (!roots.length) return null;
  // prefer a root that already has textures/, else the highest-priority one
  const withTextures = roots.find((r) => isDir(path.join(r, 'media', 'textures')));
  return path.join(withTextures || roots[0], 'media');
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
  const layout = resolveModLayout(modPath);
  if (!layout.roots.length) throw new Error(`Could not find a media/ directory under: ${modPath}`);
  const mediaDir = findMediaDir(modPath);

  // Extra roots get the same treatment, so a cross-mod root can be given as the
  // mod's parent folder and still contribute both its version dir and common/.
  const extraRoots = [];
  for (const r of (opts.extraRoots || [])) {
    const e = resolveModLayout(r);
    extraRoots.push(...(e.roots.length ? e.roots : [path.resolve(r)].filter(isDir)));
  }
  const vfs = buildVfs([...layout.roots, ...extraRoots]);

  // Parse scripts from every mod root, highest priority first: a version dir's
  // definition of an item or model wins over the same name in common/.
  const items = [];
  const seenItems = new Set();
  const models = new Map(); // lowercased model name -> {name, mesh, texture, scale, file}
  const scriptFiles = layout.roots
    .flatMap((r) => listFilesRecursive(path.join(r, 'media', 'scripts')))
    .filter((f) => f.toLowerCase().endsWith('.txt'));
  for (const file of scriptFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const blocks = parseScriptText(text);
    walkBlocks(blocks, (b) => {
      if (b.type === 'item') {
        const key = b.name.toLowerCase();
        if (seenItems.has(key)) return;   // version dir already defined it
        seenItems.add(key);
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

  return { mediaDir, layout, roots: vfs.roots, records, unresolved, models, vfs, counts: {
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
  resolveMod, findMediaDir, resolveModLayout, buildAttachmentSlots,
  parseModelWeaponPart, parseVec3, stripModule, MODEL_FIELD_PRIORITY_DEFAULT,
};
