import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  http,
  encodeDeployData,
  encodeFunctionData,
  parseAbi,
} from "viem";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const ARC_RPC = "https://rpc.mainnet.arc.io";
const CHAIN_ID = 5042;
const USDC = "0x3600000000000000000000000000000000000000";
const wallet = {
  walletId: "dde269af-d92d-5f96-be60-69ebfcc19df7",
  address: "0xd3bb84b06dfdbeb0b4bf079dc9daaf7a68e55c7c"
};
const artifact = JSON.parse(fs.readFileSync(new URL("./out/PaymentPolicyVault.sol/PaymentPolicyVault.json", import.meta.url), "utf8"));

const client = createPublicClient({ transport: http(ARC_RPC) });
const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});

const TX_LIMIT = 2_000_000n;
const DAILY_LIMIT = 5_000_000n;
const CASH_FLOOR = 500_000n;

const vaultAddress = "0xa1dafca93784eeeecd081662435a5943eba73c66";
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)"
]);

const before = await client.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [wallet.address]
});

const vaultBefore = await client.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [vaultAddress]
});

const amount = 1_000_000n;

if (before < amount) {
  throw new Error("Wallet does not have enough USDC for the 1.00 USDC vault fund.");
}

console.log(JSON.stringify({
  step: "funding-vault",
  vaultAddress,
  amount: "1.00 USDC",
  walletUsdcBefore: before.toString(),
  vaultUsdcBefore: vaultBefore.toString()
}, null, 2));

const transfer = await circle.createDeveloperTransactionTransfer({
  idempotencyKey: randomUUID(),
  walletId: wallet.walletId,
  blockchain: "ARC",
  destinationAddress: vaultAddress,
  amounts: ["1"],
  tokenAddress: USDC,
  feeLevel: "LOW",
  refId: "inboxpay-mainnet-vault-funding"
});

const transaction = transfer?.data?.transaction ?? transfer?.data ?? {};
console.log(JSON.stringify({
  step: "transfer-submitted",
  transactionId: transaction.id ?? null,
  state: transaction.state ?? null,
  txHash: transaction.txHash ?? null
}, null, 2));

for (let i = 0; i < 30; i++) {
  const vaultAfter = await client.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [vaultAddress]
  });

  if (vaultAfter >= amount) {
    const walletAfter = await client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet.address]
    });

    console.log(JSON.stringify({
      step: "funded",
      vaultUsdcAfter: vaultAfter.toString(),
      walletUsdcAfter: walletAfter.toString(),
      amount: "1.00 USDC"
    }, null, 2));
    process.exit(0);
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
}

throw new Error("Vault funding not visible on Arc Mainnet after 150 seconds.");
