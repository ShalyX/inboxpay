import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  encodeFunctionData,
  parseAbi,
  parseUnits,
  formatUnits,
  keccak256,
  decodeEventLog
} from "viem";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { OAuth2Client } from "google-auth-library";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://rpc.testnet.arc.io";
const CHAIN_ID = 5042002;
const USDC = "0x3600000000000000000000000000000000000000";
const vaultAddress = "0x1257f37f9ca0dadc0a5e4bc4b807f0d356fdc9b9";
const wallet = JSON.parse(fs.readFileSync(path.join(ROOT, "circle-evm-wallet.json"), "utf8"));
const decisions = JSON.parse(fs.readFileSync(path.join(ROOT, "agent-decisions.json"), "utf8"));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "vendor-registry.json"), "utf8"));
const credentials = JSON.parse(fs.readFileSync(path.join(ROOT, "credentials.json"), "utf8"));
const googleToken = JSON.parse(fs.readFileSync(path.join(ROOT, "gmail-token.json"), "utf8"));

const existingResultPath = path.join(ROOT, "gmail-payment-result.json");
if (fs.existsSync(existingResultPath)) {
  const existingResult = JSON.parse(fs.readFileSync(existingResultPath, "utf8"));
  if (existingResult.invoiceNumber === "TA-GMAIL-0001" && existingResult.reconciled === true) {
    throw new Error("TA-GMAIL-0001 is already reconciled; refusing duplicate payment.");
  }
}

const invoice = decisions.invoices.find((x) => x.invoiceNumber === "TA-GMAIL-0001");
if (!invoice) throw new Error("TA-GMAIL-0001 not found in agent decisions");
if (invoice.agentDecision !== "PAY_NOW") {
  throw new Error("Agent decision is " + invoice.agentDecision + "; refusing to pay");
}
const vendor = registry[invoice.vendor];
if (!vendor || vendor.status !== "verified") throw new Error("Vendor is not verified");
if (invoice.currency !== "USDC") throw new Error("Invoice currency is " + invoice.currency + "; refusing settlement");
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
const paymentEventAbi = parseAbi([
  "event PaymentExecuted(bytes32 indexed paymentId,bytes32 indexed vendorId,address indexed recipient,uint256 amount,bytes32 invoiceHash)"
]);

function bytes32(value) {
  return keccak256(new TextEncoder().encode(value));
}

function buildInvoiceHash(x) {
  return keccak256(new TextEncoder().encode(
    [x.vendor, x.invoiceNumber, String(x.amount), x.currency, x.dueDate].join("|")
  ));
}

async function signAndBroadcast(to, data, memo) {
  const nonce = await publicClient.getTransactionCount({ address: wallet.address });
  const gas = await publicClient.estimateGas({ account: wallet.address, to, data });
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
  const result = await circle.signTransaction({
    walletId: wallet.walletId,
    transaction: JSON.stringify(tx),
    memo
  });
  const signed = result?.data?.signedTransaction;
  if (!signed) throw new Error("Circle returned no signed transaction");
  const hash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Arc transaction reverted: " + hash);
  return { hash, receipt };
}

const amount = parseUnits(String(invoice.amount), 6);
const cashFloor = parseUnits("0.50", 6);
const vendorId = bytes32("vendor:acme-test-hosting");
const paymentId = bytes32("gmail:" + invoice.invoiceNumber + ":" + invoice.messageId);
const invHash = buildInvoiceHash(invoice);

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

if (beforeVault < amount + cashFloor) {
  throw new Error(
    "Vault cash-floor check failed: balance=" + formatUnits(beforeVault, 6) +
    " USDC, required=" + formatUnits(amount + cashFloor, 6) + " USDC"
  );
}

const vendorTx = await signAndBroadcast(
  vaultAddress,
  encodeFunctionData({
    abi: vaultAbi,
    functionName: "setVendor",
    args: [vendorId, vendor.recipient]
  }),
  "Tameion AP Agent: allowlist verified invoice vendor"
);
console.log(JSON.stringify({
  step: "vendor-allowlisted",
  txHash: vendorTx.hash,
  vendor: invoice.vendor,
  recipient: vendor.recipient
}, null, 2));

const paymentTx = await signAndBroadcast(
  vaultAddress,
  encodeFunctionData({
    abi: vaultAbi,
    functionName: "executePayment",
    args: [paymentId, vendorId, amount, invHash]
  }),
  "Tameion AP Agent: settle approved Gmail invoice on Arc"
);

const matchingLogs = paymentTx.receipt.logs.filter(function (log) {
  return log.topics?.[0] === keccak256(new TextEncoder().encode(
    "PaymentExecuted(bytes32,bytes32,address,uint256,bytes32)"
  ));
});
if (matchingLogs.length !== 1) {
  throw new Error("Expected exactly one PaymentExecuted event; found " + matchingLogs.length);
}

const decoded = decodeEventLog({
  abi: paymentEventAbi,
  data: matchingLogs[0].data,
  topics: matchingLogs[0].topics
});
if (decoded.eventName !== "PaymentExecuted") {
  throw new Error("Unexpected event: " + decoded.eventName);
}
const eventArgs = decoded.args;

