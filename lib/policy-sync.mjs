import { createPublicClient, http, parseAbi } from "viem";
import { executePolicyContract, getWalletTransaction } from "./policy-contract.mjs";

const MAINNET_RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const TESTNET_RPC = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";

const vaultAbi = parseAbi([
  "function maxTransaction() view returns (uint256)",
  "function dailyLimit() view returns (uint256)",
  "function cashFloor() view returns (uint256)",
  "function paused() view returns (bool)",
  "function vendorRecipient(bytes32) view returns (address)"
]);

function rpcFor(blockchain) {
  return blockchain === "ARC" ? MAINNET_RPC : TESTNET_RPC;
}

function chainFor(blockchain) {
  return blockchain === "ARC" ? 5042 : 5042002;
}

export function policyClient(blockchain) {
  return createPublicClient({
    chain: { id: chainFor(blockchain), name: blockchain, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpcFor(blockchain)] } } },
    transport: http(rpcFor(blockchain))
  });
}

export async function readPolicyState(address, blockchain) {
  const client = policyClient(blockchain);
  const [maxTransaction, dailyLimit, cashFloor, paused] = await Promise.all([
    client.readContract({ address, abi: vaultAbi, functionName: "maxTransaction" }),
    client.readContract({ address, abi: vaultAbi, functionName: "dailyLimit" }),
    client.readContract({ address, abi: vaultAbi, functionName: "cashFloor" }),
    client.readContract({ address, abi: vaultAbi, functionName: "paused" })
  ]);
  return { maxTransaction, dailyLimit, cashFloor, paused };
}

export async function readVendorRecipient(address, vendorId, blockchain) {
  const client = policyClient(blockchain);
  return client.readContract({
    address,
    abi: vaultAbi,
    functionName: "vendorRecipient",
    args: [vendorId]
  });
}

export class CircleTransactionError extends Error {
  constructor(message, { transactionId, state, terminal, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CircleTransactionError";
    this.transactionId = transactionId || null;
    this.state = state || "UNKNOWN";
    this.terminal = Boolean(terminal);
  }
}

export async function readCircleTransaction(transactionId, blockchain) {
  return getWalletTransaction(transactionId, blockchain);
}

export async function waitForCircleTransaction(transactionId, blockchain, timeoutMs = 45000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    let tx;
    try {
      tx = await getWalletTransaction(transactionId, blockchain);
      lastError = null;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    if (!tx) {
      lastError = new Error("Circle transaction status unavailable");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    const state = String(tx.state || "UNKNOWN").toUpperCase();
    if (state === "COMPLETE") {
      return {
        id: transactionId,
        state,
        txHash: tx.txHash || tx.hash || null,
        transaction: tx
      };
    }

    if (["FAILED", "DENIED", "CANCELLED"].includes(state)) {
      throw new CircleTransactionError(
        "Circle transaction " + state.toLowerCase() + ": " +
        (tx.errorDetails || tx.errorReason || "unknown error"),
        { transactionId, state, terminal: true }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new CircleTransactionError(
    "Circle transaction is still pending after the request timeout",
    { transactionId, state: "TIMEOUT", terminal: false, cause: lastError }
  );
}

export async function writePolicy({ walletId, contractAddress, abiFunctionSignature, abiParameters, blockchain, idempotencyKey, onSubmitted, timeoutMs }) {
  const submitted = await executePolicyContract({
    walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters,
    blockchain,
    idempotencyKey
  });
  if (!submitted.transactionId) throw new Error("Circle did not return a contract transaction id");
  if (onSubmitted) await onSubmitted({ transactionId: submitted.transactionId });
  return waitForCircleTransaction(submitted.transactionId, blockchain, timeoutMs);
}
