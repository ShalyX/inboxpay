import { createOperatorHandoff, revokeOperatorHandoffs } from "../../lib/operator-handoff.mjs";
import { requireUser } from "../../lib/supabase-server.mjs";

export default async function handler(req, res) {
  try {
    const { user } = await requireUser(req);
    if (req.method === "POST") {
      const handoff = await createOperatorHandoff(req);
      return res.status(201).json(handoff);
    }
    if (req.method === "DELETE") {
      return res.status(200).json(await revokeOperatorHandoffs(null, user.id));
    }
    res.setHeader("Allow", "POST, DELETE");
    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (error) {
    console.error("InboxPay operator handoff failed:", error);
    const message = error instanceof Error ? error.message : "Operator handoff unavailable";
    return res.status(/Authentication required|Invalid or expired|session attached/i.test(message) ? 401 : 500).json({ error: message });
  }
}
