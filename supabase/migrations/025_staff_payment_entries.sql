-- Staff-entered payments that wait for Admin verification.
--
-- Staff add a payment on the new "Payment Entry" tab. It is stored here as
-- 'Pending' and does NOT touch any ledger/balance. When Admin presses Verify,
-- verify_staff_payment_entry() creates the real payment + ledger entry exactly
-- the way Payments.jsx does (receipt no via next_payment_code, then
-- upsert_ledger_entry_for_payment). Reject just closes the entry with a reason.
--
-- Run this once in the Supabase SQL editor.

create table if not exists staff_payment_entries (
  id            uuid primary key default gen_random_uuid(),
  dealer_id     uuid not null references dealers(id) on delete cascade,
  amount        numeric not null check (amount > 0),
  payment_mode  text not null default 'Cash',
  reference_no  text,
  remarks       text,
  paid_on       date not null default current_date,
  status        text not null default 'Pending' check (status in ('Pending', 'Verified', 'Rejected')),
  entered_by    uuid references staff(id) on delete set null,
  entered_at    timestamptz not null default now(),
  verified_by   uuid references staff(id) on delete set null,
  verified_at   timestamptz,
  reject_reason text,
  payment_id    text -- id of the payments row created on verification
);

create index if not exists staff_payment_entries_status_idx on staff_payment_entries (status, entered_at desc);

alter table staff_payment_entries enable row level security;

-- Helpers kept inline so this file has no other dependencies.
drop policy if exists spe_select on staff_payment_entries;
create policy spe_select on staff_payment_entries for select to authenticated using (
  exists (select 1 from staff s join roles r on r.id = s.role_id
           where s.auth_user_id = auth.uid() and r.role_name = 'Admin')
  or entered_by in (select id from staff where auth_user_id = auth.uid())
);

drop policy if exists spe_insert on staff_payment_entries;
create policy spe_insert on staff_payment_entries for insert to authenticated with check (
  status = 'Pending'
  and entered_by in (select id from staff where auth_user_id = auth.uid())
);

-- A staff member may withdraw their own entry while it is still Pending.
drop policy if exists spe_delete on staff_payment_entries;
create policy spe_delete on staff_payment_entries for delete to authenticated using (
  status = 'Pending'
  and entered_by in (select id from staff where auth_user_id = auth.uid())
);

-- Verify: Admin only. Creates the real payment + ledger entry.
create or replace function verify_staff_payment_entry(p_entry_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin   uuid;
  e         staff_payment_entries%rowtype;
  v_receipt text;
  v_pay_id  payments.id%type;
begin
  select s.id into v_admin
    from staff s join roles r on r.id = s.role_id
   where s.auth_user_id = auth.uid() and r.role_name = 'Admin';
  if v_admin is null then
    raise exception 'Only Admin can verify a payment entry';
  end if;

  select * into e from staff_payment_entries where id = p_entry_id for update;
  if not found then raise exception 'Payment entry not found'; end if;
  if e.status <> 'Pending' then raise exception 'This entry is already %', lower(e.status); end if;

  if nullif(trim(e.reference_no), '') is not null
     and exists (select 1 from payments where reference_no = trim(e.reference_no)) then
    raise exception 'A payment with reference "%" already exists — check it is not already recorded', trim(e.reference_no);
  end if;

  v_receipt := next_payment_code(e.dealer_id);

  insert into payments (dealer_id, application_id, amount, payment_mode, reference_no, receipt_no, remarks, paid_at_agency_id, received_by, created_at)
  values (e.dealer_id, null, e.amount, e.payment_mode, nullif(trim(e.reference_no), ''), v_receipt, e.remarks, null, e.entered_by, e.paid_on::timestamptz)
  returning id into v_pay_id;

  perform upsert_ledger_entry_for_payment(v_pay_id);

  update staff_payment_entries
     set status = 'Verified', verified_by = v_admin, verified_at = now(), payment_id = v_pay_id::text
   where id = p_entry_id;

  return p_entry_id;
end;
$$;

create or replace function reject_staff_payment_entry(p_entry_id uuid, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid;
  v_status text;
begin
  select s.id into v_admin
    from staff s join roles r on r.id = s.role_id
   where s.auth_user_id = auth.uid() and r.role_name = 'Admin';
  if v_admin is null then
    raise exception 'Only Admin can reject a payment entry';
  end if;

  select status into v_status from staff_payment_entries where id = p_entry_id for update;
  if not found then raise exception 'Payment entry not found'; end if;
  if v_status <> 'Pending' then raise exception 'This entry is already %', lower(v_status); end if;

  update staff_payment_entries
     set status = 'Rejected', verified_by = v_admin, verified_at = now(), reject_reason = nullif(trim(p_reason), '')
   where id = p_entry_id;
  return p_entry_id;
end;
$$;

grant execute on function verify_staff_payment_entry(uuid) to authenticated;
grant execute on function reject_staff_payment_entry(uuid, text) to authenticated;

-- Permission module for the new tab. Staff role gets view+add by default;
-- every other role starts with nothing (Admin always sees it). Adjust in
-- Settings -> Permissions.
insert into permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_print, can_export)
select r.id, 'paymentEntry',
       lower(r.role_name) = 'staff', lower(r.role_name) = 'staff', false, false, false, false, false
  from roles r
 where not exists (select 1 from permissions p where p.role_id = r.id and p.module = 'paymentEntry');
