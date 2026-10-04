import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseUnits,
  formatUnits
} from "viem";
import {
  initiateDeveloperControlledWalletsClient
} from "@circle-fin/developer-controlled-wallets";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://rpc.mainnet.arc.io";
const CHAIN_ID = 5042;
const USDC = "0x3600000000000000000000000000000000000000";
const wallet = JSON.parse(
  fs.readFileSync(path.join(ROOT, "circle-mainnet-evm-wallet.json"), "utf8")
);
const decisions = JSON.parse(
  fs.readFileSync(path.join(ROOT, "agent-decisions.json"), "utf8")
);
const registry = JSON.parse(
  fs.readFileSync(path.join(ROOT, "vendor-registry.json"), "utf8")
);
const live = JSON.parse(
  fs.readFileSync(path.join(ROOT, "live-run-result.json"), "utf8")
);

const invoice = decisions.invoices.find(
  (x) => x.invoiceNumber === "TA-GMAIL-0001"
);
if (!invoice) throw new Error("Test Gmail invoice not found");
if (invoice.agentDecision !== "PAY_NOW") {
  throw new Error("Agent did not approve invoice: " + invoice.agentDecision);
}
const vendor = registry[invoice.vendor];
if (!vendor || vendor.status !== "verified") {
  throw new Error("Vendor is not verified: " + invoice.vendor);
}

const vaultAddress = live.vaultAddress;
const publicClient = createPublicClient({ transport: http(RPC) });
const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET
});

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)"
]);
const vaultAbi = parseAbi([
  "function setVendor(bytes32 vendorId,address recipient)",
  "function executePayment(bytes32 paymentId,bytes32 vendorId,uint256 amount,bytes32 invoiceHash)"
]);
const eventTopic = keccak256(
  new TextEncoder().encode(
    "PaymentExecuted(bytes32,bytes32,address,uint256,bytes32)"
  )
);

function bytes32(text) {
  return keccak256(new TextEncoder().encode(text));
}

function invoiceHash(x) {
  return keccak256(
    new TextEncoder().encode(
      [
        x.vendor,
        x.invoiceNumber,
        String(x.amount),
        x.currency,
        x.dueDate
      ].join("|")
    )
  );
}
async function signAndBroadcast(to, data) {
  const nonce = await publicClient.getTransactionCount({
    address: wallet.address
  });
  const gas = await publicClient.estimateGas({
    account: wallet.address,
    to,
    data
  });
  const fees = await publicClient.estimateFeesPerGas();

  const tx = {
    chainId: CHAIN_ID,
    nonce: String(nonce),
    to,
    data,
    value: "0x0",
    gas: String(gas),
    maxFeePerGas: String(fees.maxFeePerGas),
    maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas)
  };

  const response = await circle.signTransaction({
    walletId: wallet.walletId,
    transaction: JSON.stringify(tx),
    memo: "Tameion AP Agent Gmail invoice"
  });
  const signed = response?.data?.signedTransaction;
  if (!signed) throw new Error("Circle returned no signed transaction");

  const hash = await publicClient.sendRawTransaction({
    serializedTransaction: signed
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("Arc transaction reverted: " + hash);
  }
  return { hash, receipt };
}

const amount = parseUnits(String(invoice.amount), 6);
const vendorId = bytes32("vendor:acme-test-hosting");
const paymentId = bytes32(
  "gmail:" + invoice.invoiceNumber + ":" + invoice.messageId
);
const invHash = invoiceHash(invoice);

const beforeVault = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [vaultAddress]
});
const beforeVendor = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [vendor.recipient]
});

