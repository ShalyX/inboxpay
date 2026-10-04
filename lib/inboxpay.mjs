import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, keccak256, parseAbi, parseUnits, formatUnits } from "viem";
import { circleSignTransaction } from "./circle-signing.mjs";
import { demoDecisions } from "./demo-decisions.mjs";
import { demoSettlements } from "./demo-settlements.mjs";
import { gmailLiveConfigured, scanGmailInvoices } from "./gmail-live.mjs";
import { evaluateInvoiceRecords } from "./evaluator.mjs";
import vendorRegistry from "./vendor-registry.json" with { type: "json" };

const ROOT = process.cwd();
const DEFAULT_VAULT = "0xa1dafca93784eeeecd081662435a5943eba73c66";
const USDC = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042;
const KNOWN_PAYMENT_IDS = {
  "TA-GMAIL-0001": "0x9bd8f2928a565c6809d11ee236496de706a2da69a94416540c7b7b59413941cf"
};

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
  let source = "demo";

  if (gmailLiveConfigured()) {
    const scan = await scanGmailInvoices();
    data = evaluateInvoiceRecords(scan.invoices || [], vendorRegistry);
    source = "gmail-live";
  } else {
    try {
      data = await json("agent-decisions.json");
      source = "gmail-local";
    } catch {
      data = demoDecisions;
    }
  }

  const cfg = await walletConfig();
  const liveClient = cfg.rpc && cfg.vaultAddress
    ? createPublicClient({ transport: http(cfg.rpc) })
    : null;
  const liveHead = liveClient ? await liveClient.getBlockNumber().catch(() => null) : null;

  const invoices = await Promise.all((data.invoices || []).map(async (invoice) => {
    const paymentId = invoice.paymentId || (
      invoice.messageId
        ? b32("gmail:" + invoice.invoiceNumber + ":" + invoice.messageId)
        : undefined
    );

    let settlement = liveClient ? null : (demoSettlements[invoice.invoiceNumber] || null);
    if (liveClient && paymentId) {
      try {
        const last = await findPaymentLog(liveClient, cfg.vaultAddress, paymentId, liveHead ?? 0n);
        if (last) {
          settlement = { status: "confirmed", paymentTxHash: last.transactionHash, reconciled: true };
        } else {
          const used = await liveClient.readContract({
            address: cfg.vaultAddress,
            abi: vaultAbi,
            functionName: "usedPayment",
            args: [paymentId]
          });
          if (used) settlement = { status: "confirmed", paymentTxHash: null, reconciled: true };
        }
      } catch {}
    }

    return {
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
      paymentId,
      settlement: settlement
        ? {
            status: settlement.status,
            paymentTxHash: settlement.paymentTxHash,
            reconciled: settlement.reconciled
          }
        : null
    };
  }));

  return {
    evaluatedAt: data.evaluatedAt,
    count: invoices.length,
    source,
    liveGmail: source === "gmail-live",
    invoices
  };
}

function b32(value) {
  return keccak256(new TextEncoder().encode(value));
}

async function findPaymentLog(client, vaultAddress, paymentId, headBlock) {
  let cursor = headBlock;
  const chunk = 4000n;

  for (let i = 0; i < 10 && cursor >= 0n; i++) {
    const fromBlock = cursor > chunk ? cursor - chunk + 1n : 0n;
    try {
      const logs = await client.getLogs({
        address: vaultAddress,
        event: eventAbi[0],
        args: { paymentId },
        fromBlock,
        toBlock: cursor
      });
      const last = logs.at(-1);
      if (last) return last;
    } catch {}
    if (fromBlock === 0n) break;
    cursor = fromBlock - 1n;
  }

  return null;
}


function invoiceHash(invoice) {
  return b32([invoice.vendor, invoice.invoiceNumber, String(invoice.amount), invoice.currency, invoice.dueDate].join("|"));
}

