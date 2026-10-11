import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "./secure-tokens.mjs";
import { getBearerToken, requireUser, supabaseAdminRest } from "./supabase-server.mjs";
import { getBusiness } from "./businesses.mjs";

const HANDOFF_TTL_MS = 10 * 60 * 1000;
const TOKEN_PREFIX = "oph_";

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function expiryIso() {
  return new Date(Date.now() + HANDOFF_TTL_MS).toISOString();
}

export async function createOperatorHandoff(req) {
  const { token, user } = await requireUser(req);
  const business = await getBusiness(token, user.id);
  if (!business) throw new Error("Complete business onboarding first");

  const rawToken = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const expiresAt = expiryIso();

  await supabaseAdminRest(
    "operator_handoffs?user_id=eq." + encodeURIComponent(user.id) + "&revoked_at=is.null",
    {
      method: "PATCH",
      body: { revoked_at: new Date().toISOString() }
    }
  );

  await supabaseAdminRest("operator_handoffs", {
    method: "POST",
    body: {
      user_id: user.id,
      business_id: business.id,
      token_hash: hashToken(rawToken),
      session_token_encrypted: encryptSecret(token),
      scope: "rehearsal_read_refresh",
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    }
  });

  return {
    operatorToken: rawToken,
    expiresAt,
    scope: "rehearsal_read_refresh",
    business: {
      id: business.id,
      name: business.name,
      walletAddress: business.wallet_address,
      network: business.wallet_blockchain
    }
  };
}

export async function requireOperatorHandoff(req) {
  const rawToken = getBearerToken(req);
  if (!rawToken?.startsWith(TOKEN_PREFIX)) throw new Error("Operator handoff required");

  const rows = await supabaseAdminRest(
    "operator_handoffs?select=*&token_hash=eq." + encodeURIComponent(hashToken(rawToken)) + "&revoked_at=is.null&expires_at=gt." + encodeURIComponent(new Date().toISOString()) + "&limit=1"
  );
  const handoff = rows?.[0];
  if (!handoff) throw new Error("Operator handoff is invalid, expired, or revoked");
  if (handoff.scope !== "rehearsal_read_refresh") throw new Error("Operator handoff scope is not permitted");

  const sessionToken = decryptSecret(handoff.session_token_encrypted);
  const userResponse = await fetch(
    (process.env.SUPABASE_URL || "https://ecportgmionyhlofyobc.supabase.co") + "/auth/v1/user",
    {
      headers: {
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: "Bearer " + sessionToken
      }
    }
  );
  const user = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !user?.id || user.id !== handoff.user_id) {
    throw new Error("The InboxPay session attached to this handoff is no longer valid");
  }

  await supabaseAdminRest("operator_handoffs?id=eq." + encodeURIComponent(handoff.id), {
    method: "PATCH",
    body: { last_used_at: new Date().toISOString() }
  });

  return { token: sessionToken, user, handoff };
}

export async function revokeOperatorHandoffs(userToken, userId) {
  await supabaseAdminRest(
    "operator_handoffs?user_id=eq." + encodeURIComponent(userId) + "&revoked_at=is.null",
    { method: "PATCH", body: { revoked_at: new Date().toISOString() } }
  );
  return { ok: true };
}
