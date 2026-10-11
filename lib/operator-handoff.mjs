import { decryptSecret, encryptSecret } from "./secure-tokens.mjs";
import { getBearerToken, requireUser } from "./supabase-server.mjs";
import { getBusiness } from "./businesses.mjs";

const HANDOFF_TTL_MS = 10 * 60 * 1000;
const TOKEN_PREFIX = "oph_";

export async function createOperatorHandoff(req) {
  const { token, user } = await requireUser(req);
  const business = await getBusiness(token, user.id);
  if (!business) throw new Error("Complete business onboarding first");

  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS).toISOString();
  const payload = encryptSecret(JSON.stringify({
    version: 1,
    scope: "rehearsal_read_refresh",
    userId: user.id,
    businessId: business.id,
    sessionToken: token,
    expiresAt
  }));

  return {
    operatorToken: TOKEN_PREFIX + payload,
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

  let handoff;
  try {
    handoff = JSON.parse(decryptSecret(rawToken.slice(TOKEN_PREFIX.length)));
  } catch {
    throw new Error("Operator handoff is invalid or expired");
  }
  if (handoff.version !== 1 || handoff.scope !== "rehearsal_read_refresh") {
    throw new Error("Operator handoff scope is not permitted");
  }
  if (!handoff.userId || !handoff.businessId || !handoff.sessionToken || Date.now() >= Date.parse(handoff.expiresAt)) {
    throw new Error("Operator handoff is invalid or expired");
  }

  const userResponse = await fetch(
    (process.env.SUPABASE_URL || "https://ecportgmionyhlofyobc.supabase.co") + "/auth/v1/user",
    {
      headers: {
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: "Bearer " + handoff.sessionToken
      }
    }
  );
  const user = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !user?.id || user.id !== handoff.userId) {
    throw new Error("The InboxPay session attached to this handoff is no longer valid");
  }

  const business = await getBusiness(handoff.sessionToken, user.id);
  if (!business || business.id !== handoff.businessId) {
    throw new Error("The operator handoff business is no longer available");
  }

  return { token: handoff.sessionToken, user, handoff };
}
