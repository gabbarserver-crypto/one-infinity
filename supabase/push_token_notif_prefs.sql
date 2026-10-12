-- Run once in the Supabase SQL editor.
-- Per-device notification preferences (which kinds are on + quiet hours),
-- written by the app (src/lib/push.js) and read by the server before it sends
-- a push (api/_lib/push.js). Until this is run the server simply treats every
-- device as "everything on, no quiet hours" -- nothing breaks.
alter table public.push_tokens
  add column if not exists notif_prefs jsonb;

-- Shape: { "types": {"chat":true,"draft":true,"payment":true,"call":true},
--          "quiet": {"enabled":true,"start":"22:00","end":"07:00"},
--          "tz": "Asia/Kolkata" }
