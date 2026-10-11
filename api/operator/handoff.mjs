import { createOperatorHandoff } from "../../lib/operator-handoff.mjs";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }
    return res.status(201).json(await createOperatorHandoff(req));
  } catch (error) {
    console.error("InboxPay operator handoff failed:", error);
    const message = error instanceof Error ? error.message : "Operator handoff unavailable";
    return res.status(/Authentication required|Invalid or expired|session attached/i.test(message) ? 401 : 500).json({ error: message });
  }
}
