import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
const apiKey=process.env.CIRCLE_API_KEY;
const entitySecret=process.env.CIRCLE_ENTITY_SECRET;
const walletSetId="f93d6f56-08e6-5225-8bbc-f893750ed6f8";
const out=new URL("./circle-evm-wallet.json",import.meta.url);
if(fs.existsSync(out)){
 const w=JSON.parse(fs.readFileSync(out,"utf8"));
 console.log(JSON.stringify({status:"existing",...w},null,2));
 process.exit(0);
}
const client=initiateDeveloperControlledWalletsClient({apiKey,entitySecret});
const response=await client.createWallets({
 walletSetId,
 blockchains:["EVM-TESTNET"],
 accountType:"EOA",
 count:1,
 idempotencyKey:randomUUID()
});
const w=response?.data?.wallets?.[0];
if(!w?.id||!w?.address) throw new Error("No EVM wallet returned");
const saved={walletSetId,walletId:w.id,address:w.address,blockchain:w.blockchain,accountType:w.accountType};
fs.writeFileSync(out,JSON.stringify(saved,null,2)+"\n");
console.log(JSON.stringify({status:"created",...saved},null,2));
