// api/games-handoff.js
//
// One-time hand-off of a signed-in session to the Games app (a separate
// Vercel deployment). Replaces putting the access + refresh tokens in the
// Games URL's query string, where they leak through browser history, server
// logs and Referer headers (and the refresh token is long-lived).
//
// Flow:
//   1. Dashboard (signed in) -> POST { action: "create", accessToken, refreshToken }
//      -> { code }   A random 256-bit code. Only its SHA-256 is stored,
//                    together with the tokens, for 60 seconds.
//   2. Dashboard opens  GAMES_URL?code=<code>
//   3. Games app -> POST { action: "redeem", code }
//      -> { accessToken, refreshToken }   The row is DELETED in the same
//                    statement that returns it, so a code works exactly once,
//                    and only within 60 s. Then it calls
//                    supabase.auth.setSession({ access_token, refresh_token }).
//
// Needs the table in sql/auth_handoff_codes.sql (run once in Supabase).
//
// Games app side (sjo-supabase-sync.js on the games site), replacing the old ?at=...&rt=... handling:
//
//   const code = new URLSearchParams(location.search).get("code");
//   if (code) {
//     history.replaceState(null, "", location.pathname);   // drop it from the URL
//     const r = await fetch("https://1infinity.online/api/games-handoff", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ action: "redeem", code }),
//     });
//     if (r.ok) {
//       const { accessToken, refreshToken } = await r.json();
//       await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
//     }
//   }
import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin } from "./_lib/adminAuth.js";
import { applyCors } from "./_lib/cors.js";

const CODE_TTL_MS = 60 * 1000;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export default async function handler(req, res) {
  if (applyCors(req, res)) return; // preflight handled (the Games app is cross-origin)

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!supabaseAdmin) return res.status(500).json({ error: "Server isn't configured with SUPABASE_SERVICE_ROLE_KEY" });

  try {
    const { action, accessToken, refreshToken, code } = req.body || {};

    if (action === "create") {
      if (typeof accessToken !== "string" || typeof refreshToken !== "string" || accessToken.length > 4096 || refreshToken.length > 1024) {
        return res.status(400).json({ error: "accessToken and refreshToken are required" });
      }
      // The access token must be a real, currently valid session.
      const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
      if (userErr || !userData?.user) return res.status(403).json({ error: "Not signed in" });

      // Opportunistic cleanup of codes nobody redeemed.
      await supabaseAdmin.from("auth_handoff_codes").delete().lt("expires_at", new Date().toISOString());

      const newCode = randomBytes(32).toString("base64url");
      const { error: insertErr } = await supabaseAdmin.from("auth_handoff_codes").insert({
        code_hash: sha256(newCode),
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      });
      if (insertErr) {
        console.error("games-handoff create failed:", insertErr.message);
        return res.status(500).json({ error: "Could not create hand-off code" });
      }
      return res.json({ code: newCode });
    }

    if (action === "redeem") {
      if (typeof code !== "string" || code.length < 20 || code.length > 128) {
        return res.status(400).json({ error: "Invalid code" });
      }
      // Single statement: delete-and-return, so two simultaneous redeems can
      // never both succeed.
      const { data, error } = await supabaseAdmin
        .from("auth_handoff_codes")
        .delete()
        .eq("code_hash", sha256(code))
        .gt("expires_at", new Date().toISOString())
        .select("access_token, refresh_token")
        .maybeSingle();
      if (error) {
        console.error("games-handoff redeem failed:", error.message);
        return res.status(500).json({ error: "Could not redeem code" });
      }
      if (!data) return res.status(410).json({ error: "Code is invalid, expired or already used" });
      return res.json({ accessToken: data.access_token, refreshToken: data.refresh_token });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error("games-handoff failed:", e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
