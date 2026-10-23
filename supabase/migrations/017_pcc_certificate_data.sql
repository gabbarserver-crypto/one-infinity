-- Stores the data the Delhi Police portal returns for an issued PCC
-- (pcc-certificate-data endpoint), minus the applicant photo. This is a record
-- of the portal's data, NOT the official certificate itself.
alter table public.applications
  add column if not exists pcc_certificate_data jsonb,
  add column if not exists pcc_certificate_data_fetched_at timestamptz;
