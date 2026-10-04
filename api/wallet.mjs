import { createPublicClient, http, formatUnits, parseAbi } from "viem";
import { requireUser } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/business-data.mjs";

const USDC = "0x3600000000000000000000000000000000000000";
const RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business?.wallet_address) {
      return res.status(409).json({ error: "Business wallet is not provisioned yet" });
    }

    const client = createPublicClient({ transport: http(RPC) });
    const balance = await client.readContract({
      address: USDC,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [business.wallet_address]
    });

    return res.status(200).json({
      address: business.wallet_address,
      blockchain: "Arc Mainnet",
      currency: "USDC",
      balance: formatUnits(balance, 6)
    });
  } catch (error) {
    console.error("InboxPay wallet balance failed:", error);
    const message = error instanceof Error ? error.message : "Wallet unavailable";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 500).json({ error: message });
  }
}
