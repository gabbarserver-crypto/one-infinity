-- 020_admin_only_dealer_change_and_dealer_transfer.sql
--
-- 1) Dealer change and Draft No change on an application are ADMIN ONLY,
--    enforced in the database (the UI in Applications.jsx also hides the
--    controls for non-admins, but the DB is the real lock).
--
-- 2) "Pay Dealer to Dealer": move a payment/balance from one dealer's ledger
--    to another dealer's ledger as two linked ledger_entries rows.
--
-- Run once in the Supabase SQL editor.
--
-- NOTE on ledger sign convention (same as webhook.js / upsert for payments):
--   ledger_entries.amount < 0  => payment RECEIVED from that dealer
--                                 (dealer's balance goes DOWN)
--   ledger_entries.amount > 0  => dealer's balance goes UP
-- So for a transfer FROM dealer A TO dealer B of Rs X:
--   dealer A row: amount = +X   (A's payment is taken away -> A owes more)
--   dealer B row: amount = -X   (B gets the payment credit -> B owes less)
-- Check one transfer on the Ledger page after running this; if your
-- dealer_ledger view shows the two sides the wrong way round, swap the signs
-- in record_dealer_transfer below.

-- ---------------------------------------------------------------- helpers
create or replace function current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from staff s
    join roles r on r.id = s.role_id
    where s.auth_user_id = auth.uid() and r.role_name = 'Admin'
  );
$$;

grant execute on function current_user_is_admin() to authenticated;

-- ------------------------------------------- 1) admin-only dealer / draft no
create or replace function enforce_admin_only_application_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.dealer_id is distinct from old.dealer_id
      or new.draft_code is distinct from old.draft_code)
     and auth.uid() is not null           -- service role / SQL editor are not blocked
     and not current_user_is_admin() then
    raise exception 'Only Admin can change the dealer or draft no of an application';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_admin_only_application_identity on applications;
create trigger trg_admin_only_application_identity
  before update on applications
  for each row
  execute function enforce_admin_only_application_identity();

-- --------------------------------------------- 2) dealer -> dealer transfer
alter table ledger_entries add column if not exists transfer_group_id uuid;
create index if not exists idx_ledger_entries_transfer_group on ledger_entries(transfer_group_id);

create or replace function record_dealer_transfer(
  p_from_dealer_id uuid,
  p_to_dealer_id   uuid,
  p_amount         numeric,
  p_entry_date     date default null,
  p_reference_no   text default null,
  p_remarks        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group    uuid := gen_random_uuid();
  v_from     text;
  v_to       text;
  v_date     date := coalesce(p_entry_date, (now() at time zone 'Asia/Kolkata')::date);
  v_short    text := upper(substr(replace(v_group::text, '-', ''), 1, 8));
  v_staff    uuid;
begin
  if not current_user_is_admin() then
    raise exception 'Only Admin can move a payment from one dealer to another';
  end if;
  if p_from_dealer_id is null or p_to_dealer_id is null then
    raise exception 'Both dealers are required';
  end if;
  if p_from_dealer_id = p_to_dealer_id then
    raise exception 'From and To dealer must be different';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than 0';
  end if;

  select name into v_from from dealers where id = p_from_dealer_id;
  select name into v_to   from dealers where id = p_to_dealer_id;
  if v_from is null or v_to is null then
    raise exception 'Dealer not found';
  end if;

  select id into v_staff from staff where auth_user_id = auth.uid();

  -- FROM dealer: balance goes up
  insert into ledger_entries (
    entry_code, entry_type, entry_date, dealer_id, amount, agency_paid_amount,
    payment_mode, reference_no, payer_name, remarks, received_by,
    submitted_by, transfer_group_id
  ) values (
    'TRF-' || v_short || '-OUT', 'PAYMENT', v_date, p_from_dealer_id, p_amount, 0,
    'Transfer', p_reference_no, 'Transfer to ' || v_to,
    coalesce(p_remarks, '') , v_staff, 'staff', v_group
  );

  -- TO dealer: balance goes down (payment credit)
  insert into ledger_entries (
    entry_code, entry_type, entry_date, dealer_id, amount, agency_paid_amount,
    payment_mode, reference_no, payer_name, remarks, received_by,
    submitted_by, transfer_group_id
  ) values (
    'TRF-' || v_short || '-IN', 'PAYMENT', v_date, p_to_dealer_id, -p_amount, 0,
    'Transfer', p_reference_no, 'Transfer from ' || v_from,
    coalesce(p_remarks, ''), v_staff, 'staff', v_group
  );

  return v_group;
end;
$$;

grant execute on function record_dealer_transfer(uuid, uuid, numeric, date, text, text) to authenticated;

-- Admin-only: remove both halves of a transfer together.
create or replace function delete_dealer_transfer(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not current_user_is_admin() then
    raise exception 'Only Admin can delete a dealer transfer';
  end if;
  delete from ledger_entries where transfer_group_id = p_group_id;
end;
$$;

grant execute on function delete_dealer_transfer(uuid) to authenticated;

-- Staff list of recent transfers for the Payments page (one row per transfer).
create or replace function list_dealer_transfers(p_limit int default 50)
returns table (
  transfer_group_id uuid,
  entry_date date,
  from_dealer text,
  to_dealer text,
  amount numeric,
  reference_no text,
  remarks text
)
language sql
stable
security definer
set search_path = public
as $$
  select o.transfer_group_id,
         o.entry_date,
         df.name,
         dt.name,
         o.amount,
         o.reference_no,
         nullif(o.remarks, '')
  from ledger_entries o
  join ledger_entries i on i.transfer_group_id = o.transfer_group_id and i.amount < 0
  join dealers df on df.id = o.dealer_id
  join dealers dt on dt.id = i.dealer_id
  where o.transfer_group_id is not null and o.amount > 0
  order by o.entry_date desc, o.created_at desc
  limit greatest(p_limit, 1);
$$;

grant execute on function list_dealer_transfers(int) to authenticated;
