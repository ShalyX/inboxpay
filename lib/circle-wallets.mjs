import crypto from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { requireCircleCredentials } from "./circle-credentials.mjs";

function client(network) {
  const credentials = requireCircleCredentials(network);
  return initiateDeveloperControlledWalletsClient(credentials);
}

export async function createBusinessWallet(businessId, businessName, requestedNetwork) {
  const blockchain = requestedNetwork || process.env.INBOXPAY_WALLET_BLOCKCHAIN || "ARC-TESTNET";
  const sdk = client(blockchain);
  const walletSet = await sdk.createWalletSet({
    idempotencyKey: crypto.randomUUID(),
    name: "InboxPay Business " + businessName + " " + businessId
  });
  const walletSetId = walletSet?.data?.walletSet?.id;
  if (!walletSetId) throw new Error("Circle did not return a wallet set");

  const wallets = await sdk.createWallets({
    idempotencyKey: crypto.randomUUID(),
    accountType: "EOA",
    blockchains: [blockchain],
    count: 1,
    walletSetId,
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
