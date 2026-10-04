import crypto from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

function client() {
  if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
    throw new Error("Circle developer-controlled wallet credentials are not configured");
  }
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET
  });
}

export async function createBusinessWallet(businessId, businessName) {
  const sdk = client();
  const walletSet = await sdk.createWalletSet({
    idempotencyKey: crypto.randomUUID(),
    name: "InboxPay · " + businessName + " · " + businessId
  });
  const walletSetId = walletSet?.data?.walletSet?.id;
  if (!walletSetId) throw new Error("Circle did not return a wallet set");

  const blockchain = process.env.INBOXPAY_WALLET_BLOCKCHAIN || "ARC-TESTNET";
  const wallets = await sdk.createWallets({
    idempotencyKey: crypto.randomUUID(),
    accountType: "EOA",
    blockchains: [blockchain],
    count: 1,
    walletSetId,
    count: 1,
    metadata: [{ name: "InboxPay · " + businessName }]
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

export function idempotencyKey() {
  return crypto.randomUUID();
}
