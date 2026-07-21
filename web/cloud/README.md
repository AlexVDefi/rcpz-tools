# Optional online sharing - setup

This wires up the **optional** "Share online" feature: signed-in users render a PNG/GIF/MP4 and
get a shareable URL, capped at **100 MB per user**. It is entirely opt-in - if the three
`VITE_` env vars are unset, the app builds with `connect-src 'self'` and is 100% local.

Pieces:

- **Supabase** - email/password auth + an `uploads` table (row-level security so each user only
  sees their own rows). Source of truth for the "your shares" list and usage bar.
- **Cloudflare R2** - stores the rendered files.
- **Cloudflare Worker** (`worker/`) - verifies the Supabase token, enforces the 100 MB cap,
  writes to R2, records the row, and serves files publicly at `/f/<key>`. Holds all secrets.

```
browser ── PUT render + Supabase JWT ──▶ Worker ──▶ R2 (store)  + Supabase (record row)
browser ◀──────── share URL ─────────── Worker
anyone  ── GET /f/<key> ──────────────▶ Worker ──▶ R2 (stream)     ← the shareable link
```

## 1. Supabase

1. Create a project at https://supabase.com.
2. **SQL editor** → paste and run [`supabase/schema.sql`](./supabase/schema.sql).
3. **Authentication → Providers → Email**: keep it enabled. Decide on "Confirm email":
   - On (default): new users must click a link in their email before they can sign in. The app
     shows "check your email to confirm".
   - Off: users can sign in immediately after sign-up (simpler for testing).
4. **Project Settings → API** - copy these:
   - `Project URL` → `SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE` (secret - server only, never in the web app)

## 2. Cloudflare R2

1. In the Cloudflare dashboard → **R2** → create a bucket, e.g. `pz-studio-shares`
   (or `wrangler r2 bucket create pz-studio-shares`).
2. You do **not** need to make the bucket public - the Worker serves reads.

## 3. Worker (`worker/`)

```bash
cd web/cloud/worker
npm install
```

Edit `wrangler.toml`:
- `bucket_name` → your R2 bucket name.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` → from step 1.
- `ALLOWED_ORIGINS` → your deployed app origin(s), comma-separated, plus `http://localhost:5173`
  for local dev, e.g. `https://your-app.vercel.app,http://localhost:5173`.

Set the service-role secret (not stored in the repo):

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE   # paste the service_role key
npx wrangler deploy
```

Then map your **custom domain** to the Worker: dashboard → **Workers & Pages → pz-studio-cloud
→ Settings → Domains & Routes → Add** (e.g. `share.yourdomain.com`). That URL is your
`VITE_CLOUD_API`.

## 4. Web app env

Local: copy `web/.env.example` to `web/.env.local` and fill in:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
VITE_CLOUD_API=https://share.yourdomain.com
```

On **Vercel**: add the same three vars in Project Settings → Environment Variables, then redeploy.

The build-time meta-tag CSP picks these up automatically and widens `connect-src` to exactly the
Supabase project + your Worker origin. The static header CSP (in the vercel.json files) must allow
the same origins, since production enforces both the header and the meta tag. Keep the
`connect-src` line's Worker origin in sync with `VITE_CLOUD_API`; the `https://*.supabase.co` entry
already covers any Supabase project. (Note: `vercel.json` cannot contain comments - Vercel rejects
any unknown key such as `$comment`.)

### Where the app builds from (the two vercel.json files)

`web/` imports `../shared`, so the build must see the repo root. Two supported setups:

- **Root Directory empty (recommended).** The **repo-root [`vercel.json`](../../vercel.json)**
  builds `web/` from the root (`cd web && npm install|run build`, output `web/dist`) so `../shared`
  resolves. No extra Vercel toggle needed.
- **Root Directory = `web`.** Then Vercel reads [`web/vercel.json`](../vercel.json) instead, and you
  must enable **Settings → Build and Deployment → Root Directory → "Include files outside of the
  Root Directory in the Build Step"** (the checkbox appears only after you set the Root Directory).

Both files carry the same security headers; keep their `connect-src` in sync.

## 5. Verify

1. Local: `npm run dev` in `web/`, open the Scene tab → Export studio → "Share online".
2. Sign up, confirm if required, sign in.
3. Click a Share button - you should get a URL under your custom domain that opens the render.
4. Check the usage bar moves and the file appears under "Your shares"; delete it and confirm the
   bar drops back.

## Raising the limit

The 100 MB cap lives in two places that must match: `QUOTA_BYTES` in `worker/wrangler.toml`
(enforced) and `QUOTA_BYTES` in `web/src/cloud/config.ts` (displayed). Update both.
