import fs from "node:fs/promises";
import { initiateSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const ARTIFACT_PATH = new URL("../contracts/artifacts/BusinessPolicyVault.json", import.meta.url);

function requireCircle() {
  if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
    throw new Error("Circle developer credentials are not configured");
  }
}

function blockchain() {
  return process.env.INBOXPAY_POLICY_BLOCKCHAIN || process.env.INBOXPAY_WALLET_BLOCKCHAIN || "ARC-TESTNET";
}

async function artifact() {
  return JSON.parse(await fs.readFile(ARTIFACT_PATH, "utf8"));
}

function scpClient() {
  requireCircle();
  return initiateSmartContractPlatformClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET
  });
}

function walletClient() {
  requireCircle();
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET
  });
}

export async function deployBusinessPolicyVault({ walletId, walletAddress, maxTransaction, dailyLimit, cashFloor }) {
  const network = blockchain();
  if (!["ARC-TESTNET", "ARC"].includes(network)) {
    throw new Error("InboxPay policy vault currently supports Arc only");
  }
  if (network === "ARC" && process.env.INBOXPAY_ALLOW_MAINNET_WRITES !== "true") {
    throw new Error("Mainnet policy-vault deployment is disabled until InboxPay explicitly enables mainnet writes");
  }

  const art = await artifact();
  const client = scpClient();
  const result = await client.deployContract({
    name: "InboxPayPolicyVault",
    description: "Per-business USDC spending policy vault",
    blockchain: network,
    walletId,
    abiJson: JSON.stringify(art.abi),
    bytecode: art.bytecode,
    constructorParameters: [
      walletAddress,
      "0x3600000000000000000000000000000000000000",
      String(Math.round(Number(maxTransaction) * 1e6)),
      String(Math.round(Number(dailyLimit) * 1e6)),
      String(Math.round(Number(cashFloor) * 1e6))
    ],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: crypto.randomUUID()
  });

  return {
    contractId: result?.data?.contractId || null,
    transactionId: result?.data?.transactionId || null,
    blockchain: network
  };
}

export async function getBusinessPolicyVault(contractId) {
  const client = scpClient();
  const result = await client.getContract({ id: contractId });
  return result?.data?.contract || null;
}

export async function executePolicyContract({
  walletId,
  contractAddress,
  abiFunctionSignature,
  abiParameters
}) {
  const client = walletClient();
  const result = await client.createContractExecutionTransaction({
    walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } }
  });
  return {
    transactionId: result?.data?.id || null
  };
}

export async function getWalletTransaction(transactionId) {
  const client = walletClient();
  const result = await client.getTransaction({ id: transactionId });
  return result?.data?.transaction || null;
}