async function walletConfig() {
  let local = {};
  try { local = await json("circle-mainnet-evm-wallet.json"); } catch {}
  const env = localConfig();
  return {
    walletId: process.env.CIRCLE_WALLET_ID || env.CIRCLE_WALLET_ID || local.walletId,
    address: process.env.CIRCLE_WALLET_ADDRESS || env.CIRCLE_WALLET_ADDRESS || local.address,
    apiKey: process.env.CIRCLE_API_KEY || env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET || env.CIRCLE_ENTITY_SECRET,
    vaultAddress: process.env.PAYMENT_VAULT_ADDRESS || env.PAYMENT_VAULT_ADDRESS || DEFAULT_VAULT,
    rpc: process.env.ARC_RPC_URL || env.ARC_RPC || env.RPC || "https://rpc.mainnet.arc.io"
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

async function signAndBroadcast(client, walletId, txTo, data, memo) {
  const nonce = await client.getTransactionCount({ address: walletId.address });
  const gas = await client.estimateGas({ account: walletId.address, to: txTo, data });
  const fees = await client.estimateFeesPerGas();
  const unsigned = {
    chainId: CHAIN_ID, nonce: String(nonce), to: txTo, data, value: "0x0",
    gas: String(gas), maxFeePerGas: String(fees.maxFeePerGas),
    maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas)
  };
  const signedResult = await circleSignTransaction({
    walletId: walletId.id, transaction: JSON.stringify(unsigned), memo
  });
  const signed = signedResult?.signedTransaction;
  if (!signed) throw new Error("Circle returned no signed transaction");
  const hash = await client.sendRawTransaction({ serializedTransaction: signed });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Arc transaction reverted: " + hash);
  return { hash, receipt };
}

export async function settleInvoice(invoiceNumber) {
  const [{ invoices }, cfg] = await Promise.all([
    getInvoices(),
    walletConfig()
  ]);
  const registry = vendorRegistry;
  const invoice = invoices.find((item) => item.invoiceNumber === invoiceNumber);
  if (!invoice) throw new Error("Invoice not found: " + invoiceNumber);
  if (invoice.agentDecision !== "PAY_NOW") throw new Error("Blocked by agent decision: " + invoice.agentDecision);
  if (invoice.currency !== "USDC") throw new Error("Blocked: settlement currency is " + invoice.currency);
  const vendor = registry[invoice.vendor];
  if (!vendor || vendor.status !== "verified") throw new Error("Blocked: vendor is not verified");
  if (!cfg.rpc) throw new Error("Missing Canteen Arc RPC. Set ARC_RPC_URL to the unique arc-canteen RPC URL.");
  if (!cfg.apiKey || !cfg.entitySecret) throw new Error("Missing Circle API credentials");

  const client = createPublicClient({ transport: http(cfg.rpc) });
  const walletInfo = { id: cfg.walletId, address: cfg.address };
  const vault = cfg.vaultAddress;
  const amount = parseUnits(String(invoice.amount), 6);
  const vendorId = b32("vendor:" + invoice.vendor);
  const paymentId =
    invoice.paymentId ||
    KNOWN_PAYMENT_IDS[invoice.invoiceNumber] ||
    b32("gmail:" + invoice.invoiceNumber + ":" + (invoice.messageId || ""));
  const hash = invoiceHash(invoice);

  let [existingRecipient, duplicate, beforeVault, beforeVendor] = await Promise.all([
    client.readContract({ address: vault, abi: vaultAbi, functionName: "vendorRecipient", args: [vendorId] }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "usedPayment", args: [paymentId] }),
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vendor.recipient] })
  ]);

  if (duplicate) throw new Error("Blocked onchain: this payment has already been executed");
  const cashFloor = parseUnits("0.50", 6);
  let fundingTx = null;
  if (beforeVault < amount + cashFloor) {
    const topUp = amount + cashFloor - beforeVault;
    const treasuryBefore = await client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletInfo.address]
    });
    const treasuryFloor = parseUnits("0.50", 6);
    if (treasuryBefore < topUp + treasuryFloor) {
      throw new Error(
        "Blocked: treasury balance would fall below its safety floor (" +
        formatUnits(treasuryFloor, 6) + " USDC)"
      );
    }
    fundingTx = await signAndBroadcast(
      client, walletInfo, USDC,
      encodeFunctionData({
        abi: parseAbi(["function transfer(address to,uint256 amount) returns (bool)"]),
        functionName: "transfer",
        args: [vault, topUp]
      }),
      "InboxPay: replenish policy vault before approved invoice settlement"
    );
    beforeVault = await client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault]
    });
    if (beforeVault < amount + cashFloor) {
      throw new Error("Blocked onchain: vault funding did not reach required cash floor");
    }
  }

  let vendorTx = null;
  if (String(existingRecipient).toLowerCase() !== vendor.recipient.toLowerCase()) {
    vendorTx = await signAndBroadcast(
      client, walletInfo, vault,
      encodeFunctionData({ abi: vaultAbi, functionName: "setVendor", args: [vendorId, vendor.recipient] }),
      "InboxPay: allowlist verified vendor"
    );
  }

  const paymentTx = await signAndBroadcast(
    client, walletInfo, vault,
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
    fundingTxHash: fundingTx?.hash || null,
    paymentTxHash: paymentTx.hash,
    event: decoded?.eventName || null,
    vaultBalanceAfter: formatUnits(afterVault, 6),
    vendorBalanceAfter: formatUnits(afterVendor, 6),
    reconciled: afterVendor === beforeVendor + amount
  };
}

