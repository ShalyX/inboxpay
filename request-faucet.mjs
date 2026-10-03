import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
const client=initiateDeveloperControlledWalletsClient({apiKey:process.env.CIRCLE_API_KEY,entitySecret:process.env.CIRCLE_ENTITY_SECRET});
const address="0xd1e8ba3c90ab389b898bc83c32723258bb0f3701";
const response=await client.requestTestnetTokens({address,blockchain:"ARC-TESTNET",native:true,usdc:true});
console.log(JSON.stringify({status:"faucet-requested",address,statusCode:response?.status??null}));
