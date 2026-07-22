// PZ Survivor Studio - upload/serve Worker for the optional online-sharing feature.
//
// Responsibilities:
//   POST   /upload?kind=&ext=   verify the Supabase user, enforce the 100 MB per-user cap, store
//                               the render in R2, record a row in Supabase, return its share URL.
//                               An optional X-Share-Meta header (base64 JSON) records what the
//                               render depicts (equipped items + mod sources) for the viewer.
//   DELETE /object?key=         verify + ownership-check, delete the object and its row.
//   DELETE /account             verify, then PERMANENTLY delete the user: every R2 object under
//                               their prefix, their upload rows, and their auth account.
//   GET    /f/<key>             public: stream the object from R2 (this is the raw shareable link).
//   GET    /p/<key>             public: a branded "custom player" HTML page wrapping the render with
//                               the character name + mods used + the PZ Survivor Studio brand.
//
// The browser never holds any storage secret. The quota and ownership are enforced here; the
// Supabase `uploads` table is the record the app reads (under RLS) to show a user their shares.

export interface Env {
  BUCKET: R2Bucket;
  SUPABASE_URL: string;          // var, e.g. https://abcd.supabase.co
  SUPABASE_ANON_KEY: string;     // var (public anon key; used as apikey when verifying tokens)
  SUPABASE_SERVICE_ROLE: string; // secret (bypasses RLS to read usage + write/delete rows)
  ALLOWED_ORIGINS?: string;      // var, comma-separated app origins allowed to call the API
  QUOTA_BYTES?: string;          // var, optional override of the default 100 MB
  STEAM_WEB_API_KEY?: string;    // secret: lists a modder's published Workshop items (GetUserFiles)
  STEAM_SESSION_SECRET?: string; // secret: HMAC key for the short-lived modder session token
  MODHOST_URL?: string;          // var: hosting backend base URL (e.g. http://<vps>:8790), optional
  MODHOST_SECRET?: string;       // secret: shared secret sent to the backend in x-modhost-secret
}

const DEFAULT_QUOTA = 100 * 1024 * 1024;
// accepted (kind -> allowed extensions); mp4 export falls back to webm on some browsers
const KIND_EXT: Record<string, string[]> = { png: ['png'], gif: ['gif'], mp4: ['mp4', 'webm'] };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = cors(env, request.headers.get('Origin'));

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    // public reads need no CORS wrapper (loaded as media / opened directly)
    if (request.method === 'GET' && url.pathname.startsWith('/f/')) return serve(url, env);
    if (request.method === 'GET' && url.pathname.startsWith('/p/')) return playerPage(url, env);
    if (request.method === 'POST' && url.pathname === '/upload') return withCors(await upload(request, url, env), corsHeaders);
    if (request.method === 'DELETE' && url.pathname === '/object') return withCors(await remove(request, url, env), corsHeaders);
    if (request.method === 'DELETE' && url.pathname === '/account') return withCors(await deleteAccount(request, env), corsHeaders);
    // Modder hosting: Steam sign-in (browser redirects, no CORS) + their Workshop mods (app fetch, CORS).
    if (request.method === 'GET' && url.pathname === '/steam/login') return steamLogin(url, env);
    if (request.method === 'GET' && url.pathname === '/steam/callback') return steamCallback(url, env);
    if (request.method === 'GET' && url.pathname === '/steam/mods') return withCors(await steamMods(request, env), corsHeaders);
    if (request.method === 'GET' && url.pathname === '/steam/permissions') return withCors(await steamPermissions(request, env), corsHeaders);
    if (request.method === 'POST' && url.pathname === '/steam/permission') return withCors(await steamPermission(request, env), corsHeaders);
    return withCors(json({ error: 'Not found' }, 404), corsHeaders);
  },
};

