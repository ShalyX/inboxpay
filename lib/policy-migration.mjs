import crypto from "node:crypto";

export const POLICY_MIGRATION_VERSION = "vendor-revocation-v1";

export function migrationDeploymentAttempt({ activeAddress, activeContractId }) {
  const address = String(activeAddress || "").trim().toLowerCase();
  const contractId = String(activeContractId || "").trim();
  if (!address || !contractId) throw new Error("An existing policy vault is required for migration");
  return ["migration", POLICY_MIGRATION_VERSION, address, contractId].join(":");
}

export function migrationIdempotencyFingerprint({ businessId, activeAddress, activeContractId }) {
  const attempt = migrationDeploymentAttempt({ activeAddress, activeContractId });
  return crypto.createHash("sha256").update([String(businessId || ""), attempt].join("\0")).digest("hex");
}

export function migrationEligibility(business) {
  if (!business?.wallet_id || !business?.wallet_address) {
    return { ok: false, reason: "Dedicated business wallet is not ready" };
  }
  if (!business.policy_contract_address || !business.policy_contract_id) {
    return { ok: false, reason: "An existing policy vault is required for migration" };
  }
  if (!["ready", "error"].includes(business.policy_contract_status)) {
    return { ok: false, reason: "Policy vault migration is already in progress" };
  }
  return { ok: true };
}
