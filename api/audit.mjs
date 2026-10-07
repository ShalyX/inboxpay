import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
    const events = await supabaseRest(
      "audit_events?select=id,event_type,actor,data,invoice_id,created_at&business_id=eq." + encodeURIComponent(business.id) + "&user_id=eq." + encodeURIComponent(user.id) + "&order=created_at.desc&limit=100",
      { token }
    );
    return res.status(200).json({ business, count: events?.length || 0, events: events || [] });
  } catch (error) {
    console.error("InboxPay /api/audit failed:", error);
    const message = error instanceof Error ? error.message : "Audit history unavailable";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 500).json({ error: message });
  }
}

