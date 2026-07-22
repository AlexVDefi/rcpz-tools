#!/usr/bin/env node
// Modder-hosting phase M1 validation: prove we can list a Steam user's PUBLISHED Project
// Zomboid Workshop mods and confirm ownership, from nothing but their SteamID64 + a Steam
// Web API key. This is the foundation the whole modder-hosting flow rests on - if this
// returns a modder's mods, the "sign in with Steam, see your mods, no manual IDs, ownership
// already proven" flow is real. No auth/UI/backend yet.
//
//   set -a; . ./.steam.env; set +a; node tools/steam-mods.mjs        # key + steamid from .steam.env
//   node tools/steam-mods.mjs --steamid 7656119... --key <STEAM_WEB_API_KEY>

const PZ_APPID = 108600;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

async function api(iface, method, version, params) {
  const url = new URL(`https://api.steampowered.com/${iface}/${method}/${version}/`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${method}: non-JSON response: ${text.slice(0, 200)}`); }
}

// IPublishedFileService/GetUserFiles: items PUBLISHED (created) by this SteamID for the app.
async function getUserFiles(key, steamid, page = 1) {
  const j = await api('IPublishedFileService', 'GetUserFiles', 'v1', {
    key, steamid, appid: PZ_APPID, numperpage: 100, page,
    return_metadata: true, return_previews: true, return_tags: true, return_vote_data: false,
  });
  return j.response || {};
}

// IPublishedFileService/GetDetails: cross-check the authoritative `creator` per item.
async function getDetails(key, ids) {
  const params = { key };
  ids.forEach((id, i) => { params[`publishedfileids[${i}]`] = id; });
  const j = await api('IPublishedFileService', 'GetDetails', 'v1', params);
  return j.response?.publishedfiledetails || [];
}

const kb = (n) => (n ? (Number(n) / 1024).toFixed(0) + ' KB' : '?');

async function main() {
  const key = arg('--key', process.env.STEAM_WEB_API_KEY);
  const steamid = arg('--steamid', process.env.STEAM_ID);
  if (!key) throw new Error('need a Steam Web API key: --key <key>, or STEAM_WEB_API_KEY in .steam.env');
  if (!steamid) throw new Error('need a SteamID64: --steamid <id>, or STEAM_ID in .steam.env');

  console.log(`Steam Web API - published PZ (appid ${PZ_APPID}) Workshop items for ${steamid}\n`);
  const r = await getUserFiles(key, steamid);
  const files = r.publishedfiledetails || [];
  console.log(`total published by this account: ${r.total ?? files.length}\n`);
  for (const f of files.slice(0, 30)) {
    console.log(`  ${f.publishedfileid}  ${f.title || '(untitled)'}  [${kb(f.file_size)}${f.preview_url ? ', has preview' : ''}]`);
  }
  if (files.length > 30) console.log(`  ... and ${files.length - 30} more`);

  if (files.length) {
    // Ownership: GetUserFiles already means "published by this SteamID". Double-lock via GetDetails.creator.
    const det = await getDetails(key, [files[0].publishedfileid]);
    const c = det[0]?.creator;
    console.log(`\nOwnership cross-check on ${files[0].publishedfileid}:`);
    console.log(`  GetDetails.creator = ${c} -> ${c === String(steamid) ? 'MATCHES the authed SteamID (verified owner)' : 'MISMATCH (would reject)'}`);
    console.log(`  file_url present: ${det[0]?.file_url ? 'yes' : 'no'}   (download link, if any, for the server-side bake step)`);
  } else {
    console.log('\nNo published items returned. Either this account published no PZ mods, or its Workshop is private.');
  }
}
main().catch((e) => { console.error('\nsteam api failed:', e.message); process.exit(1); });
