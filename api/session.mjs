import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";
import { getSupabaseServerSecret } from "../lib/supabase-server.mjs";
import { rejectPreviewRequest } from "../lib/preview-boundary.mjs";
import dataRequestRoute from "../lib/data-request-route.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (rejectPreviewRequest(req, res)) return;
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  if ((req.method === 'GET' && req.query?.view === 'data_requests')
    || (req.method === 'POST' && req.body?.action === 'request_data_removal')) return dataRequestRoute(req, res);
  if (req.method === "POST" && (req.body?.action !== "disconnect_gmail" || req.body?.confirm !== true)) {
    return res.status(400).json({ error: "Explicit Gmail disconnection confirmation is required" });
  }

  let authenticated = false;
  try {
    const { token, user } = await requireUser(req);
    authenticated = true;
    const business = await getBusiness(token, user.id);

    if (req.method === "POST") {
      if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
      // Keep the row and invoice references; remove credentials in one owner-scoped write.
      const rows = await supabaseRest(
        "integrations?user_id=eq." + encodeURIComponent(user.id) +
        "&or=(business_id.eq." + encodeURIComponent(business.id) + ",business_id.is.null)&provider=eq.google_gmail",
        { token, method: "PATCH", body: {
          status: "revoked", access_token_encrypted: null, refresh_token_encrypted: null,
          token_expires_at: null, provider_account_id: null, scopes: [], updated_at: new Date().toISOString()
        } }
      );
      const remaining = await supabaseRest(
        "integrations?select=id,status,access_token_encrypted,refresh_token_encrypted&user_id=eq." +
          encodeURIComponent(user.id) + "&provider=eq.google_gmail",
        { token }
      );
      if (!Array.isArray(rows) || !Array.isArray(remaining) || remaining.some(row =>
        row.status !== "revoked" || row.access_token_encrypted || row.refresh_token_encrypted)) {
        throw new Error("Gmail token removal could not be verified");
      }
      let auditRecorded = true;
      if (rows?.length) {
        try {
          await supabaseRest("audit_events", { token: getSupabaseServerSecret(), method: "POST", body: {
            user_id: user.id, business_id: business.id, network: business.active_network || business.wallet_blockchain || "ARC-TESTNET",
            event_type: "gmail_disconnected", actor: "user", data: { stored_tokens_removed: true, payment_authority_changed: false }
          } });
        } catch { auditRecorded = false; }
      }
      res.setHeader("Set-Cookie", "inboxpay_google_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
      return res.status(200).json({ gmail: null, storedTokensRemoved: true, auditRecorded,
        googleGrantRevoked: false, recordsDeleted: false, paymentAuthorityChanged: false });
    }

    const integrations = await supabaseRest(
      "integrations?select=id,provider,provider_account_id,status,scopes,token_expires_at&user_id=eq." +
        encodeURIComponent(user.id) + "&provider=eq.google_gmail&limit=1",
      { token }
    );

    return res.status(200).json({
      user: { id: user.id, email: user.email, name: user.user_metadata?.full_name || user.user_metadata?.name || "" },
      business,
      gmail: integrations?.[0] || null
    });
  } catch (error) {
    return res.status(authenticated ? 503 : 401).json({ error: authenticated ? "Account service unavailable. Please retry; disconnection is not confirmed." : "Authentication required. Sign in again to manage your Gmail connection." });
  }
}
