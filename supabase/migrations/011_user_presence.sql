-- 011_user_presence.sql
-- Run once in the Supabase SQL editor.
--
-- Backs the "last seen" text in chats. "Online right now" does NOT need this
-- table (it uses Supabase Realtime Presence); this only remembers WHEN each
-- person was last active so it can be shown once they go offline.
-- Without it the app still shows the green online dot, just no "last seen".

create table if not exists public.user_presence (
  user_key   text primary key,            -- 'staff:<id>' | 'dealer:<id>' | 'dealer_staff:<id>'
  user_type  text not null check (user_type in ('staff', 'dealer', 'dealer_staff')),
  user_id    text not null,
  dealer_id  text,                        -- set for dealer + dealer_staff, null for staff
  last_seen  timestamptz not null default now()
);

create index if not exists user_presence_dealer_idx on public.user_presence (dealer_id);

alter table public.user_presence enable row level security;

-- Our staff can see everyone's last-seen.
drop policy if exists "staff read all presence" on public.user_presence;
create policy "staff read all presence" on public.user_presence
  for select to authenticated
  using (exists (select 1 from public.staff s where s.auth_user_id = auth.uid()));

-- Dealers / dealer sub-staff can only see OUR staff's last-seen (never other dealers').
drop policy if exists "dealers read staff presence" on public.user_presence;
create policy "dealers read staff presence" on public.user_presence
  for select to authenticated
  using (user_type = 'staff');

-- Everyone can write ONLY their own row.
drop policy if exists "write own presence" on public.user_presence;
create policy "write own presence" on public.user_presence
  for all to authenticated
  using (
    (user_type = 'staff'        and exists (select 1 from public.staff s where s.id::text = user_id and s.auth_user_id = auth.uid()))
 or (user_type = 'dealer'       and exists (select 1 from public.dealers d where d.id::text = user_id and d.auth_user_id = auth.uid()))
 or (user_type = 'dealer_staff' and exists (select 1 from public.dealer_staff ds where ds.id::text = user_id and ds.auth_user_id = auth.uid()))
  )
  with check (
    (user_type = 'staff'        and exists (select 1 from public.staff s where s.id::text = user_id and s.auth_user_id = auth.uid()))
 or (user_type = 'dealer'       and exists (select 1 from public.dealers d where d.id::text = user_id and d.auth_user_id = auth.uid()))
 or (user_type = 'dealer_staff' and exists (select 1 from public.dealer_staff ds where ds.id::text = user_id and ds.auth_user_id = auth.uid()))
  );
