import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
const output = new URL("./circle-mainnet-evm-wallet.json", import.meta.url);

if (!apiKey || !entitySecret) {
  throw new Error("Missing Circle API credentials in environment.");
}

if (fs.existsSync(output)) {
  const existing = JSON.parse(fs.readFileSync(output, "utf8"));
  console.log(JSON.stringify({ status: "existing", ...existing }, null, 2));
  process.exit(0);
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey,
  entitySecret
});

const walletSetResponse = await client.createWalletSet({
  name: "InboxPay Mainnet"
});

const walletSetId = walletSetResponse?.data?.walletSet?.id;

if (!walletSetId) {
  throw new Error("Circle did not return a wallet set ID.");
}

console.log(JSON.stringify({
  status: "wallet_set_created",
  walletSetId
}, null, 2));

const response = await client.createWallets({
  walletSetId,
  blockchains: ["EVM"],
  accountType: "EOA",
  count: 1
});

const wallet = response?.data?.wallets?.[0];

if (!wallet?.id || !wallet?.address) {
  throw new Error("Circle did not return a wallet.");
}

const saved = {
  walletSetId,
  walletId: wallet.id,
  address: wallet.address,
  blockchain: wallet.blockchain,
  accountType: wallet.accountType,
  state: wallet.state
};

fs.writeFileSync(output, JSON.stringify(saved, null, 2) + "\n");
console.log(JSON.stringify({ status: "created", ...saved }, null, 2));