async function upload(request: Request, url: URL, env: Env): Promise<Response> {
  const uid = await verifyUser(request, env);
  if (!uid) return json({ error: 'Unauthorized' }, 401);

  const kind = url.searchParams.get('kind') || '';
  const ext = (url.searchParams.get('ext') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
  if (!KIND_EXT[kind] || !KIND_EXT[kind].includes(ext)) return json({ error: 'Unsupported file type' }, 400);

  const quota = Number(env.QUOTA_BYTES) || DEFAULT_QUOTA;
  const len = Number(request.headers.get('content-length') || '0');
  if (!len) return json({ error: 'Missing content length' }, 411);
  if (len > quota) return json({ error: 'File is larger than your whole storage limit' }, 413);

  const used = await usageBytes(uid, env);
  if (used + len > quota) return json({ error: 'That would exceed your 100 MB storage limit' }, 413);

  const key = `u/${uid}/${crypto.randomUUID()}.${ext}`;
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  const meta = decodeMeta(request.headers.get('X-Share-Meta'));
  const obj = await env.BUCKET.put(key, request.body, { httpMetadata: { contentType } });
  const size = obj?.size ?? len;

  // record it; if the DB write fails, roll back the object so usage never drifts from the table
  const ins = await fetch(`${env.SUPABASE_URL}/rest/v1/uploads`, {
    method: 'POST',
    headers: { ...svc(env), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: uid, key, size, content_type: contentType, kind, meta }),
  });
  if (!ins.ok) { await env.BUCKET.delete(key); return json({ error: 'Could not record the upload' }, 500); }

  return json({ key, url: `${url.origin}/f/${key}`, size });
}

async function remove(request: Request, url: URL, env: Env): Promise<Response> {
  const uid = await verifyUser(request, env);
  if (!uid) return json({ error: 'Unauthorized' }, 401);
  const key = url.searchParams.get('key') || '';
  if (!key.startsWith(`u/${uid}/`)) return json({ error: 'Forbidden' }, 403); // only your own objects
  await env.BUCKET.delete(key);
  await fetch(`${env.SUPABASE_URL}/rest/v1/uploads?key=eq.${encodeURIComponent(key)}&user_id=eq.${uid}`, {
    method: 'DELETE', headers: svc(env),
  });
  return json({ ok: true });
}

// Permanently delete the caller's account and everything tied to it. Runs in this order so a
// failure never leaves data reachable: (1) every R2 object under u/<uid>/, (2) their upload rows,
// (3) the auth account itself. Deleting the auth user also cascades the rows (belt and braces).
async function deleteAccount(request: Request, env: Env): Promise<Response> {
  const uid = await verifyUser(request, env);
  if (!uid) return json({ error: 'Unauthorized' }, 401);

  // 1. wipe all of the user's stored renders from R2 (list is paginated; delete up to 1000/call)
  const prefix = `u/${uid}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // 2. drop their upload rows
  await fetch(`${env.SUPABASE_URL}/rest/v1/uploads?user_id=eq.${uid}`, { method: 'DELETE', headers: svc(env) });

  // 3. hard-delete the auth user (service_role only). 404 = already gone, treat as success.
  const del = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: svc(env) });
  if (!del.ok && del.status !== 404) {
    return json({ error: 'Your shared items were removed, but deleting the account failed. Please try again.' }, 502);
  }
  return json({ ok: true });
}

// Decode the optional X-Share-Meta header: base64(JSON) describing the render. Never trusted for
// anything but display, so on any problem (missing, too big, bad base64/JSON) we store null.
function decodeMeta(header: string | null): unknown {
  if (!header || header.length > 16384) return null;
  try {
    const bin = atob(header);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const jsonStr = new TextDecoder().decode(bytes);
    if (jsonStr.length > 12000) return null;
    return JSON.parse(jsonStr);
  } catch { return null; }
}

async function serve(url: URL, env: Env): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice('/f/'.length));
  if (!key) return new Response('Not found', { status: 404 });
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('access-control-allow-origin', '*'); // let the render embed on any site
  return new Response(obj.body, { headers });
}

interface PlayerMeta {
  character?: string;
  gender?: 'male' | 'female';
  clothing?: { name?: string; display?: string; mod?: string | null }[];
  held?: { name?: string; display?: string; hand?: string; mod?: string | null }[];
  mods?: string[];
}

// The branded "custom player" page for a share. Looks up the row's meta (service_role, since this
// page is public by design), then returns a self-contained HTML page that embeds the raw render
// from /f/<key> and shows the character name, the mods used, and the PZ Survivor Studio brand.
async function playerPage(url: URL, env: Env): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice('/p/'.length));
  if (!key || !key.startsWith('u/')) return notFoundPage();
  let row: { kind?: string | null; content_type?: string | null; meta?: PlayerMeta | null } | null = null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/uploads?key=eq.${encodeURIComponent(key)}&select=kind,content_type,meta`, { headers: svc(env) });
    if (res.ok) { const arr = (await res.json()) as unknown; row = Array.isArray(arr) ? (arr[0] ?? null) : null; }
  } catch { /* fall through to 404 */ }
  if (!row) return notFoundPage();
  const html = playerHtml(url.origin, key, row);
  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // strict CSP: no scripts at all, media/images only from this origin. Belt-and-braces on top of
    // HTML-escaping every user-derived value (character name, item/mod names).
    'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  } });
}

