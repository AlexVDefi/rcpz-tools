#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnRole, dataDir } = require('./runtime');
const { resolveMod, buildAttachmentSlots, stripModule } = require('./resolve');
const { resolveMesh, resolveTexture } = require('./vfs');
const { loadConfig, mergeItemParams, buildStubConfig } = require('./config');
const { ensureLoadable } = require('./convert');
const { resolveAttachments } = require('./attachments');
const { resolveGameDir, setGameDir, SETTINGS_FILE } = require('./settings');


function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function dedupeByIcon(records) {
  // keep the first fully-renderable record per icon; fall back to first seen
  const chosen = new Map();
  for (const r of records) {
    if (!r.icon) continue;
    const renderable = r.meshFile && r.textureFile;
    const cur = chosen.get(r.icon);
    if (!cur || (!(cur.meshFile && cur.textureFile) && renderable)) chosen.set(r.icon, r);
  }
  return [...chosen.values()];
}

// Resolve a config override that pins an `item` (by name) or a `model` block to a
// mesh + texture. Returns { meshFile, meshFormat, textureFile } or null.
function resolveOverride(over, records, models, vfs) {
  if (over.item) {
    const rec = records.find((r) => r.item.toLowerCase() === String(over.item).toLowerCase());
    if (rec && rec.meshFile && rec.textureFile) {
      return { meshFile: rec.meshFile, meshFormat: rec.meshFormat, textureFile: rec.textureFile, rec };
    }
    return null;
  }
  if (over.model) {
    const m = models.get(stripModule(over.model).toLowerCase());
    if (!m || !m.mesh) return null;
    const mesh = resolveMesh(vfs, m.mesh);
    const textureFile = m.texture ? resolveTexture(vfs, m.texture) : null;
    if (!mesh || mesh.unsupported || !textureFile) return null;
    return { meshFile: mesh.file, meshFormat: mesh.format, textureFile };
  }
  return null;
}

/**
 * Game install dir for vanilla assets: --game-dir > saved setting > auto-detect.
 * Prints the auto-detect note once so the user knows where assets came from.
 */
function gameRoots(args) {
  const r = resolveGameDir(args['game-dir'] || args['game-media']);
  if (r.source === 'autodetect' && r.message) console.log(r.message);
  if (!r.gameDir && r.message && args['game-dir']) console.error(r.message);
  return r.gameDir ? [r.gameDir] : [];
}

/**
 * The resolveMod() options every command must share, so `list`/`init`/`slots`/
 * `build`/`preview` all report the same asset availability.
 */
function modOpts(modPath, args) {
  const cfg = loadConfig(modPath, args.config);
  return {
    modelFieldPriority: cfg.defaults.modelFieldPriority,
    extraRoots: [...(cfg.defaults.extraRoots || []), ...gameRoots(args)],
  };
}

function cmdSetGameDir(args) {
  const dir = args._[1];
  if (!dir) die('usage: pz-icon-maker set-game-dir <path-to-ProjectZomboid>');
  try {
    const { file, gameDir } = setGameDir(dir);
    console.log(`Saved game dir: ${gameDir}\n  -> ${file}`);
  } catch (e) { die(e.message); }
}

function cmdInit(args) {
  const modPath = args._[1];
  if (!modPath) die('usage: pz-icon-maker init <modPath> [--out file]');
  const { records } = resolveMod(modPath, modOpts(modPath, args));
  const icons = [...new Set(dedupeByIcon(records)
    .filter((r) => r.meshFile && r.textureFile && r.icon)
    .map((r) => r.icon))].sort();
  const stub = buildStubConfig(icons);
  const outFile = args.out ? path.resolve(String(args.out)) : path.join(path.resolve(modPath), 'icons.config.json');
  if (fs.existsSync(outFile) && !args.force) die(`refusing to overwrite ${outFile} (use --force)`);
  fs.writeFileSync(outFile, JSON.stringify(stub, null, 2));
  console.log(`Wrote ${outFile} with ${icons.length} icon entries.`);
}

function cmdList(args) {
  const modPath = args._[1];
  if (!modPath) die('usage: pz-icon-maker list <modPath>');
  const { mediaDir, layout, records, counts } = resolveMod(modPath, modOpts(modPath, args));
  if (layout.versionDir) console.log(`version: ${path.basename(layout.versionDir)}`);
  if (layout.commonDir) console.log(`common : ${layout.commonDir}`);
  console.log(`media  : ${mediaDir}`);
  console.log(`items=${counts.items} models=${counts.models} renderable=${counts.renderable}`);
  for (const r of dedupeByIcon(records)) {
    const ok = r.meshFile && r.textureFile ? 'OK ' : 'MISS';
    console.log(`  [${ok}] Item_${r.icon}.png  <- ${r.modelField}=${r.modelName}` +
      `  mesh=${r.mesh}(${r.meshFormat || '?'})  tex=${r.textureName || '?'}` +
      (r.issues.length ? `  !! ${r.issues.join('; ')}` : ''));
  }
}

