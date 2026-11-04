-- 022_pcc_no_entered_at.sql
--
-- Remembers the day a PCC No was FIRST written on an application. The Ledger >
-- Bank tab uses it as the PCC Fee date when the PCC portal sync hasn't given
-- one yet (order: portal "Application Submitted" date -> this -> application
-- date -> submitted date).
--
-- Run once in the Supabase SQL editor. Safe to deploy the frontend before or
-- after — the Bank tab works either way.

alter table applications
  add column if not exists pcc_no_entered_at timestamptz;

create or replace function set_pcc_no_entered_at()
returns trigger
language plpgsql
as $$
begin
  if coalesce(trim(new.pcc_no), '') <> ''
     and (tg_op = 'INSERT' or coalesce(trim(old.pcc_no), '') = '')
     and new.pcc_no_entered_at is null then
    new.pcc_no_entered_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_pcc_no_entered_at on applications;
create trigger trg_set_pcc_no_entered_at
  before insert or update on applications
  for each row
  execute function set_pcc_no_entered_at();

-- Optional backfill for existing rows: use when the PCC fee/No was recorded.
-- Rows without a portal date then fall back to the application date instead.