function notFoundPage(): Response {
  const html = '<!doctype html><meta charset="utf-8"><title>Not found - PZ Survivor Studio</title>' +
    '<body style="margin:0;background:#141418;color:#e7e7ea;font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;text-align:center">' +
    '<div><div style="font-size:30px;color:#3a3a44">&#9672;</div><p>This share does not exist or was deleted.</p>' +
    '<p><a style="color:#5b8cff" href="https://survivor.rcpz.tools">Go to PZ Survivor Studio</a></p></div>';
  return new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function playerHtml(origin: string, key: string, row: { kind?: string | null; content_type?: string | null; meta?: PlayerMeta | null }): string {
  const media = `${origin}/f/${key.split('/').map(encodeURIComponent).join('/')}`;
  const isVideo = row.kind === 'mp4' || (row.content_type || '').startsWith('video/');
  const meta = row.meta || {};
  const name = (meta.character || '').trim() || 'A PZ Survivor Studio render';
  const held = Array.isArray(meta.held) ? meta.held.filter((h) => h && h.name) : [];
  const clothing = Array.isArray(meta.clothing) ? meta.clothing.filter((c) => c && c.name) : [];
  const mods = Array.isArray(meta.mods) ? meta.mods.filter(Boolean) : [];
  const desc = mods.length ? `Made with PZ Survivor Studio. Mods used: ${mods.join(', ')}.` : 'Made with PZ Survivor Studio.';

  const modChip = (m: string | null | undefined) =>
    m ? `<span class="tag">${esc(m)}</span>` : '<span class="tag vanilla">Vanilla</span>';
  const itemRow = (nm: string, extra: string, mod: string | null | undefined) =>
    `<div class="item"><span class="iname">${esc(nm)}</span>${extra}${modChip(mod)}</div>`;

  const section = (title: string, rows: string) => rows ? `<div class="sec"><div class="sechd">${esc(title)}</div>${rows}</div>` : '';
  const heldRows = held.map((h) => itemRow(h.display || h.name!, `<span class="hand">${h.hand === 'left' ? 'L' : 'R'}</span>`, h.mod)).join('');
  const clothingRows = clothing.map((c) => itemRow(c.display || c.name!, '', c.mod)).join('');
  const modsBlock = mods.length ? `<div class="sec"><div class="sechd">Mods used (${mods.length})</div><div class="tags">${mods.map((m) => `<span class="tag">${esc(m)}</span>`).join('')}</div></div>` : '';
  const genderLine = meta.gender ? `<div class="sub">${meta.gender === 'female' ? 'Female' : 'Male'} survivor</div>` : '';

  const mediaEl = isVideo
    ? `<video src="${esc(media)}" controls autoplay muted loop playsinline></video>`
    : `<img src="${esc(media)}" alt="${esc(name)}">`;

  const ogMedia = isVideo
    ? `<meta property="og:type" content="video.other"><meta property="og:video" content="${esc(media)}"><meta property="og:video:type" content="${esc(row.content_type || 'video/mp4')}">`
    : `<meta property="og:type" content="website"><meta property="og:image" content="${esc(media)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(media)}">`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} - PZ Survivor Studio</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:site_name" content="PZ Survivor Studio">
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(desc)}">
${ogMedia}
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#141418;color:#e7e7ea;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{min-height:100vh;display:flex}
.stage{position:relative;flex:1;min-width:0;display:grid;place-items:center;padding:24px;background:repeating-conic-gradient(#26262c 0% 25%,#1d1d22 0% 50%) 50%/24px 24px}
.stage img,.stage video{max-width:100%;max-height:calc(100vh - 48px);object-fit:contain;border-radius:8px;box-shadow:0 10px 40px #0009}
.wm{position:absolute;right:20px;bottom:20px;display:flex;align-items:center;gap:6px;background:#000000ad;border:1px solid #ffffff26;border-radius:8px;padding:5px 11px;font-weight:600;font-size:13px}
.info{width:330px;flex-shrink:0;padding:22px 20px;background:#1b1b21;border-left:1px solid #34343c;overflow:auto}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;letter-spacing:.01em;color:#9a9aa6}
.brand .dot{width:10px;height:10px;border-radius:3px;background:#5b8cff}
h1{font-size:22px;margin:12px 0 2px;line-height:1.2;word-break:break-word}
.sub{color:#9a9aa6;font-size:13px}
.sec{margin-top:18px}
.sechd{text-transform:uppercase;letter-spacing:.05em;font-size:11px;color:#9a9aa6;margin-bottom:7px}
.item{display:flex;align-items:center;gap:7px;padding:6px 0;border-bottom:1px solid #ffffff10}
.iname{flex:1;min-width:0;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hand{width:19px;text-align:center;font-size:10px;font-weight:700;color:#fff;background:#5b8cff;border-radius:4px;padding:1px 0}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:11px;color:#8fb0ff;background:#0e1524;border:1px solid #2a3a5a;border-radius:999px;padding:2px 9px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag.vanilla{color:#9a9aa6;background:#181820;border-color:#34343c}
.cta{display:inline-block;margin-top:22px;padding:10px 15px;border-radius:8px;background:#5b8cff;color:#fff;text-decoration:none;font-weight:600;font-size:13.5px}
.cta:hover{filter:brightness(1.08)}
@media(max-width:800px){main{flex-direction:column}.info{width:auto;border-left:0;border-top:1px solid #34343c}.stage{padding:16px}.stage img,.stage video{max-height:70vh}}
</style></head><body><main>
<div class="stage">${mediaEl}<div class="wm"><span class="dot" style="background:#5b8cff;width:12px;height:12px;border-radius:3px;display:inline-block"></span>PZ Survivor Studio</div></div>
<aside class="info">
<div class="brand"><span class="dot"></span>PZ Survivor Studio</div>
<h1>${esc(name)}</h1>
${genderLine}
${section(`Held (${held.length})`, heldRows)}
${section(`Clothing (${clothing.length})`, clothingRows)}
${modsBlock}
<a class="cta" href="https://survivor.rcpz.tools">Create your own &rarr;</a>
</aside>
</main></body></html>`;
}

// ---- Steam sign-in (OpenID 2.0) + Workshop mod listing, for the modder-hosting flow ----
// A modder proves ownership just by signing in: GetUserFiles only ever lists items THAT SteamID
// published, so "your mods" and "you own them" are one query. We hand the app a short-lived
// HMAC-signed token carrying the SteamID; the app sends it back as a Bearer to read the mods.

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const STEAM_CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bearer = (request: Request) => { const a = request.headers.get('Authorization'); return a?.startsWith('Bearer ') ? a.slice(7) : null; };

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}
async function signSteamSession(steamid: string, env: Env): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify({ steamid, exp: Date.now() + 7 * 86400000 })));
  return `${body}.${await hmac(body, env.STEAM_SESSION_SECRET || '')}`;
}
async function steamSessionId(token: string | null, env: Env): Promise<string | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || (await hmac(body, env.STEAM_SESSION_SECRET || '')) !== sig) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as { steamid?: string; exp?: number };
    return p.steamid && p.exp && Date.now() < p.exp ? p.steamid : null;
  } catch { return null; }
}

// Only ever redirect back to an app origin we explicitly allow - guards against an open redirect
// leaking the session token to an attacker-controlled site.
function allowedAppUrl(raw: string | null, env: Env): string {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!raw) return allowed[0] || '';
  try { const u = new URL(raw); return allowed.includes(u.origin) ? u.origin + u.pathname : (allowed[0] || ''); }
  catch { return allowed[0] || ''; }
}

function steamLogin(url: URL, env: Env): Response {
  const app = allowedAppUrl(url.searchParams.get('return'), env);
  const returnTo = `${url.origin}/steam/callback?app=${encodeURIComponent(app)}`;
  const p = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': url.origin,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return Response.redirect(`${STEAM_OPENID}?${p.toString()}`, 302);
}

async function steamCallback(url: URL, env: Env): Promise<Response> {
  const app = allowedAppUrl(url.searchParams.get('app'), env) || '/';
  // Never trust the returned params: re-ask Steam to authenticate the assertion.
  const check = new URLSearchParams(url.search);
  check.set('openid.mode', 'check_authentication');
  const vres = await fetch(STEAM_OPENID, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: check.toString() });
  const valid = /is_valid\s*:\s*true/.test(await vres.text());
  const m = STEAM_CLAIMED_ID.exec(url.searchParams.get('openid.claimed_id') || '');
  const back = new URL(app);
  if (!valid || !m) { back.hash = 'steam_error=1'; return Response.redirect(back.toString(), 302); }
  back.hash = `steam=${await signSteamSession(m[1], env)}`; // fragment: not sent to servers or logs
  return Response.redirect(back.toString(), 302);
}

async function steamApi(path: string, params: Record<string, string>, env: Env): Promise<{ response?: { publishedfiledetails?: Array<Record<string, unknown>> } }> {
  const u = new URL(`https://api.steampowered.com/${path}/`);
  u.searchParams.set('key', env.STEAM_WEB_API_KEY || '');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`steam ${path} ${res.status}`);
  return res.json();
}

async function steamMods(request: Request, env: Env): Promise<Response> {
  const steamid = await steamSessionId(bearer(request), env);
  if (!steamid) return json({ error: 'Unauthorized' }, 401);
  try {
    const r = await steamApi('IPublishedFileService/GetUserFiles/v1', {
      steamid, appid: '108600', numperpage: '100', page: '1', return_previews: 'true', return_tags: 'true',
    }, env);
    const mods = (r.response?.publishedfiledetails || []).map((f) => ({
      id: String(f.publishedfileid), title: String(f.title || ''), preview: (f.preview_url as string) || null, size: Number(f.file_size) || 0,
    }));
    return json({ steamid, mods });
  } catch { return json({ error: 'Steam lookup failed' }, 502); }
}

// A modder's current hosting consents (from Supabase, keyed by their session SteamID).
async function steamPermissions(request: Request, env: Env): Promise<Response> {
  const steamid = await steamSessionId(bearer(request), env);
  if (!steamid) return json({ error: 'Unauthorized' }, 401);
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/mod_permissions?steamid=eq.${steamid}&select=publishedfileid,title,status,consented_at`, { headers: svc(env) });
  if (!res.ok) return json({ error: 'Query failed' }, 502);
  return json({ permissions: await res.json() });
}

// Grant or revoke hosting consent for one mod. Ownership is RE-verified server-side against Steam
// (never trust the client's mod id), and the title is taken from Steam, not the client.
async function steamPermission(request: Request, env: Env): Promise<Response> {
  const steamid = await steamSessionId(bearer(request), env);
  if (!steamid) return json({ error: 'Unauthorized' }, 401);
  let body: { id?: string; allow?: boolean };
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const id = String(body.id || '');
  if (!/^\d+$/.test(id)) return json({ error: 'Bad mod id' }, 400);

  let title = '';
  try {
    const det = await steamApi('IPublishedFileService/GetDetails/v1', { 'publishedfileids[0]': id }, env);
    const f = det.response?.publishedfiledetails?.[0];
    if (!f || String(f.creator) !== steamid) return json({ error: 'You are not the owner of that mod' }, 403);
    title = String(f.title || '');
  } catch { return json({ error: 'Steam verification failed' }, 502); }

  const row = { steamid, publishedfileid: id, title, status: body.allow ? 'allowed' : 'revoked', consented_at: new Date().toISOString(), terms_version: 1, updated_at: new Date().toISOString() };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/mod_permissions?on_conflict=steamid,publishedfileid`, {
    method: 'POST',
    headers: { ...svc(env), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) return json({ error: 'Could not save your choice' }, 500);

  // Nudge the hosting backend to download+bake (or remove) now; it also polls, so this is
  // best-effort - a failed ping just means the change is picked up on the next sweep.
  if (env.MODHOST_URL && env.MODHOST_SECRET) {
    try {
      await fetch(`${env.MODHOST_URL.replace(/\/$/, '')}/host`, {
        method: 'POST', headers: { 'x-modhost-secret': env.MODHOST_SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      });
    } catch { /* backend polls anyway */ }
  }
  return json({ ok: true, id, status: row.status });
}

// Verify a Supabase access token by asking Supabase who it belongs to. Returns the user id or null.
async function verifyUser(request: Request, env: Env): Promise<string | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  const u = (await res.json()) as { id?: string };
  return u.id ?? null;
}

async function usageBytes(uid: string, env: Env): Promise<number> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/uploads?user_id=eq.${uid}&select=size`, { headers: svc(env) });
  if (!res.ok) throw new Error('usage query failed');
  const rows = (await res.json()) as { size: number | string }[];
  return rows.reduce((n, r) => n + Number(r.size), 0);
}

const svc = (env: Env) => ({ apikey: env.SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}` });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function withCors(res: Response, corsHeaders: Record<string, string>): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
function cors(env: Env, origin: string | null): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = origin && (allowed.includes('*') || allowed.includes(origin)) ? origin : (allowed[0] || '*');
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-share-meta',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
