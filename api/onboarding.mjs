import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";

function slugify(value) {
  const slug = String(value || "business").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 48) || "business";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const requestedName = String(req.body?.businessName || "").trim();
    const name = requestedName || user.user_metadata?.business_name || user.email?.split("@")[1] || "My Business";

    const existing = await supabaseRest(
      "businesses?select=*&owner_user_id=eq." + encodeURIComponent(user.id) + "&limit=1",
      { token }
    );

    let business = existing?.[0];
    if (!business) {
      const created = await supabaseRest("businesses", {
        token,
        method: "POST",
        body: {
          owner_user_id: user.id,
          name,
          slug: slugify(name) + "-" + user.id.slice(0, 8)
        }
      });
      business = created?.[0];
    }

    if (!business) throw new Error("Unable to create InboxPay business");

    // Wallet creation is a separate explicit business action.
    // This avoids silently creating mainnet state during account sign-in.


    const policies = await supabaseRest(
      "policies?select=*&user_id=eq." + encodeURIComponent(user.id) + "&limit=1",
      { token }
    );
    if (!policies?.[0]) {
      await supabaseRest("policies", {
        token,
        method: "POST",
        body: {
          user_id: user.id,
          business_id: business.id,
          max_transaction_usdc: 1000,
          daily_limit_usdc: 5000,
          cash_floor_usdc: 20,
          require_verified_vendor: true,
          paused: false
        }
      });
    }

    return res.status(200).json({ business });
  } catch (error) {
    console.error("InboxPay onboarding failed:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Onboarding failed"
    });
  }
}