function cmdSlots(args) {
  const modPath = args._[1];
  if (!modPath) die('usage: pz-icon-maker slots <modPath> [--item Name] [--game-dir dir]');
  const { records, models, vfs } = resolveMod(modPath, modOpts(modPath, args));

  const weapons = records.filter((r) => r.parts && r.parts.length &&
    (!args.item || r.item.toLowerCase() === String(args.item).toLowerCase()));
  if (!weapons.length) { console.log('No weapon items with ModelWeaponPart found.'); return; }

  for (const rec of weapons) {
    const slots = buildAttachmentSlots(rec, models, vfs);
    const ok = slots.filter((s) => s.options.some((o) => o.available));
    console.log(`\n${rec.item}  (icon ${rec.icon}, model ${rec.modelName})  ${ok.length}/${slots.length} slots renderable`);
    for (const s of slots) {
      const avail = s.options.filter((o) => o.available);
      if (!avail.length) { console.log(`  [--] ${s.slot}  (${s.options[0].missing[0]})`); continue; }
      console.log(`  [ok] ${s.slot}`);
      for (const o of avail) console.log(`         ${o.partType}`);
    }
  }
}

async function cmdBuild(args) {
  const modPath = args._[1];
  if (!modPath) die('usage: pz-icon-maker build <modPath> [--only a,b] [--size N] [--out-size N] [--no-downscale] [--skip-existing] [--downscale nearest|lanczos3] [--out dir] [--write] [--dry-run]');
  const cfg = loadConfig(modPath, args.config);
  const { mediaDir, records, models, vfs } = resolveMod(modPath, modOpts(modPath, args));

  const modId = path.basename(path.resolve(modPath));
  const onlySet = args.only ? new Set(String(args.only).split(',').map((s) => s.trim())) : null;
  const outSizeArg = args['out-size'] ? parseInt(args['out-size'], 10) : null;
  const renderSize = args.size ? parseInt(args.size, 10)
    : ((outSizeArg || cfg.defaults.outSize) * cfg.defaults.supersample);
  const noDownscale = !!args['no-downscale'];
  const skipExisting = !!args['skip-existing'];
  const downscaleArg = args.downscale ? String(args.downscale) : null;

  let outDir;
  if (args.out) outDir = path.resolve(String(args.out));
  else if (args.write) outDir = path.join(mediaDir, 'textures');
  else outDir = path.join(process.cwd(), 'pz-icon-maker-out', modId);

  // Base targets: one per icon from resolved items (first renderable wins).
  const byIcon = new Map();
  for (const r of dedupeByIcon(records)) {
    if (r.icon && r.meshFile && r.textureFile) {
      byIcon.set(r.icon, { icon: r.icon, meshFile: r.meshFile, meshFormat: r.meshFormat, textureFile: r.textureFile, rec: r });
    }
  }
  // Config overrides / synthetic icons: an items entry may pin a specific `model`
  // block or `item` (by name), overriding the auto-resolved mesh, or defining a
  // brand-new icon name for an item that shares a placeholder icon.
  for (const [icon, over] of Object.entries(cfg.items)) {
    if (!over || (!over.model && !over.item)) continue;
    const resolved = resolveOverride(over, records, models, vfs);
    if (!resolved) { console.error(`  skip ${icon}: override ${JSON.stringify(over)} did not resolve`); continue; }
    byIcon.set(icon, { icon, ...resolved });
  }

  let list = [...byIcon.values()];
  if (onlySet) list = list.filter((r) => onlySet.has(r.icon));
  if (cfg.include.length) list = list.filter((r) => cfg.include.includes(r.icon));
  if (cfg.exclude.length) list = list.filter((r) => !cfg.exclude.includes(r.icon));
  if (skipExisting) {
    const texDir = path.join(mediaDir, 'textures');
    list = list.filter((r) => {
      const exists = fs.existsSync(path.join(texDir, `Item_${r.icon}.png`));
      if (exists) console.log(`  skip ${r.icon} (Item_${r.icon}.png already exists)`);
      return !exists;
    });
  }

  const renders = list.map((r) => {
    const p = mergeItemParams(cfg, r.icon);
    let mesh;
    try { mesh = ensureLoadable(r.meshFile, r.meshFormat); }
    catch (e) { console.error(`  skip ${r.icon}: ${e.message}`); return null; }
    return {
      id: r.icon,
      meshFile: mesh.meshFile, meshFormat: mesh.meshFormat, textureFile: r.textureFile,
      attachments: resolveAttachments(r.icon, r.rec, p.attachments, models, vfs),
      size: renderSize,
      outSize: noDownscale ? renderSize : (outSizeArg || p.outSize),
      downscale: downscaleArg || p.downscale,
      mirror: p.mirror,
      padding: p.padding,
      flipY: p.flipY,
      doubleSide: p.doubleSide,
      angle: { pitch: p.pitch, yaw: p.yaw, extraYaw: p.extraYaw, extraPitch: p.extraPitch, extraRoll: p.extraRoll },
      lighting: { ambient: p.ambient, keyDir: p.keyDir, keyColour: p.keyColour },
      outPath: path.join(outDir, `Item_${r.icon}.png`),
    };
  }).filter(Boolean);

  console.log(`Resolved ${renders.length} icon(s). Output -> ${outDir}`);
  if (args['dry-run']) {
    for (const j of renders) console.log(`  would write ${path.basename(j.outPath)}  (mesh ${path.basename(j.meshFile)})`);
    return;
  }
  if (!renders.length) { console.log('Nothing to render.'); return; }

  const workDir = path.join(dataDir(), 'work');
  fs.mkdirSync(workDir, { recursive: true });
  const jobPath = path.join(workDir, 'job.json');
  fs.writeFileSync(jobPath, JSON.stringify({ renders }, null, 2));

  await runWorker(jobPath);
}

