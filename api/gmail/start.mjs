import crypto from "node:crypto";
import { requireUser } from "../../lib/supabase-server.mjs";
import { encryptSecret } from "../../lib/secure-tokens.mjs";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const CALLBACK = "https://tameion-ap-agent-live.vercel.app/api/gmail/callback";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly"
].join(" ");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }

  try {
    const { token } = await requireUser(req);
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
      throw new Error("Gmail integration is not configured");
    }

    const state = crypto.randomBytes(32).toString("base64url");
    const payload = encryptSecret(JSON.stringify({
      state,
      userToken: token,
      expiresAt: Date.now() + 10 * 60 * 1000
    }));

    const query = new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      redirect_uri: CALLBACK,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      state
    });

    res.setHeader(
      "Set-Cookie",
      "inboxpay_google_oauth=" + payload +
        "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600"
    );
    return res.redirect(302, GOOGLE_AUTH + "?" + query.toString());
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unable to start Gmail connection" });
  }
}
