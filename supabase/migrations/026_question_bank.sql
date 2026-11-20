-- Question Bank: multiple-choice practice questions (RTO Learner/Driving
-- test style), shown on their own "Question Bank" tab with search.
--
-- Bulk-loaded from a CSV/Excel sheet shaped like:
--   S.NO, Q.NO, Question, Option 1, Option 2, Option 3, Option 4, Answer, Chapter
-- "chapter" and the sheet's own row number are kept (sr_no) even though the
-- tab itself only shows S.No / Question / Option 1-4 / Answer, so nothing
-- from the sheet is thrown away if a Chapter filter gets added later.
--
-- A question or option cell can hold an image instead of/alongside text --
-- either a bare image URL or markdown ![alt](url); the app renders whichever
-- it finds and search only ever matches the plain-text part.
--
-- Run this once in the Supabase SQL editor.

create table if not exists question_bank (
  id          uuid primary key default gen_random_uuid(),
  sr_no       integer,                          -- row/question number from the source sheet (reference only, not unique)
  question    text not null,
  option1     text not null,
  option2     text not null,
  option3     text not null,
  option4     text not null,
  answer      smallint not null check (answer between 1 and 4),
  chapter     text,
  created_at  timestamptz not null default now(),
  created_by  uuid references staff(id) on delete set null
);

create index if not exists question_bank_created_idx on question_bank (created_at desc);
-- Search is a client-side ILIKE-style filter over the small set of rows
-- already loaded, same as the DL/Learning/PCC tabs -- no server-side index
-- needed unless the bank grows into the tens of thousands.

alter table question_bank enable row level security;

-- Shared reference material: any signed-in staff member can read it.
drop policy if exists qb_select on question_bank;
create policy qb_select on question_bank for select to authenticated using (
  exists (select 1 from staff s where s.auth_user_id = auth.uid())
);

-- Only Admin can add/edit/bulk-import/delete questions.
drop policy if exists qb_insert on question_bank;
create policy qb_insert on question_bank for insert to authenticated with check (
  exists (select 1 from staff s join roles r on r.id = s.role_id
           where s.auth_user_id = auth.uid() and r.role_name = 'Admin')
);

drop policy if exists qb_update on question_bank;
create policy qb_update on question_bank for update to authenticated using (
  exists (select 1 from staff s join roles r on r.id = s.role_id
           where s.auth_user_id = auth.uid() and r.role_name = 'Admin')
);

drop policy if exists qb_delete on question_bank;
create policy qb_delete on question_bank for delete to authenticated using (
  exists (select 1 from staff s join roles r on r.id = s.role_id
           where s.auth_user_id = auth.uid() and r.role_name = 'Admin')
);

-- Permission module for the new tab. Every role starts with View only
-- (it's reference material, not something that needs gating); Admin always
-- sees it regardless. Adjust per role in Settings -> Permissions.
insert into permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_print, can_export)
select r.id, 'questionBank', true, false, false, false, false, false, false
  from roles r
 where not exists (select 1 from permissions p where p.role_id = r.id and p.module = 'questionBank');
