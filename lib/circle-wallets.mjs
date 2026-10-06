import crypto from "node:crypto";
import { createRequire } from "node:module";
import { requireCircleCredentials } from "./circle-credentials.mjs";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

function circleClient(network) {
  const credentials = requireCircleCredentials(network);
  return {
    sdk: initiateDeveloperControlledWalletsClient(credentials),
    idempotencySecret: process.env.INBOXPAY_WALLET_IDEMPOTENCY_SECRET || credentials.entitySecret
  };
}

function circleName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
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

export async function createBusinessWallet(businessId, businessName, requestedNetwork) {
  const blockchain = requestedNetwork || process.env.INBOXPAY_WALLET_BLOCKCHAIN || "ARC-TESTNET";
  const businessRef = String(businessId || "").trim();
  if (!businessRef) throw new Error("Business ID is required for dedicated wallet creation");

  const { sdk, idempotencySecret } = circleClient(blockchain);
  const walletSet = await sdk.createWalletSet({
    idempotencyKey: stableIdempotencyKey(idempotencySecret, "wallet-set", blockchain, businessRef),
    name: circleName("InboxPay " + businessRef)
  });
  const walletSetId = walletSet?.data?.walletSet?.id;
  if (!walletSetId) throw new Error("Circle did not return a wallet set");

  const wallets = await sdk.createWallets({
    idempotencyKey: stableIdempotencyKey(idempotencySecret, "wallet", blockchain, businessRef),
    accountType: "EOA",
    blockchains: [blockchain],
    count: 1,
    walletSetId,
    metadata: [{
      name: circleName("InboxPay " + (businessName || "Business")),
      refId: businessRef
    }]
  });
  const wallet = wallets?.data?.wallets?.[0];
  if (!wallet?.id || !wallet?.address) throw new Error("Circle did not return a wallet");

  return {
    walletSetId,
    walletId: wallet.id,
    walletAddress: wallet.address,
    walletBlockchain: blockchain
  };
}

export async function requestBusinessTestnetFunds(walletAddress, requestedNetwork) {
  const blockchain = requestedNetwork || "ARC-TESTNET";
  if (blockchain !== "ARC-TESTNET") {
    throw new Error("Testnet funding is only available for Arc Testnet wallets");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(walletAddress || ""))) {
    throw new Error("A valid business wallet address is required for testnet funding");
  }

  const { sdk } = circleClient(blockchain);
  await sdk.requestTestnetTokens({
    address: walletAddress,
    blockchain,
    native: true,
    usdc: true
  });
}

export function idempotencyKey() {
  return crypto.randomUUID();
}
