-- Adds an Active / Inactive switch to each service (Masters -> Service).
-- Inactive services are hidden from the "new application" service pickers
-- but stay in the database, so old applications and reports that point at
-- them keep working. Defaults to true, so every existing service stays active.
--
-- Run this once in the Supabase SQL editor.

alter table services
  add column if not exists is_active boolean not null default true;