if (eventArgs.amount !== amount) throw new Error("PaymentExecuted amount mismatch");
if (eventArgs.recipient.toLowerCase() !== vendor.recipient.toLowerCase()) {
  throw new Error("PaymentExecuted recipient mismatch");
}
if (eventArgs.paymentId !== paymentId) throw new Error("PaymentExecuted paymentId mismatch");
if (eventArgs.vendorId !== vendorId) throw new Error("PaymentExecuted vendorId mismatch");
if (eventArgs.invoiceHash !== invHash) throw new Error("PaymentExecuted invoiceHash mismatch");

const afterVault = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [vaultAddress]
});
const afterVendor = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [vendor.recipient]
});

const vaultDelta = beforeVault - afterVault;
const vendorDelta = afterVendor - beforeVendor;
const reconciled = vaultDelta === amount && vendorDelta === amount;
if (!reconciled) {
  throw new Error(
    "Reconciliation failed: vaultDelta=" + formatUnits(vaultDelta, 6) +
    " USDC, vendorDelta=" + formatUnits(vendorDelta, 6) + " USDC"
  );
}

function extractEmail(value) {
  const text = String(value || "");
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
}

function b64url(value) {
  return Buffer.from(value, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sendGmailReceipt() {
  const keys = credentials.installed || credentials.web;
  if (!keys) throw new Error("Google OAuth credentials missing installed/web config");
  const client = new OAuth2Client(keys.client_id, keys.client_secret);
  client.setCredentials(googleToken);
  async function gmailRequest(route, options = {}) {
    const response = await client.request({
      url: "https://gmail.googleapis.com/gmail/v1/users/me" + route,
      method: options.method || "GET",
      params: options.params,
      data: options.data,
      headers: options.headers
    });
    return response.data;
  }

  const to = extractEmail(invoice.from);
  if (!to) throw new Error("Invoice sender email missing");
  const subject = "Paid: " + invoice.invoiceNumber + " — " +
    formatUnits(amount, 6) + " USDC settled on Arc";
  const body = [
    "Payment completed for invoice " + invoice.invoiceNumber + ".",
    "",
    "Vendor: " + invoice.vendor,
    "Amount: " + formatUnits(amount, 6) + " USDC",
    "Network: Arc Testnet",
    "Payment transaction: " + paymentTx.hash,
    "Vault: " + vaultAddress,
    "Agent decision: PAY_NOW",
    "Reconciliation: PASS",
    "",
    "This receipt was generated after on-chain settlement and balance reconciliation."
  ].join("\n");
  const rawLines = [
    "To: " + to,
    "Subject: " + subject,
    "In-Reply-To: " + invoice.messageRfcId,
    "References: " + invoice.messageRfcId,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body
  ];
  const sent = await gmailRequest("/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: {
      raw: b64url(rawLines.join("\r\n")),
      threadId: invoice.threadId
    }
  });
  return { messageId: sent.id, threadId: sent.threadId };
}

const result = {
  invoiceNumber: invoice.invoiceNumber,
  vendor: invoice.vendor,
  amount: invoice.amount,
  currency: invoice.currency,
  decision: invoice.agentDecision,
  vault: vaultAddress,
  vendorRecipient: vendor.recipient,
  setVendorTx: vendorTx.hash,
  paymentTx: paymentTx.hash,
  paymentExecutedEvents: matchingLogs.length,
  eventAmount: eventArgs.amount.toString(),
  eventRecipient: eventArgs.recipient,
  vaultBefore: beforeVault.toString(),
  vaultAfter: afterVault.toString(),
  vaultDelta: vaultDelta.toString(),
  vendorBefore: beforeVendor.toString(),
  vendorAfter: afterVendor.toString(),
  vendorDelta: vendorDelta.toString(),
  reconciled,
  gmail: { receiptSent: false },
  timestamp: new Date().toISOString()
};
fs.writeFileSync(
  path.join(ROOT, "gmail-payment-result.json"),
  JSON.stringify(result, null, 2) + "\n"
);

try {
  const gmailResult = await sendGmailReceipt();
  result.gmail = {
    receiptSent: true,
    messageId: gmailResult.messageId,
    threadId: gmailResult.threadId
  };
  fs.writeFileSync(
    path.join(ROOT, "gmail-payment-result.json"),
    JSON.stringify(result, null, 2) + "\n"
  );
  console.log(JSON.stringify({
    status: "PAYMENT_COMPLETE",
    invoice: invoice.invoiceNumber,
    paymentTx: paymentTx.hash,
    vendorDelta: formatUnits(vendorDelta, 6) + " USDC",
    vaultDelta: formatUnits(vaultDelta, 6) + " USDC",
    reconciled: true,
    gmailReceipt: gmailResult
  }, null, 2));
} catch (error) {
  console.error("On-chain payment reconciled, but Gmail receipt failed:", error.message);
  console.error("Payment tx:", paymentTx.hash);
  process.exitCode = 2;
}
