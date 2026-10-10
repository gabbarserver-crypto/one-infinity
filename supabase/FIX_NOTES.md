# Fix: agora-token 500 / "Cannot read properties of undefined"

## Root cause
`FUNCTION_INVOCATION_FAILED` (visible in your Network tab, "Response" tab)
is Vercel's generic crash page for when a serverless function throws an
error that's never caught — not a normal error response from your own
code. Your `agora-token.js` DID have error handling for missing config,
but nothing wrapped `resolveCaller(accessToken)` — and `resolveCaller()`
itself, in `api/_lib/adminAuth.js`, called `supabaseAdmin.auth.getUser(accessToken)`
completely unguarded.

If a request arrives with a stale, expired, or malformed access token
(easy to hit — e.g. the app was left open overnight, or a call is placed
right as the session refreshes), that call can throw instead of returning
`{ error }` — and since nothing catches it, Node/Vercel kills the whole
function with the opaque page you saw. Every other `/api/*` endpoint that
calls `resolveCaller()` unguarded (agora-token, send-push,
create-dealer-staff-login, admin/create-dealer-login) had the same latent
bug — the screenshot just happened to catch it on the calling feature
first.

**Update:** the "Cannot read properties of undefined (reading 'replace')"
banner turned out to be a *different* bug, not this one — it's an Android
WebView permission quirk (Microphone allowed in Android Settings isn't
enough on its own for a WebView's `getUserMedia()`). See
`android-webrtc-permissions/README.md` for the fix and the native files to
drop in.

## The fix
1. **`api/_lib/adminAuth.js`** — `resolveCaller()` now wraps its body in
   try/catch and returns `null` on any failure instead of throwing. This
   is the single most important fix since EVERY endpoint depends on it.
2. **`api/agora-token.js`**, **`api/send-push.js`**,
   **`api/create-dealer-staff-login.js`**, **`api/admin/create-dealer-login.js`**
   — each handler body now fully wrapped in try/catch too, as defense in
   depth, so ANY future unexpected error (not just from resolveCaller)
   returns a normal JSON 500 with a real message instead of crashing.

`api/pcc-status/check.js` and `sync-all.js` were already correctly
wrapped — not touched.

## What you'll see now instead
Next time something like this happens, instead of the blank
"FUNCTION_INVOCATION_FAILED" page, you'll get a real JSON response like
`{ "error": "..." }` with an actual message — both in the Network tab
Response, and in Vercel's function logs (Vercel dashboard → your project →
Deployments → the active one → Functions → click the function → Logs).
That's the fastest way to nail down anything that still slips through.

## Files
- `api/_lib/adminAuth.js`
- `api/agora-token.js`
- `api/send-push.js`
- `api/create-dealer-staff-login.js`
- `api/admin/create-dealer-login.js`
