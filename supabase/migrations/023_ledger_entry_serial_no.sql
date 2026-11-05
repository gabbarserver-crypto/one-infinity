-- 023_ledger_entry_serial_no.sql
--
-- Lets Admin edit the "Sr. No." shown in the AGENCY ledger. Until now that
-- number was only generated on screen. A stored value overrides the automatic
-- one for that row; rows without one keep the automatic number.
-- Run once in the Supabase SQL editor.

alter table ledger_entries add column if not exists serial_no integer;

-- Admin-only editor used by the Ledger page. Pass NULL to go back to automatic.
create or replace function set_ledger_entry_serial(p_entry_id uuid, p_serial integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from staff s
    join roles r on r.id = s.role_id
    where s.auth_user_id = auth.uid() and r.role_name = 'Admin'
  ) then
    raise exception 'Only Admin can change a Sr. No.';
  end if;

  if p_serial is not null and p_serial < 0 then
    raise exception 'Sr. No. cannot be negative';
  end if;

  update ledger_entries set serial_no = p_serial where id = p_entry_id;
  if not found then raise exception 'Ledger entry not found'; end if;

  return p_serial;
end;
$$;

grant execute on function set_ledger_entry_serial(uuid, integer) to authenticated;
