import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
const walletSetId = process.env.CIRCLE_WALLET_SET_ID;

if (!apiKey || !entitySecret || !walletSetId) {
  throw new Error("Missing required Circle environment variables");
}

const outPath = new URL("./circle-wallet.json", import.meta.url);
if (fs.existsSync(outPath)) {
  const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
  console.log(JSON.stringify({ status: "existing", walletId: existing.walletId, address: existing.address, blockchain: existing.blockchain }, null, 2));
  process.exit(0);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const response = await client.createWallets({
  accountType: "EOA",
  blockchains: ["ARC-TESTNET"],
  count: 1,
  walletSetId,
  idempotencyKey: randomUUID()
});

const wallet = response?.data?.wallets?.[0];
if (!wallet?.id || !wallet?.address) throw new Error("Circle returned no wallet");

const saved = {
  walletId: wallet.id,
  address: wallet.address,
  blockchain: wallet.blockchain,
  accountType: wallet.accountType,
  walletSetId: wallet.walletSetId
};
fs.writeFileSync(outPath, JSON.stringify(saved, null, 2) + "\n");
console.log(JSON.stringify({ status: "created", walletId: wallet.id, address: wallet.address, blockchain: wallet.blockchain }, null, 2));
