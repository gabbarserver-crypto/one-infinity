-- Records which of OUR staff keyed a draft in on a dealer's behalf, so the
-- Application History can show "by <staff name>" instead of the dealer's name.
-- Applications created by a dealer (or dealer staff) leave this NULL and keep
-- showing the dealer / dealer-staff name as before.
alter table applications
  add column if not exists created_by_admin_staff_id uuid references staff(id) on delete set null;