function cmdPreview(args) {
  const modPath = args._[1];
  if (!modPath) die('usage: pz-icon-maker preview <modPath> [--config file] [--icon name]');
  const extra = ['--mod', path.resolve(modPath)];
  if (args.config) extra.push('--config', path.resolve(String(args.config)));
  if (args.icon) extra.push('--icon', String(args.icon));
  const gd = gameRoots(args)[0];
  if (gd) extra.push('--game-dir', gd);
  const child = spawnRole('preview', extra);
  child.on('exit', (code) => process.exit(code || 0));
  child.on('error', (e) => die(e.message));
}

function cmdCharacter(args) {
  const modPath = args._[1];
  if (!modPath) die('usage: pz-icon-maker character <modPath> [--game-dir dir]');
  const extra = ['--mod', path.resolve(modPath)];
  const gd = gameRoots(args)[0];
  if (gd) extra.push('--game-dir', gd);
  const child = spawnRole('character', extra);
  child.on('exit', (code) => process.exit(code || 0));
  child.on('error', (e) => die(e.message));
}

function runWorker(jobPath) {
  return new Promise((resolve, reject) => {
    const child = spawnRole('worker', ['--job', jobPath]);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
    child.on('error', reject);
  });
}

function die(msg) { console.error(msg); process.exit(1); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'init') return cmdInit(args);
  if (cmd === 'list') return cmdList(args);
  if (cmd === 'slots') return cmdSlots(args);
  if (cmd === 'build') return cmdBuild(args);
  if (cmd === 'preview') return cmdPreview(args);
  if (cmd === 'character') return cmdCharacter(args);
  if (cmd === 'set-game-dir') return cmdSetGameDir(args);
  console.log('pz-icon-maker <command>');
  console.log('  set-game-dir <path>            save your Project Zomboid install (for vanilla assets)');
  console.log('  init    <modPath> [--out file]  write an icons.config.json stub');
  console.log('  list    <modPath>               resolve items -> icons, show mapping');
  console.log('  slots   <modPath> [--item N]    list weapon attachment slots + parts');
  console.log('  preview <modPath>               open the interactive preview/adjust UI');
  console.log('  character <modPath>             open the character + animation viewer');
  console.log('  build   <modPath> [options]     render icons');
  console.log('    --game-dir dir    PZ install for this run (overrides the saved one)');
  console.log(`\n  settings: ${SETTINGS_FILE}`);
  console.log('    --only a,b     only these icon names');
  console.log('    --size N       render resolution (px, square)');
  console.log('    --no-downscale keep render size (skip 32px downscale) - for calibration');
  console.log('    --skip-existing  skip icons whose Item_<name>.png already exists in the mod');
  console.log('    --out dir      output dir (default: out/<modId>)');
  console.log('    --write        write into <mod>/media/textures');
  console.log('    --dry-run      list outputs without rendering');
}

main().catch((e) => die(e.stack || String(e)));
