-- PZ Character Studio - cloud shares schema. Paste into the Supabase SQL editor and run.

create table if not exists public.uploads (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  key          text not null unique,          -- R2 object key: u/<user_id>/<uuid>.<ext>
  size         bigint not null,               -- stored size in bytes
  content_type text,
  kind         text,                          -- png | gif | mp4
  created_at   timestamptz not null default now()
);

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
