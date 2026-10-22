import { rejectPreviewRequest } from "../../lib/preview-boundary.mjs";
import { decryptSecret, encryptSecret } from "../../lib/secure-tokens.mjs";
import { supabaseRest } from "../../lib/supabase-server.mjs";
import { gmailStateCallbackUri } from "../../lib/gmail-oauth-origin.mjs";

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";

function cookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(";").map((part) => {
      const i = part.indexOf("=");
      return i === -1 ? [part.trim(), ""] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
    })
  );
}

export default async function handler(req, res) {
  if (rejectPreviewRequest(req, res, { blocked: true })) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }

  const clear = "inboxpay_google_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  try {
    if (req.query?.error) throw new Error("Google authorization was " + req.query.error);
    const raw = cookies(req).inboxpay_google_oauth;
    if (!raw) throw new Error("Gmail connection state expired. Please try again.");

    const session = JSON.parse(decryptSecret(raw));
    if (!Number.isFinite(session.expiresAt) || Date.now() >= session.expiresAt || session.state !== req.query?.state || !session.userToken) {
      throw new Error("Invalid Gmail connection state");
    }
    const redirectUri = gmailStateCallbackUri(req, session);

    const body = new URLSearchParams({
      code: String(req.query.code || ""),
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    });

    const tokenResponse = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) {
      throw new Error(tokens.error_description || tokens.error || "Google token exchange failed");
    }

    const userInfoResponse = await fetch(GOOGLE_USERINFO, {
      headers: { Authorization: "Bearer " + tokens.access_token }
    });
    const googleUser = await userInfoResponse.json();
    if (!userInfoResponse.ok || !googleUser.sub) {
      throw new Error("Unable to identify the connected Google account");
    }

    const userResponse = await fetch(
      (process.env.SUPABASE_URL || "https://ecportgmionyhlofyobc.supabase.co") + "/auth/v1/user",
      {
        headers: {
          apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
          Authorization: "Bearer " + session.userToken
        }
      }
    );
    const inboxUser = await userResponse.json();
    if (!userResponse.ok || !inboxUser?.id) throw new Error("InboxPay session expired during Gmail connection");

    const businesses = await supabaseRest(
      "businesses?select=id&owner_user_id=eq." + encodeURIComponent(inboxUser.id) + "&limit=1",
      { token: session.userToken }
    );
    const businessId = businesses?.[0]?.id;

    const existing = await supabaseRest(
      "integrations?select=id,provider_account_id,refresh_token_encrypted,status,updated_at&user_id=eq." + encodeURIComponent(inboxUser.id) + "&provider=eq.google_gmail&limit=1",
      { token: session.userToken }
    );

    const previous = existing?.[0];
    if (Object.hasOwn(session, "integrationVersion")) {
      const expected = session.integrationVersion;
      if ((previous?.id || null) !== (expected?.id || null) ||
          (previous && previous.updated_at !== expected.updatedAt)) {
        throw new Error("Gmail connection changed. Start a fresh connection.");
      }
    } else if (previous?.status === "revoked") {
      throw new Error("Gmail was disconnected. Start a fresh connection.");
    }

    // Google can omit a refresh token on repeat consent. Never carry one across mailboxes.
    const refreshTokenEncrypted = tokens.refresh_token ? encryptSecret(tokens.refresh_token)
      : previous?.status === "connected" && previous.provider_account_id === googleUser.sub
        ? previous.refresh_token_encrypted : null;
    if (!refreshTokenEncrypted) throw new Error("Google did not return offline Gmail access. Start a fresh connection and authorize access again.");

    const record = {
      user_id: inboxUser.id,
      provider: "google_gmail",
      provider_account_id: googleUser.sub,
      access_token_encrypted: encryptSecret(tokens.access_token),
      refresh_token_encrypted: refreshTokenEncrypted,
      token_expires_at: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString(),
      scopes: String(tokens.scope || "").split(" ").filter(Boolean),
      status: "connected",
      business_id: businessId || null,
      updated_at: new Date().toISOString()
    };

    if (existing?.[0]?.id) {
      const saved = await supabaseRest(
        "integrations?id=eq." + encodeURIComponent(existing[0].id) +
          "&user_id=eq." + encodeURIComponent(inboxUser.id) +
          "&updated_at=eq." + encodeURIComponent(existing[0].updated_at),
        { token: session.userToken, method: "PATCH", body: record }
      );
      if (!saved?.[0]) throw new Error("Gmail connection changed. Start a fresh connection.");
    } else {
      await supabaseRest("integrations", {
        token: session.userToken,
        method: "POST",
        body: { ...record, created_at: new Date().toISOString() }
      });
    }

    res.setHeader("Set-Cookie", clear);
    return res.redirect(302, "/?gmail=connected");
  } catch (error) {
    res.setHeader("Set-Cookie", clear);
    console.error("Gmail OAuth callback failed:", error);
    return res.redirect(302, "/?gmail=error&message=" + encodeURIComponent(error instanceof Error ? error.message : "Connection failed"));
  }
}
