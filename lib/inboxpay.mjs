import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, keccak256, parseAbi, parseUnits, formatUnits } from "viem";
import * as CircleSDK from "@circle-fin/developer-controlled-wallets";
const initiateDeveloperControlledWalletsClient = CircleSDK.initiateDeveloperControlledWalletsClient ?? CircleSDK.default?.initiateDeveloperControlledWalletsClient;

const ROOT = process.cwd();
const DEFAULT_VAULT = "0x1257f37f9ca0dadc0a5e4bc4b807f0d356fdc9b9";
const USDC = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042002;

function readLocalEnv(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).reduce((out, line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) return out;
      out[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      return out;
    }, {});
  } catch { return {}; }
}

function localConfig() {
  const rpcEnv = readLocalEnv(path.join(process.env.USERPROFILE || "", ".arc-canteen", "env"));
  const projectEnv = readLocalEnv(path.join(process.env.USERPROFILE || "", "Downloads", ".env"));
  return { ...projectEnv, ...rpcEnv };
}

async function json(name) {
  return JSON.parse(await fs.readFile(path.join(ROOT, name), "utf8"));
}

export async function getInvoices() {
  let data;
  try { data = await json("agent-decisions.json"); }
  catch { data = await json("demo-decisions.json"); }
  return { evaluatedAt: data.evaluatedAt, count: (data.invoices || []).length, invoices: (data.invoices || []).map((invoice) => ({
    vendor: invoice.vendor,
    invoiceNumber: invoice.invoiceNumber,
    amount: invoice.amount,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    agentDecision: invoice.agentDecision,
    decisionReasons: invoice.decisionReasons,
    extraction: invoice.extraction,
    sourceCount: invoice.sourceCount,
    sources: invoice.sources,
    paymentId: invoice.paymentId || (invoice.messageId ? b32("gmail:" + invoice.invoiceNumber + ":" + invoice.messageId) : undefined)
  })) };
}

function b32(value) {
  return keccak256(new TextEncoder().encode(value));
}

function invoiceHash(invoice) {
  return b32([invoice.vendor, invoice.invoiceNumber, String(invoice.amount), invoice.currency, invoice.dueDate].join("|"));
}

async function walletConfig() {
  const local = await json("circle-evm-wallet.json");
  const env = localConfig();
  return {
    walletId: process.env.CIRCLE_WALLET_ID || env.CIRCLE_WALLET_ID || local.walletId,
    address: process.env.CIRCLE_WALLET_ADDRESS || env.CIRCLE_WALLET_ADDRESS || local.address,
    apiKey: process.env.CIRCLE_API_KEY || env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET || env.CIRCLE_ENTITY_SECRET,
    vaultAddress: process.env.PAYMENT_VAULT_ADDRESS || env.PAYMENT_VAULT_ADDRESS || DEFAULT_VAULT,
    rpc: process.env.ARC_RPC_URL || env.ARC_RPC || env.RPC
  };
}

const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const vaultAbi = parseAbi([
  "function vendorRecipient(bytes32 vendorId) view returns (address)",
  "function usedPayment(bytes32 paymentId) view returns (bool)",
  "function setVendor(bytes32 vendorId,address recipient)",
  "function executePayment(bytes32 paymentId,bytes32 vendorId,uint256 amount,bytes32 invoiceHash)"
]);
const eventAbi = parseAbi(["event PaymentExecuted(bytes32 indexed paymentId,bytes32 indexed vendorId,address indexed recipient,uint256 amount,bytes32 invoiceHash)"]);

async function signAndBroadcast(client, circle, walletId, txTo, data, memo) {
  const nonce = await client.getTransactionCount({ address: walletId.address });
  const gas = await client.estimateGas({ account: walletId.address, to: txTo, data });
  const fees = await client.estimateFeesPerGas();
  const unsigned = {
    chainId: CHAIN_ID, nonce: String(nonce), to: txTo, data, value: "0x0",
    gas: String(gas), maxFeePerGas: String(fees.maxFeePerGas),
    maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas)
  };
  const signedResult = await circle.signTransaction({
    walletId: walletId.id, transaction: JSON.stringify(unsigned), memo
  });
  const signed = signedResult?.data?.signedTransaction;
  if (!signed) throw new Error("Circle returned no signed transaction");
  const hash = await client.sendRawTransaction({ serializedTransaction: signed });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Arc transaction reverted: " + hash);
  return { hash, receipt };
}

