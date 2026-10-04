import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/business-data.mjs";
import { writePolicy } from "../lib/policy-sync.mjs";

const allowedNumbers = new Set([
  "max_transaction_usdc",
  "daily_limit_usdc",
  "cash_floor_usdc"
]);

export default async function handler(req, res) {
  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });

    if (req.method === "GET") {
      const rows = await supabaseRest(
        "policies?select=*&business_id=eq." + encodeURIComponent(business.id) + "&limit=1",
        { token }
      );
      return res.status(200).json({ policy: rows?.[0] || null });
    }

    if (req.method === "PATCH") {
      const current = await supabaseRest(
        "policies?select=*&business_id=eq." + encodeURIComponent(business.id) + "&limit=1",
        { token }
      );
      const policy = current?.[0];
      if (!policy) return res.status(404).json({ error: "Business policy not found" });

      const updates = {};
      for (const [key, value] of Object.entries(req.body || {})) {
        if (allowedNumbers.has(key)) {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0) {
            return res.status(400).json({ error: key + " must be a non-negative number" });
          }
          updates[key] = number;
        }
      }
      if (typeof req.body?.requireVerifiedVendor === "boolean") {
        updates.require_verified_vendor = req.body.requireVerifiedVendor;
      }
      if (typeof req.body?.paused === "boolean") updates.paused = req.body.paused;

      if ("max_transaction_usdc" in updates && "daily_limit_usdc" in updates &&
          updates.max_transaction_usdc > updates.daily_limit_usdc) {
        return res.status(400).json({ error: "Per-payment limit cannot exceed the daily limit" });
      }

      if (business.policy_contract_status === "ready" && business.policy_contract_address) {
        const maxTx = updates.max_transaction_usdc ?? Number(policy.max_transaction_usdc);
        const daily = updates.daily_limit_usdc ?? Number(policy.daily_limit_usdc);
        const floor = updates.cash_floor_usdc ?? Number(policy.cash_floor_usdc);

        if ("max_transaction_usdc" in updates || "daily_limit_usdc" in updates || "cash_floor_usdc" in updates) {
          const tx = await writePolicy({
            walletId: business.wallet_id,
            contractAddress: business.policy_contract_address,
            abiFunctionSignature: "setPolicy(uint256,uint256,uint256)",
            abiParameters: [
              String(Math.round(Number(maxTx) * 1e6)),
              String(Math.round(Number(daily) * 1e6)),
              String(Math.round(Number(floor) * 1e6))
            ]
          });
          await supabaseRest("audit_events", {
            token,
            method: "POST",
            body: {
              user_id: user.id,
              business_id: business.id,
              event_type: "policy_updated_onchain",
              actor: "user",
              data: { tx_hash: tx.txHash, max_transaction_usdc: maxTx, daily_limit_usdc: daily, cash_floor_usdc: floor }
            }
          });
        }

        if ("paused" in updates) {
          const tx = await writePolicy({
            walletId: business.wallet_id,
            contractAddress: business.policy_contract_address,
            abiFunctionSignature: "setPaused(bool)",
            abiParameters: [Boolean(updates.paused)]
          });
          await supabaseRest("audit_events", {
            token,
            method: "POST",
            body: {
              user_id: user.id,
              business_id: business.id,
              event_type: "policy_pause_updated",
              actor: "user",
              data: { tx_hash: tx.txHash, paused: Boolean(updates.paused) }
            }
          });
        }
      }

      updates.updated_at = new Date().toISOString();
      const rows = await supabaseRest(
        "policies?id=eq." + encodeURIComponent(policy.id),
        { token, method: "PATCH", body: updates }
      );
      return res.status(200).json({ policy: rows?.[0] || { ...policy, ...updates } });
    }

    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Policy request failed";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 500).json({ error: message });
  }
}
