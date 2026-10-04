import { decryptSecret, encryptSecret } from "./secure-tokens.mjs";
import { supabaseRest } from "./supabase-server.mjs";
import { refreshGmailAccessToken } from "./gmail-live.mjs";

export async function getGmailIntegration(token, userId) {
  const rows = await supabaseRest(
    "integrations?select=*&user_id=eq." + encodeURIComponent(userId) + "&provider=eq.google_gmail&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

export async function getFreshGmailAccessToken(token, userId) {
  const integration = await getGmailIntegration(token, userId);
  if (!integration?.refresh_token_encrypted) {
    throw new Error("Connect Gmail before syncing invoices");
  }

  const expiry = integration.token_expires_at ? Date.parse(integration.token_expires_at) : 0;
  if (expiry > Date.now() + 60_000 && integration.access_token_encrypted) {
    return { integration, accessToken: decryptSecret(integration.access_token_encrypted) };
  }

  const refreshToken = decryptSecret(integration.refresh_token_encrypted);
  if (!refreshToken) throw new Error("Gmail authorization must be renewed");

  const fresh = await refreshGmailAccessToken(refreshToken);
  const patch = {
    access_token_encrypted: encryptSecret(fresh.access_token),
    token_expires_at: new Date(Date.now() + Number(fresh.expires_in || 3600) * 1000).toISOString(),
    status: "connected",
    updated_at: new Date().toISOString()
  };

  const updated = await supabaseRest(
    "integrations?id=eq." + encodeURIComponent(integration.id),
    { token, method: "PATCH", body: patch }
  );

  return { integration: updated?.[0] || { ...integration, ...patch }, accessToken: fresh.access_token };
}
