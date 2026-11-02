-- Lets an Admin change an APPLICATION's draft no straight from the Ledger page
-- (payment rows already have set_ledger_entry_draft_code, see 018).
--
-- Changes applications.draft_code, refuses a number another application of the
-- same dealer already uses, and keeps any ledger voucher_no that carries the
-- old number ("<code>" and "<code>-AGENCYFEE") pointing at the new one, so
-- nothing on the ledger loses its link.
--
-- Run this once in the Supabase SQL editor.

create or replace function set_application_draft_code(p_application_id uuid, p_draft_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code   text := upper(nullif(trim(p_draft_code), ''));
  v_old    text;
  v_dealer uuid;
begin
  if not exists (
    select 1 from staff s
    join roles r on r.id = s.role_id
    where s.auth_user_id = auth.uid() and r.role_name = 'Admin'
  ) then
    raise exception 'Only Admin can change a draft no';
  end if;

  if v_code is null then
    raise exception 'Draft no can''t be empty for an application';
  end if;

  select draft_code, dealer_id into v_old, v_dealer
  from applications where id = p_application_id;
  if not found then
    raise exception 'Application not found';
  end if;

  if v_old is not distinct from v_code then
    return v_code;
  end if;

  if exists (
    select 1 from applications
    where dealer_id = v_dealer and draft_code = v_code and id <> p_application_id
  ) then
    raise exception '% is already used by another application of this dealer', v_code;
  end if;

  update applications set draft_code = v_code where id = p_application_id;

  if v_old is not null and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ledger_entries' and column_name = 'voucher_no'
  ) then
    update ledger_entries set voucher_no = v_code
     where source_application_id = p_application_id and voucher_no = v_old;
    update ledger_entries set voucher_no = v_code || '-AGENCYFEE'
     where source_application_id = p_application_id and voucher_no = v_old || '-AGENCYFEE';
  end if;

  return v_code;
end;
$$;

grant execute on function set_application_draft_code(uuid, text) to authenticated;
