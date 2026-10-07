import assert from "node:assert/strict";
import {
  migrationDeploymentAttempt,
  migrationEligibility,
  migrationIdempotencyFingerprint
} from "../lib/policy-migration.mjs";

const base = {
  wallet_id: "wallet-1",
  wallet_address: "0xa5639edc94b68af952f6744a8cd6a8b25ef4f80b",
  policy_contract_address: "0x8d8e3e5b0ca5da40c4976cf8b7fb589f3d400942",
  policy_contract_id: "old-contract-id",
  policy_contract_status: "ready"
};

assert.equal(migrationEligibility(base).ok, true);
assert.equal(migrationEligibility({ ...base, policy_contract_status: "deploying" }).ok, false);
assert.equal(migrationEligibility({ ...base, policy_contract_address: null }).ok, false);
assert.equal(migrationEligibility({ ...base, policy_contract_id: null }).ok, false);

const migrationInput = {
  activeAddress: base.policy_contract_address,
  activeContractId: base.policy_contract_id
};
const attempt = migrationDeploymentAttempt(migrationInput);
assert.equal(attempt, "migration:vendor-revocation-v1:0x8d8e3e5b0ca5da40c4976cf8b7fb589f3d400942:old-contract-id");
assert.equal(migrationDeploymentAttempt(migrationInput), attempt);
assert.notEqual(
  migrationDeploymentAttempt({ ...migrationInput, activeContractId: "failed-retry-contract" }),
  attempt
);
assert.equal(
  migrationIdempotencyFingerprint({ businessId: "business-1", ...migrationInput }),
  migrationIdempotencyFingerprint({ businessId: "business-1", ...migrationInput })
);
assert.notEqual(
  migrationIdempotencyFingerprint({ businessId: "business-2", ...migrationInput }),
  migrationIdempotencyFingerprint({ businessId: "business-1", ...migrationInput })
);

console.log("policy migration checks passed");
