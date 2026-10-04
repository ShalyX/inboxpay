import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  http,
  encodeDeployData,
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

const data = encodeDeployData({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: [USDC, TX_LIMIT, DAILY_LIMIT, CASH_FLOOR],
});

const nonce = await client.getTransactionCount({ address: wallet.address });
const gas = await client.estimateGas({
  account: wallet.address,
  data,
});
const fees = await client.estimateFeesPerGas();
const tx = {
  chainId: CHAIN_ID,
  nonce: String(nonce),
  data,
  value: "0x0",
  gas: String(gas),
  maxFeePerGas: String(fees.maxFeePerGas),
  maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
};

console.log(JSON.stringify({
  step: "signing",
  walletAddress: wallet.address,
  nonce,
  gas: gas.toString(),
  maxFeePerGas: fees.maxFeePerGas.toString(),
}));

const signed = await circle.signTransaction({
  walletId: wallet.walletId,
  transaction: JSON.stringify(tx),
});

const signedTransaction = signed?.data?.signedTransaction;
const txHash = signed?.data?.txHash;
if (!signedTransaction) throw new Error("Circle returned no signed transaction");

const broadcastHash = await client.sendRawTransaction({
  serializedTransaction: signedTransaction,
});

console.log(JSON.stringify({
  step: "broadcast",
  circleTxHash: txHash ?? null,
  broadcastHash,
}));
const receipt = await client.waitForTransactionReceipt({ hash: broadcastHash });
if (receipt.status !== "success") throw new Error("Vault deployment reverted");

const deployment = {
  chainId: CHAIN_ID,
  usdc: USDC,
  vaultAddress: receipt.contractAddress,
  deploymentTxHash: receipt.transactionHash,
  executorWalletId: wallet.walletId,
  executorAddress: wallet.address,
  txLimit: TX_LIMIT.toString(),
  dailyLimit: DAILY_LIMIT.toString(),
  cashFloor: CASH_FLOOR.toString(),
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(new URL("./deployment.json", import.meta.url), JSON.stringify(deployment, null, 2) + "\n");
console.log(JSON.stringify({ step: "deployed", ...deployment }, null, 2));
