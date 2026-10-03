import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
if (!apiKey || !entitySecret) throw new Error("Missing Circle credentials");
const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const response = await client.listWalletSets();
const sets = response?.data?.walletSets ?? [];
console.log(JSON.stringify(sets.map(s => ({ id:s.id, name:s.name, custodyType:s.custodyType })), null, 2));
