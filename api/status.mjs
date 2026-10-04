import { createPublicClient, http, parseAbi, formatUnits, keccak256 } from "viem";

const USDC = "0x3600000000000000000000000000000000000000";
const DEFAULT_VAULT = "0xa1dafca93784eeeecd081662435a5943eba73c66";
const PAYMENT_ID = "0x9bd8f2928a565c6809d11ee236496de706a2da69a94416540c7b7b59413941cf";

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function usedPayment(bytes32) view returns (bool)"
]);
const eventAbi = parseAbi([
  "event PaymentExecuted(bytes32 indexed paymentId,bytes32 indexed vendorId,address indexed recipient,uint256 amount,bytes32 invoiceHash)"
]);

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const rpc = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
    const vault = process.env.PAYMENT_VAULT_ADDRESS || DEFAULT_VAULT;
    const wallet = process.env.CIRCLE_WALLET_ADDRESS || null;
    const client = createPublicClient({ transport: http(rpc) });
    const blockNumber = await client.getBlockNumber();

    const result = {
      chainId: 5042,
      rpc,
      vault,
      wallet,
      blockNumber: String(blockNumber)
    };

    if (wallet) {
      result.walletUsdc = formatUnits(await client.readContract({
        address: USDC, abi, functionName: "balanceOf", args: [wallet]
      }), 6);
    }

    result.vaultUsdc = formatUnits(await client.readContract({
      address: USDC, abi, functionName: "balanceOf", args: [vault]
    }), 6);

    result.paymentUsed = await client.readContract({
      address: vault, abi, functionName: "usedPayment", args: [PAYMENT_ID]
    });

    const fromBlock = blockNumber > 200000n ? blockNumber - 200000n : 0n;
    try {
      const logs = await client.getLogs({
        address: vault,
        event: eventAbi[0],
        args: { paymentId: PAYMENT_ID },
        fromBlock,
        toBlock: blockNumber
      });
      result.paymentLogCount = logs.length;
      result.paymentTxHash = logs.at(-1)?.transactionHash || null;
    } catch (error) {
      result.paymentLogError = error instanceof Error ? error.message : String(error);
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("InboxPay /api/status failed:", error);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Status failed" });
  }
}
