-- PZ Survivor Studio - cloud shares schema. Paste into the Supabase SQL editor and run.

create table if not exists public.uploads (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  key          text not null unique,          -- R2 object key: u/<user_id>/<uuid>.<ext>
  size         bigint not null,               -- stored size in bytes
  content_type text,
  kind         text,                          -- png | gif | mp4
  meta         jsonb,                          -- what the render depicts: equipped clothing/held + mod sources (see ShareMeta)
  created_at   timestamptz not null default now()
);

-- Existing installs: add the column if the table predates it.
alter table public.uploads add column if not exists meta jsonb;

create index if not exists uploads_user_idx on public.uploads(user_id);

alter table public.uploads enable row level security;

-- Users may READ only their own rows. This is what the app selects to render the "your shares"
-- list and the storage-usage bar.
drop policy if exists uploads_own_select on public.uploads;
create policy uploads_own_select on public.uploads
  for select using (auth.uid() = user_id);

-- No insert/update/delete policies on purpose: all writes go through the Worker using the
-- service_role key (which bypasses RLS). A client can never forge a size, insert a row for
-- another user, or delete someone else's share.


-- Modder hosting: a modder's consent to have their Workshop mod's assets hosted. Keyed by their
-- SteamID64 (from Steam sign-in), one row per (steamid, mod). Written ONLY by the Worker after it
-- re-verifies Steam ownership; the browser never touches this table (no RLS policies = no client
-- access), it reads/writes through the Worker's /steam/permission(s) endpoints.
create table if not exists public.mod_permissions (
  id              uuid primary key default gen_random_uuid(),
  steamid         text not null,                 -- SteamID64 of the verified mod owner
  publishedfileid text not null,                 -- Steam Workshop item id
  title           text,                          -- mod title (from Steam, not the client)
  status          text not null default 'allowed', -- 'allowed' | 'revoked'
  terms_version   int  not null default 1,
  consented_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (steamid, publishedfileid)              -- upsert target for /steam/permission
);

create index if not exists mod_permissions_steamid_idx on public.mod_permissions(steamid);

alter table public.mod_permissions enable row level security;
-- No policies on purpose: only the Worker (service_role) reads/writes this table.
