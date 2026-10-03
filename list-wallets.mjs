import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
const client=initiateDeveloperControlledWalletsClient({apiKey:process.env.CIRCLE_API_KEY,entitySecret:process.env.CIRCLE_ENTITY_SECRET});
const sets=["f93d6f56-08e6-5225-8bbc-f893750ed6f8","8c141680-e098-5a15-8c2e-57a8aa753d97","9ce7f25d-1abb-502a-8a61-cd2cf292186e","f27b4013-3b87-5704-8615-d86edfe6a3e9","ee323287-378c-5ea3-8ce4-fa2be8abd224","ab0b15e7-370b-508d-87be-dea3fedbc6be","f3caf795-0bbb-5210-a7f1-c6a7bf0403b5","aa4cfefb-8c8d-5149-a6c8-3185c4e68732"];
for(const setId of sets){
  const r=await client.listWallets({walletSetId:setId});
  const ws=r?.data?.wallets??[];
  console.log(JSON.stringify({setId,count:ws.length,wallets:ws.map(w=>({id:w.id,address:w.address,blockchain:w.blockchain,state:w.state,accountType:w.accountType}))}));
}
