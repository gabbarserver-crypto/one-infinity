-- Run once in Supabase -> SQL Editor
-- null = dealer sees current year only (default), 0 = all time, 2025 = from 2025 onwards
alter table public.dealers
  add column if not exists visible_from_year integer;
