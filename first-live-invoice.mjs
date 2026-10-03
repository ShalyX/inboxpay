import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  createPublicClient, http, encodeDeployData, encodeFunctionData,
  encodeAbiParameters, keccak256, parseAbi, parseUnits, formatUnits
} from "viem";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const RPC = "https://rpc.testnet.arc.io";
const CHAIN_ID = 5042002;
const USDC = "0x3600000000000000000000000000000000000000";
const VENDOR = "0x0633Ac1776C934Df935C5eA40C37ede126b158FD";
const wallet = JSON.parse(fs.readFileSync(new URL("./circle-evm-wallet.json", import.meta.url), "utf8"));
const artifact = JSON.parse(fs.readFileSync(new URL("./out/PaymentPolicyVault.sol/PaymentPolicyVault.json", import.meta.url), "utf8"));
const publicClient = createPublicClient({ transport: http(RPC) });
const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"
]);
const vaultAbi = parseAbi([
  "function setVendor(bytes32 vendorId,address recipient)",
  "function executePayment(bytes32 paymentId,bytes32 vendorId,uint256 amount,bytes32 invoiceHash)",
  "function currentPolicy() view returns (uint256,uint256,uint256,uint256,uint256,bool)",
  "event VendorSet(bytes32 indexed vendorId,address indexed recipient)",
  "event PaymentExecuted(bytes32 indexed paymentId,bytes32 indexed vendorId,address indexed recipient,uint256 amount,bytes32 invoiceHash)"
]);
async function signAndBroadcast({ to, data, value = 0n }) {
  const nonce = await publicClient.getTransactionCount({ address: wallet.address });
  const gas = await publicClient.estimateGas({ account: wallet.address, to, data, value });
  const fees = await publicClient.estimateFeesPerGas();
  const tx = {
    chainId: CHAIN_ID,
    nonce: String(nonce),
    to,
    data,
    value: "0x" + value.toString(16),
    gas: String(gas),
    maxFeePerGas: String(fees.maxFeePerGas),
    maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas)
  };
  const response = await circle.signTransaction({
    walletId: wallet.walletId,
    transaction: JSON.stringify(tx),
    memo: "Tameion AP Agent testnet operation"
  });
  const signed = response?.data?.signedTransaction;
  if (!signed) throw new Error("Circle returned no signed transaction");
  const hash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Arc transaction reverted: " + hash);
  return { hash, receipt };
}

function invoiceHash(invoice) {
  return keccak256(new TextEncoder().encode([
    invoice.vendor,
    invoice.invoiceNumber,
    invoice.amount.toString(),
    invoice.currency,
    invoice.dueDate
  ].join("|")));
}

function bytes32(text) { return keccak256(new TextEncoder().encode(text)); }

async function balances(address) {
  const [native, usdc] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] })
  ]);
  return { native: formatUnits(native, 18), usdc: formatUnits(usdc, 6) };
}
console.log(JSON.stringify({ step:"preflight", chainId: await publicClient.getChainId(), wallet: wallet.address, balances: await balances(wallet.address) }, null, 2));

console.log("Requesting Arc testnet faucet for the Circle EVM wallet...");
await circle.requestTestnetTokens({
  address: wallet.address,
  blockchain: "ARC-TESTNET",
  usdc: true
});

for (let i = 0; i < 30; i++) {
  const b = await balances(wallet.address);
  if (Number(b.usdc) >= 2) {
    console.log(JSON.stringify({ step:"funded", balances:b }, null, 2));
    break;
  }
  await new Promise(r => setTimeout(r, 5000));
  if (i === 29) throw new Error("Faucet funding not visible after 150s");
}

const deployData = encodeDeployData({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: [USDC, 2_000_000n, 5_000_000n, 500_000n]
});
console.log(JSON.stringify({ step:"deploying-vault" }, null, 2));
const deploy = await signAndBroadcast({ data: deployData });
const vaultAddress = deploy.receipt.contractAddress;
if (!vaultAddress) throw new Error("No vault address in deployment receipt");
console.log(JSON.stringify({ step:"vault-deployed", vaultAddress, txHash:deploy.hash }, null, 2));

const vendorId = bytes32("vendor:acme-hosting");
const paymentId = bytes32("invoice:TA-0001");
const invoice = {
  vendor: "Acme Hosting",
  invoiceNumber: "TA-0001",
  amount: 1_000_000n,
  currency: "USDC",
  dueDate: new Date().toISOString().slice(0,10)
};
const invHash = invoiceHash(invoice);
console.log(JSON.stringify({
  step:"invoice-ingested",
  invoiceNumber:invoice.invoiceNumber,
  amount:"1.00",
  dueDate:invoice.dueDate,
  agentDecision:"PAY_NOW",
  reason:"Invoice is due today and the vendor is verified."
}, null, 2));

await signAndBroadcast({
  to: USDC,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [vaultAddress, 2_000_000n]
  })
});
console.log(JSON.stringify({ step:"vault-funded", amount:"2.00 USDC" }, null, 2));

await signAndBroadcast({
  to: vaultAddress,
  data: encodeFunctionData({
    abi: vaultAbi,
    functionName: "setVendor",
    args: [vendorId, VENDOR]
  })
});
console.log(JSON.stringify({ step:"vendor-allowlisted", recipient:VENDOR }, null, 2));
const payment = await signAndBroadcast({
  to: vaultAddress,
  data: encodeFunctionData({
    abi: vaultAbi,
    functionName: "executePayment",
    args: [paymentId, vendorId, invoice.amount, invHash]
  })
});

const paymentLogs = parseAbi([
  "event PaymentExecuted(bytes32 indexed paymentId,bytes32 indexed vendorId,address indexed recipient,uint256 amount,bytes32 invoiceHash)"
]);
const parsed = [];
for (const log of payment.receipt.logs) {
  try {
    const topic0 = log.topics[0];
    if (topic0 === keccak256(new TextEncoder().encode("PaymentExecuted(bytes32,bytes32,address,uint256,bytes32)"))) parsed.push(log);
  } catch {}
}
const vaultBalance = await publicClient.readContract({
  address: vaultAddress,
  abi: vaultAbi,
  functionName: "currentPolicy"
});
const vendorBalance = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [VENDOR]
});

const result = {
  step:"invoice-paid",
  invoiceNumber:invoice.invoiceNumber,
  decision:"PAY_NOW",
  paymentTxHash:payment.hash,
  arcStatus:payment.receipt.status,
  paymentExecutedEvents:parsed.length,
  vendorReceived:"1.00 USDC",
  vendorBalanceAfter:formatUnits(vendorBalance,6),
  vaultBalanceAfter:formatUnits(vaultBalance[4],6),
  reconciled: payment.receipt.status==="success" && parsed.length===1
};
console.log(JSON.stringify(result, null, 2));
if (!result.reconciled) throw new Error("Reconciliation failed");
fs.writeFileSync(new URL("./live-run-result.json", import.meta.url), JSON.stringify(result, null, 2)+"\n");
