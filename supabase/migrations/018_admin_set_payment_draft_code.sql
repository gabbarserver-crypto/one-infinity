-- Admin-only: attach a Draft No to a PAYMENT ledger row.
-- A payment's Draft No is not stored on ledger_entries itself; it comes from the
-- application the payment is linked to (ledger_entries.source_application_id ->
-- applications.draft_code). So "filling the draft no" = linking the payment to
-- that application. Blank input un-links it.
-- Direct client writes to ledger_entries are blocked by RLS, hence SECURITY DEFINER.

create or replace function set_ledger_entry_draft_code(p_entry_id uuid, p_draft_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry   ledger_entries%rowtype;
  v_app     applications%rowtype;
  v_code    text := upper(nullif(trim(p_draft_code), ''));
begin
  if not exists (
    select 1 from staff s
    join roles r on r.id = s.role_id
    where s.auth_user_id = auth.uid() and r.role_name = 'Admin'
  ) then
    raise exception 'Only Admin can change a draft no';
  end if;

  select * into v_entry from ledger_entries where id = p_entry_id;
  if not found then raise exception 'Ledger entry not found'; end if;
  if v_entry.entry_type <> 'PAYMENT' then
    raise exception 'Draft no can only be set on PAYMENT rows';
  end if;

  if v_code is null then
    update ledger_entries set source_application_id = null where id = p_entry_id;
    return null;
  end if;

  select * into v_app from applications where upper(draft_code) = v_code limit 1;
  if not found then raise exception 'No application found with Draft No %', v_code; end if;

  if v_entry.dealer_id is not null and v_app.dealer_id is distinct from v_entry.dealer_id then
    raise exception 'Draft No % belongs to a different dealer', v_code;
  end if;

  update ledger_entries set source_application_id = v_app.id where id = p_entry_id;
  return v_app.draft_code;
end;
$$;

grant execute on function set_ledger_entry_draft_code(uuid, text) to authenticated;
