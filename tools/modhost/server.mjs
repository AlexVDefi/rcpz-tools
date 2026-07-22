#!/usr/bin/env node
// Modder-hosting backend service (runs on the Hetzner box). It turns the one-shot host-mod.mjs
// into an always-on worker:
//   - POST /host  (x-modhost-secret)  the Worker pings this when a modder allows/revokes a mod
//   - GET  /health
// and a periodic sweep of Supabase mod_permissions:
//   - status=allowed & not yet hosted  -> download + bake + upload, mark host_status=hosted
//   - status=revoked & still hosted    -> delete from R2, mark host_status=removed
// Supabase is the source of truth; the webhook only nudges the sweep, so a missed ping is caught
// on the next interval. Jobs run one at a time (steamcmd + bake are heavy).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE, MODHOST_SECRET, PORT, SWEEP_MS, plus the vars host-mod
// needs (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET, STEAMCMD, PUBLIC_ASSET_BASE).

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE, MODHOST_SECRET,
  PORT = '8790', SWEEP_MS = String(3 * 60 * 1000), MAX_ATTEMPTS = '3',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE are required'); process.exit(1); }

const svc = { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` };
const REST = `${SUPABASE_URL}/rest/v1/mod_permissions`;

async function sbGet(qs) {
  const res = await fetch(`${REST}?${qs}`, { headers: svc });
  if (!res.ok) throw new Error(`supabase GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function sbPatch(id, patch) {
  const res = await fetch(`${REST}?id=eq.${id}`, {
    method: 'PATCH', headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`supabase PATCH ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Run a repo tool, capture stdout, resolve { code, stdout }.
function runTool(script, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(REPO_ROOT, 'tools', script), ...args], { cwd: REPO_ROOT, env: process.env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('exit', (code) => resolve({ code, stdout: out }));
    p.on('error', (e) => resolve({ code: 1, stdout: out + '\n' + e.message }));
  });
}

async function hostOne(row) {
  console.log(`\n[host] ${row.publishedfileid} (attempt ${row.host_attempts + 1})`);
  await sbPatch(row.id, { host_status: 'processing', host_attempts: row.host_attempts + 1 });
  const r = await runTool('host-mod.mjs', ['--id', String(row.publishedfileid)]);
  const m = /^RESULT (\{.*\})\s*$/m.exec(r.stdout);
  if (r.code === 0 && m) {
    const result = JSON.parse(m[1]);
    await sbPatch(row.id, { host_status: 'hosted', hosted: result.mods, hosted_at: new Date().toISOString(), host_error: null });
    console.log(`[host] hosted ${row.publishedfileid} -> ${result.mods.map((x) => x.modId).join(', ')}`);
  } else {
    const err = (r.stdout.split('\n').filter(Boolean).pop() || `exit ${r.code}`).slice(0, 500);
    await sbPatch(row.id, { host_status: 'failed', host_error: err });
    console.error(`[host] FAILED ${row.publishedfileid}: ${err}`);
  }
}

async function removeOne(row) {
  console.log(`\n[remove] ${row.publishedfileid}`);
  for (const m of row.hosted || []) {
    if (m.modId) await runTool('remove-r2.mjs', ['--prefix', `mods/${m.modId}`]);
  }
  await sbPatch(row.id, { host_status: 'removed', hosted: null });
  console.log(`[remove] un-hosted ${row.publishedfileid}`);
}

let running = false;
let lastSweep = 0;
async function sweep(reason = 'interval') {
  if (running) return;
  running = true;
  try {
    const toHost = await sbGet(`status=eq.allowed&host_attempts=lt.${MAX_ATTEMPTS}&or=(host_status.is.null,host_status.eq.queued,host_status.eq.failed)&select=id,publishedfileid,host_attempts&order=consented_at.asc`);
    const toRemove = await sbGet(`status=eq.revoked&host_status=eq.hosted&select=id,publishedfileid,hosted`);
    if (toHost.length || toRemove.length) console.log(`[sweep:${reason}] ${toHost.length} to host, ${toRemove.length} to remove`);
    for (const row of toRemove) { try { await removeOne(row); } catch (e) { console.error('remove error:', e.message); } }
    for (const row of toHost) { try { await hostOne(row); } catch (e) { console.error('host error:', e.message); } }
  } catch (e) { console.error('[sweep] error:', e.message); }
  finally { running = false; lastSweep = Date.now(); }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, busy: running, lastSweep }));
  }
  if (req.method === 'POST' && url.pathname === '/host') {
    if (!MODHOST_SECRET || req.headers['x-modhost-secret'] !== MODHOST_SECRET) return res.writeHead(401).end('unauthorized');
    res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ queued: true }));
    sweep('webhook'); // fire and forget; sweep is single-flight
    return;
  }
  res.writeHead(404).end('not found');
});

server.listen(Number(PORT), () => {
  console.log(`modhost listening on :${PORT} (sweep every ${Math.round(Number(SWEEP_MS) / 1000)}s)`);
  sweep('startup');
  setInterval(() => sweep('interval'), Number(SWEEP_MS));
});
