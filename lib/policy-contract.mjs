import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { requireCircleCredentials } from "./circle-credentials.mjs";

const require = createRequire(import.meta.url);
const { initiateSmartContractPlatformClient } = require("@circle-fin/smart-contract-platform");
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const ARTIFACT_PATH = new URL("../contracts/artifacts/BusinessPolicyVault.json", import.meta.url);

function blockchain() {
  return process.env.INBOXPAY_POLICY_BLOCKCHAIN || process.env.INBOXPAY_WALLET_BLOCKCHAIN || "ARC-TESTNET";
}

async function artifact() {
  return JSON.parse(await fs.readFile(ARTIFACT_PATH, "utf8"));
}

function scpClient(network) {
  return initiateSmartContractPlatformClient(requireCircleCredentials(network));
}

function walletClient(network) {
  return initiateDeveloperControlledWalletsClient(requireCircleCredentials(network));
}

function stableIdempotencyKey(secret, ...parts) {
  const bytes = crypto
    .createHmac("sha256", secret)
    .update(parts.join("\0"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function usdcUnits(value, label) {
  const units = Math.round(Number(value) * 1e6);
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new Error(label + " must resolve to a non-negative safe USDC unit amount");
  }
  return units;
}

export async function deployBusinessPolicyVault({ businessId, deploymentAttempt, walletId, walletAddress, maxTransaction, dailyLimit, cashFloor, blockchain: requestedBlockchain }) {
  const network = requestedBlockchain || blockchain();
  const businessRef = String(businessId || "").trim();
  if (!businessRef) throw new Error("Business ID is required for policy-vault deployment");
  if (!["ARC-TESTNET", "ARC"].includes(network)) {
    throw new Error("InboxPay policy vault currently supports Arc only");
  }
  if (network === "ARC" && process.env.INBOXPAY_ALLOW_MAINNET_WRITES !== "true") {
    throw new Error("Mainnet policy-vault deployment is disabled until InboxPay explicitly enables mainnet writes");
  }

  const art = await artifact();
  const constructorParameters = [
    walletAddress,
    "0x3600000000000000000000000000000000000000",
    usdcUnits(maxTransaction, "Per-payment limit"),
    usdcUnits(dailyLimit, "Daily limit"),
    usdcUnits(cashFloor, "Cash floor")
  ];
  const deploymentVersion = crypto
    .createHash("sha256")
    .update(art.bytecode)
    .update("\0")
    .update(JSON.stringify(constructorParameters))
    .digest("hex");
  const credentials = requireCircleCredentials(network);
  const client = scpClient(network);
  const requestId = crypto.randomUUID();
  let result;
  try {
    result = await client.deployContract({
      name: "InboxPayPolicyVault",
      blockchain: network,
      walletId,
      abiJson: JSON.stringify(art.abi),
      bytecode: art.bytecode,
      constructorParameters,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: stableIdempotencyKey(
        process.env.INBOXPAY_WALLET_IDEMPOTENCY_SECRET || credentials.entitySecret,
        "policy-vault",
        network,
        businessRef,
        deploymentVersion,
        String(deploymentAttempt || "initial")
      ),
      xRequestId: requestId
    });
  } catch (error) {
    error.circleRequestId = requestId;
    throw error;
  }

  return {
    contractId: result?.data?.contractId || null,
    transactionId: result?.data?.transactionId || null,
    blockchain: network
  };
}

export async function getBusinessPolicyVault(contractId, requestedBlockchain) {
  const client = scpClient(requestedBlockchain || blockchain());
  const result = await client.getContract({ id: contractId });
  return result?.data?.contract || null;
}

export async function executePolicyContract({
  walletId,
  contractAddress,
  abiFunctionSignature,
  abiParameters,
  blockchain: requestedBlockchain,
  idempotencyKey
}) {
  const client = walletClient(requestedBlockchain || blockchain());
  await client.estimateContractExecutionFee({
    walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters
  });

  const result = await client.createContractExecutionTransaction({
    walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters,
    idempotencyKey: idempotencyKey || crypto.randomUUID(),
    fee: { type: "level", config: { feeLevel: "MEDIUM" } }
  });
  return {
    transactionId: result?.data?.id || null
  };
}

export async function getWalletTransaction(transactionId, requestedBlockchain) {
  const client = walletClient(requestedBlockchain || blockchain());
  const result = await client.getTransaction({ id: transactionId });
  return result?.data?.transaction || null;
}
