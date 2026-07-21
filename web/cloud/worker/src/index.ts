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
//   GET    /f/<key>             public: stream the object from R2 (this is the shareable link).
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
    if (request.method === 'POST' && url.pathname === '/upload') return withCors(await upload(request, url, env), corsHeaders);
    if (request.method === 'DELETE' && url.pathname === '/object') return withCors(await remove(request, url, env), corsHeaders);
    if (request.method === 'DELETE' && url.pathname === '/account') return withCors(await deleteAccount(request, env), corsHeaders);
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
    'access-control-allow-methods': 'POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-share-meta',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
