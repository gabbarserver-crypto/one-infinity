-- Run once in the Supabase SQL editor. OPTIONAL but recommended.
--
-- Backs api/chat/unread-summary.js: computes every unread count inside
-- Postgres and returns one small row per thread, instead of the server
-- downloading every chat message just to count them. Without it the
-- endpoint still works (paged JS fallback) but gets slower as chat grows.
--
-- p_reader_type : 'staff' | 'dealer' | 'dealer_staff'   (the caller)
-- p_reader_id   : the caller's id, as text
-- p_dealer_id   : NULL for staff (all threads), otherwise the dealer's id as text
--
-- Ids are compared as text so this doesn't depend on whether the columns
-- are uuid or text. Unread = messages not sent by the caller that arrived
-- after the caller's own last_read_at for that thread (or all of them if
-- they never opened it) -- same rule the JS implementation uses.
create or replace function public.chat_unread_counts(
  p_reader_type text,
  p_reader_id   text,
  p_dealer_id   text default null
)
returns table (thread_id text, unread bigint)
language sql
stable
as $$
  select t.id::text as thread_id, count(*)::bigint as unread
  from public.chat_threads t
  join public.chat_messages m
    on m.thread_id = t.id
  left join public.chat_thread_reads_by_identity r
    on r.thread_id = t.id
   and r.reader_type = p_reader_type
   and r.reader_id::text = p_reader_id
  where (p_dealer_id is null or t.dealer_id::text = p_dealer_id)
    and not (m.sender_type = p_reader_type and m.sender_id::text = p_reader_id)
    and (r.last_read_at is null or m.created_at > r.last_read_at)
  group by t.id;
$$;

-- Only the server (service-role key) may call this: it takes the reader's
-- identity as a parameter, so it must not be callable from the browser.
revoke all on function public.chat_unread_counts(text, text, text) from public, anon, authenticated;
grant execute on function public.chat_unread_counts(text, text, text) to service_role;
