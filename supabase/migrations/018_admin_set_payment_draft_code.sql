-- Payments carry their OWN draft no (same numbering sequence as applications,
-- but a payment's number is not an application). Stored directly on the
-- ledger row, no link to applications.

alter table ledger_entries add column if not exists payment_draft_no text;

-- One-time fill: imported payments already have the draft no in reference_no
-- (e.g. AJ541, MA211). Copy it over where it looks like a draft code.
update ledger_entries
set payment_draft_no = upper(trim(reference_no))
where entry_type = 'PAYMENT'
  and payment_draft_no is null
  and trim(reference_no) ~ '^[A-Za-z]+[0-9]+$';

-- Admin-only editor used by the Ledger page (blank clears it).
create or replace function set_ledger_entry_draft_code(p_entry_id uuid, p_draft_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(nullif(trim(p_draft_code), ''));
begin
  if not exists (
    select 1 from staff s
    join roles r on r.id = s.role_id
    where s.auth_user_id = auth.uid() and r.role_name = 'Admin'
  ) then
    raise exception 'Only Admin can change a draft no';
  end if;

  update ledger_entries
  set payment_draft_no = v_code
  where id = p_entry_id and entry_type = 'PAYMENT';
  if not found then raise exception 'Payment ledger entry not found'; end if;

  return v_code;
end;
$$;

grant execute on function set_ledger_entry_draft_code(uuid, text) to authenticated;
