import crypto from "node:crypto";
import { createRequire } from "node:module";
import { requireCircleCredentials } from "./circle-credentials.mjs";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");
const ARC_USDC = "0x3600000000000000000000000000000000000000";

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
    usdc: true
  });
}

export function idempotencyKey() {
  return crypto.randomUUID();
}

export async function getBusinessWalletUsdcAsset(walletId, requestedNetwork) {
  if (!walletId) throw new Error("Business wallet ID is required");
  const { sdk } = circleClient(requestedNetwork);
  const result = await sdk.getWalletTokenBalance({ id: walletId });
  const balances = result?.data?.tokenBalances || [];
  const asset = balances.find((entry) =>
    entry?.token?.blockchain === requestedNetwork &&
    String(entry?.token?.tokenAddress || "").toLowerCase() === ARC_USDC
  ) || balances.find((entry) =>
    entry?.token?.blockchain === requestedNetwork &&
    String(entry?.token?.symbol || "").toUpperCase() === "USDC"
  );
  if (!asset?.token?.id) throw new Error("Circle did not return the Arc USDC asset for this business wallet");
  return { tokenId: asset.token.id, balance: asset.amount, token: asset.token };
}

export async function estimateBusinessWalletTransfer({ walletId, recipientAddress, amount, blockchain }) {
  const { sdk } = circleClient(blockchain);
  const asset = await getBusinessWalletUsdcAsset(walletId, blockchain);
  const estimate = await sdk.estimateTransferFee({
    amount: [String(amount)],
    destinationAddress: recipientAddress,
    tokenId: asset.tokenId,
    walletId
  });
  return {
    tokenId: asset.tokenId,
    walletBalance: asset.balance,
    fee: estimate?.data?.medium || null
  };
}

export async function submitBusinessWalletTransfer({ businessId, walletId, recipientAddress, amount, blockchain, requestId, tokenId }) {
  const { sdk, idempotencySecret } = circleClient(blockchain);
  const result = await sdk.createTransaction({
    amount: [String(amount)],
    destinationAddress: recipientAddress,
    tokenId,
    walletId,
    idempotencyKey: stableIdempotencyKey(
      idempotencySecret,
      "business-withdrawal",
      blockchain,
      String(businessId),
      String(requestId)
    ),
    refId: "InboxPay withdrawal " + String(requestId),
    fee: { type: "level", config: { feeLevel: "MEDIUM" } }
  });
  const transactionId = result?.data?.id || null;
  if (!transactionId) throw new Error("Circle did not return a withdrawal transaction ID");
  return { transactionId };
}
