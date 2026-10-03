import { createPublicClient, http, formatUnits } from "viem";
import { defineChain } from "viem";
const arc=defineChain({id:5042002,name:"Arc Testnet",nativeCurrency:{name:"Arc",symbol:"ARC",decimals:18},rpcUrls:{default:{http:["https://rpc.testnet.arc.io"]}}});
const client=createPublicClient({chain:arc,transport:http()});
const token="0x3600000000000000000000000000000000000000";
const addrs=["0x5516d80e003d13d328a3de452eaf871ccabc8fa5","0x83d2f795af8b3de5fb0642765f36dbdd6aa109bc","0x4daabaca4e9c0fb42614cfbb9268b4485a4bfbce","0xf374c6d388bedd4c122367b124cbe55ce84f4936","0x05d22db61d7e5daf83b370e807cca77ab22cc0ae","0x117a49f7b4171fc393b0166062bb348bf822e200"];
for(const address of addrs){
 const native=await client.getBalance({address});
 const usdc=await client.readContract({address:token,abi:[{type:"function",name:"balanceOf",stateMutability:"view",inputs:[{name:"account",type:"address"}],outputs:[{name:"",type:"uint256"}]}],functionName:"balanceOf",args:[address]});
 console.log(JSON.stringify({address,native:formatUnits(native,18),usdc:formatUnits(usdc,6)}));
}