export async function settleInvoice(invoiceNumber) {
  const [{ invoices }, registry, cfg] = await Promise.all([
    getInvoices(),
    json("vendor-registry.json"),
    walletConfig()
  ]);
  const invoice = invoices.find((item) => item.invoiceNumber === invoiceNumber);
  if (!invoice) throw new Error("Invoice not found: " + invoiceNumber);
  if (invoice.agentDecision !== "PAY_NOW") throw new Error("Blocked by agent decision: " + invoice.agentDecision);
  if (invoice.currency !== "USDC") throw new Error("Blocked: settlement currency is " + invoice.currency);
  const vendor = registry[invoice.vendor];
  if (!vendor || vendor.status !== "verified") throw new Error("Blocked: vendor is not verified");
  if (!cfg.rpc) throw new Error("Missing Canteen Arc RPC. Set ARC_RPC_URL to the unique arc-canteen RPC URL.");
  if (!cfg.apiKey || !cfg.entitySecret) throw new Error("Missing Circle API credentials");

  const client = createPublicClient({ transport: http(cfg.rpc) });
  const circle = initiateDeveloperControlledWalletsClient({
    apiKey: cfg.apiKey, entitySecret: cfg.entitySecret
  });
  const walletInfo = { id: cfg.walletId, address: cfg.address };
  const vault = cfg.vaultAddress;
  const amount = parseUnits(String(invoice.amount), 6);
  const vendorId = b32("vendor:" + invoice.vendor);
  const paymentId = invoice.paymentId || b32("gmail:" + invoice.vendor + ":" + invoice.invoiceNumber);
  const hash = invoiceHash(invoice);

  const [existingRecipient, duplicate, beforeVault, beforeVendor] = await Promise.all([
    client.readContract({ address: vault, abi: vaultAbi, functionName: "vendorRecipient", args: [vendorId] }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "usedPayment", args: [paymentId] }),
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vendor.recipient] })
  ]);

  if (duplicate) throw new Error("Blocked onchain: this payment has already been executed");
  const cashFloor = parseUnits("0.50", 6);
  if (beforeVault < amount + cashFloor) {
    throw new Error("Blocked onchain: vault cash floor would be violated");
  }

  let vendorTx = null;
  if (String(existingRecipient).toLowerCase() !== vendor.recipient.toLowerCase()) {
    vendorTx = await signAndBroadcast(
      client, circle, walletInfo, vault,
      encodeFunctionData({ abi: vaultAbi, functionName: "setVendor", args: [vendorId, vendor.recipient] }),
      "InboxPay: allowlist verified vendor"
    );
  }

  const paymentTx = await signAndBroadcast(
    client, circle, walletInfo, vault,
    encodeFunctionData({ abi: vaultAbi, functionName: "executePayment", args: [paymentId, vendorId, amount, hash] }),
    "InboxPay: settle approved Gmail invoice on Arc"
  );

  const log = paymentTx.receipt.logs.find((item) => item.address.toLowerCase() === vault.toLowerCase());
  const decoded = log ? decodeEventLog({ abi: eventAbi, data: log.data, topics: log.topics }) : null;
  const [afterVault, afterVendor] = await Promise.all([
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vendor.recipient] })
  ]);

  return {
    invoiceNumber: invoice.invoiceNumber, vendor: invoice.vendor,
    amount: formatUnits(amount, 6) + " USDC",
    vendorTxHash: vendorTx?.hash || null,
    paymentTxHash: paymentTx.hash,
    event: decoded?.eventName || null,
    vaultBalanceAfter: formatUnits(afterVault, 6),
    vendorBalanceAfter: formatUnits(afterVendor, 6),
    reconciled: afterVendor === beforeVendor + amount
  };
}

