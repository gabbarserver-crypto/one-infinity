-- Run once in the Supabase SQL editor.
-- Backing table for api/games-handoff.js (one-time session hand-off to the
-- Games app). Only the server (service-role key) ever touches it: RLS is on
-- and there are deliberately NO policies, so anon/authenticated clients can't
-- read or write it.
create table if not exists public.auth_handoff_codes (
  code_hash     text primary key,          -- SHA-256 of the one-time code
  access_token  text not null,
  refresh_token text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

create index if not exists auth_handoff_codes_expires_at_idx
  on public.auth_handoff_codes (expires_at);

alter table public.auth_handoff_codes enable row level security;
