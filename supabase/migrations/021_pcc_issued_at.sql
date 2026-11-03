-- 021_pcc_issued_at.sql
--
-- Remembers WHEN an application's PCC status turned to "Certificate Issued",
-- so the PCC page can pin freshly issued rows on top with a NEW badge.
-- A trigger sets it, so every path is covered (bulk check, single check,
-- auto-sync cron, certificate upload, manual status change).
--
-- Run once in the Supabase SQL editor, BEFORE deploying the new PccApplications.jsx.

alter table applications
  add column if not exists pcc_issued_at timestamptz;

create or replace function set_pcc_issued_at()
returns trigger
language plpgsql
as $$
begin
  if new.pcc_status = 'Certificate Issued'
     and new.pcc_status is distinct from old.pcc_status then
    new.pcc_issued_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_pcc_issued_at on applications;
create trigger trg_set_pcc_issued_at
  before update on applications
  for each row
  execute function set_pcc_issued_at();
