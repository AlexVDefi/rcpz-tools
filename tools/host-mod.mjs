#!/usr/bin/env node
// Modder-hosting M3 job: given a Workshop item id, download it with steamcmd, bake each mod it
// contains (mod-only, no PZ install needed), and upload the bundle(s) to R2 under mods/<modId>/.
// This is the unit of work the VPS backend runs when a modder allows a mod. It shells out to the
// existing tools (bake-assets.mjs, upload-r2.mjs), so there's one bake/upload implementation.
//
//   set -a; . ./.r2.env; set +a; node tools/host-mod.mjs --id 3766140920
//
// steamcmd path: --steamcmd, or $STEAMCMD, else a per-platform guess. R2 creds come from the
// environment (see .r2.env). Public base for the printed URLs: --public-base or $PUBLIC_ASSET_BASE.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PZ_APPID = 108600;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

function defaultSteamcmd() {
  const guesses = process.platform === 'win32'
    ? ['C:/dev/steamcmd/steamcmd.exe', 'C:/steamcmd/steamcmd.exe']
    : ['/usr/games/steamcmd', path.join(os.homedir(), 'steamcmd/steamcmd.sh'), '/opt/steamcmd/steamcmd.sh'];
  return guesses.find((g) => fs.existsSync(g)) || guesses[0];
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts });
    let out = '';
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('exit', (code) => resolve({ code, stdout: out }));
    p.on('error', reject);
  });
}

// Every <...>/mods/<modId> dir under the downloaded item that actually holds media.
function findModDirs(contentDir) {
  const found = new Set();
  const hasMedia = (d) => { try { return fs.statSync(path.join(d, 'media')).isDirectory(); } catch { return false; } };
  const modHasContent = (d) => hasMedia(d) || fs.readdirSync(d, { withFileTypes: true }).some((e) => e.isDirectory() && hasMedia(path.join(d, e.name)));
  const scan = (dir, depth) => {
    if (depth > 4) return;
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.toLowerCase() === 'mods') {
        for (const m of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) {
          if (m.isDirectory()) { const md = path.join(dir, e.name, m.name); if (modHasContent(md)) found.add(md); }
        }
      } else scan(path.join(dir, e.name), depth + 1);
    }
  };
  scan(contentDir, 0);
  return [...found];
}

const node = (script, args) => run(process.execPath, [path.join(REPO_ROOT, 'tools', script), ...args], { cwd: REPO_ROOT });

async function main() {
  const id = arg('--id', process.env.WORKSHOP_ID);
  if (!/^\d+$/.test(id || '')) throw new Error('need --id <publishedfileid>');
  const steamcmd = arg('--steamcmd', process.env.STEAMCMD || defaultSteamcmd());
  const steamRoot = path.dirname(steamcmd);
  const publicBase = (arg('--public-base', process.env.PUBLIC_ASSET_BASE || 'https://assets.rcpz.tools')).replace(/\/$/, '');

  console.log(`[1/3] steamcmd download ${id} (${steamcmd}) ...`);
  const dl = await run(steamcmd, ['+login', 'anonymous', '+workshop_download_item', String(PZ_APPID), id, '+quit'], { cwd: steamRoot });
  // steamcmd prints the real install path, and it differs by platform (Linux uses ~/Steam,
  // Windows uses <steamcmd dir>/steamapps) - parse it rather than guessing.
  const dlPath = (/Downloaded item \d+ to "([^"]+)"/.exec(dl.stdout) || [])[1]?.trim();
  const contentDir = dlPath || path.join(steamRoot, 'steamapps', 'workshop', 'content', String(PZ_APPID), id);
  if (!fs.existsSync(contentDir)) throw new Error(`download produced no content (steamcmd exit ${dl.code})`);

  const modDirs = findModDirs(contentDir);
  if (!modDirs.length) throw new Error(`no mods with media found under item ${id}`);
  console.log(`\nItem ${id} contains ${modDirs.length} mod(s): ${modDirs.map((d) => path.basename(d)).join(', ')}`);

  const hosted = [];
  for (const modDir of modDirs) {
    console.log(`\n[2/3] bake ${path.basename(modDir)} ...`);
    const bake = await node('bake-assets.mjs', ['--mod', modDir]);
    const bundleDir = (/Done -> (.+)/.exec(bake.stdout) || [])[1]?.trim();
    if (bake.code !== 0 || !bundleDir || !fs.existsSync(path.join(bundleDir, 'manifest.json'))) { console.error(`  bake failed for ${modDir}`); continue; }
    const modId = path.basename(bundleDir);

    console.log(`\n[3/3] upload ${modId} -> R2 mods/${modId}/ ...`);
    const up = await node('upload-r2.mjs', ['--bundle', bundleDir, '--prefix', `mods/${modId}`]);
    if (up.code !== 0) { console.error(`  upload failed for ${modId}`); continue; }
    hosted.push({ modId, wsId: id, url: `${publicBase}/mods/${modId}/` });
  }

  console.log(`\n=== hosted ${hosted.length}/${modDirs.length} ===`);
  for (const h of hosted) console.log(`  ${h.modId}: ${h.url}`);
  if (!hosted.length) process.exit(1);
  // Emit machine-readable result on the last line (the VPS service parses this).
  console.log('RESULT ' + JSON.stringify({ wsId: id, mods: hosted }));
}
main().catch((e) => { console.error('\nhost-mod failed:', e.message); process.exit(1); });
