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

## 6. Email delivery via Resend (auth emails)

Password-reset and sign-up-confirmation emails are sent by **Supabase's own auth server**, not by
this app or the Worker. Supabase's built-in sender is heavily rate-limited and flagged
"not for production", so point it at **Resend** as a custom SMTP provider. Because Supabase sends
these emails, **the Resend API key lives in the Supabase dashboard, not in this repo** - there is
nothing to add to `.env.local`, `.env.example`, or `wrangler.toml`.

### a. Verify your sending domain in Resend

1. Resend dashboard → **Domains → Add Domain**. Use a subdomain you control for sending, e.g.
   `send.rcpz.tools` (keeps auth mail isolated from your root domain's reputation), or the apex
   `rcpz.tools`.
2. Add the exact DNS records Resend shows you at your DNS host. There are typically three or four:
   a **DKIM** record (signs the mail), an **SPF** `TXT` record, an **MX** record for bounce
   handling, and optionally a **DMARC** `TXT`. Copy the values verbatim from Resend - the DKIM key
   and bounce host are unique to your domain.
3. Wait until Resend marks the domain **Verified** (usually minutes; DNS can take longer).
4. Resend → **API Keys → Create API Key**. Give it **Sending access** and, if offered, scope it to
   the verified domain. Copy the key (`re_...`); you only see it once.

### b. Point Supabase at Resend (Custom SMTP)

Supabase dashboard → **Authentication → Emails → SMTP Settings** → enable **Custom SMTP** and fill
in exactly:

```
Sender email    noreply@send.rcpz.tools     # must be on the domain you verified in Resend
Sender name     PZ Survivor Studio
Host            smtp.resend.com
Port            465                          # implicit TLS; 587 (STARTTLS) also works
Username        resend                       # literally the word "resend"
Password        re_...                       # the Resend API key from step (a)
```

Save. Then raise **Authentication → Rate Limits → "Emails sent per hour"** above the tiny default,
now that a real provider is handling delivery.

### c. Make the reset link return to the app

Supabase → **Authentication → URL Configuration**. Set **Site URL** to your production origin and
add every app origin to **Redirect URLs** (e.g. `https://survivor.rcpz.tools` and
`http://localhost:5173`). The "Forgot password?" flow emails a link back to `window.location.origin`;
if that origin is not allowlisted, Supabase falls back to the Site URL and the in-app
"Set a new password" step (the `PASSWORD_RECOVERY` event) won't fire on localhost.

### d. Optional: customise the email copy

Supabase → **Authentication → Emails → Templates** - edit the "Reset Password" and "Confirm signup"
bodies. Keep the `{{ .ConfirmationURL }}` variable intact; that is the link the app depends on.

### e. Test

In the app: **Sign in → Forgot password → enter your email**. The email should arrive **from your
domain** (not `supabase.io`). Open the link - you should land back on the app with the
"Set a new password" modal. Then in the account menu, try **Change password** to confirm the
signed-in path.

> Want fully branded emails (your own HTML/React Email templates sent through Resend's API rather
> than Supabase's default layout)? That uses Supabase's **Send Email Hook** pointing at a function
> (a Supabase Edge Function or a Worker route) that calls the Resend API. That path *does* need a
> `RESEND_API_KEY` secret plus the hook's signing secret. It's not required for reset/confirm to
> work - ask if you want it wired up.

## Updating an existing deployment

The "Shared" tab, the custom share viewer, and account deletion need three things rolled out
together:

1. **Supabase** - re-run [`supabase/schema.sql`](./supabase/schema.sql). It is idempotent and adds
   the new `uploads.meta` column (`alter table ... add column if not exists`) without touching
   existing rows. No RLS change: `meta` is read under the same owner-only select policy.
2. **Worker** - `npx wrangler deploy`. This ships the new `DELETE /account` endpoint (permanent
   account + shared-item deletion) and the `X-Share-Meta` passthrough on `/upload`. Account
   deletion uses the existing `SUPABASE_SERVICE_ROLE` secret to call the Supabase admin API, so no
   new secret is required.
3. **Web app / CSP** - redeploy on Vercel. The share viewer loads renders inline, so `img-src` and
   `media-src` in both `vercel.json` files (and the build-time meta CSP) now include the Worker
   origin. Keep them in sync with `VITE_CLOUD_API` the same way as `connect-src`.

## Raising the limit

The 100 MB cap lives in two places that must match: `QUOTA_BYTES` in `worker/wrangler.toml`
(enforced) and `QUOTA_BYTES` in `web/src/cloud/config.ts` (displayed). Update both.
