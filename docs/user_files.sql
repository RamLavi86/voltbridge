-- Run once in the Supabase SQL editor. Holds each signed-in user's projects so they survive server restarts.
create table if not exists public.user_files (
  user_id text not null,
  path text not null,
  data text not null,                       -- file contents, base64
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);
alter table public.user_files enable row level security;  -- no policies: only the server's secret key can read or write
grant select, insert, update, delete on public.user_files to service_role;
