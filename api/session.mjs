import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const businesses = await supabaseRest(
      "businesses?select=*&owner_user_id=eq." + encodeURIComponent(user.id) + "&limit=1",
      { token }
    );
    const business = businesses?.[0] || null;

    const integrations = await supabaseRest(
      "integrations?select=id,provider,provider_account_id,status,scopes,token_expires_at&user_id=eq." +
        encodeURIComponent(user.id) + "&provider=eq.google_gmail&limit=1",
      { token }
    );

    return res.status(200).json({
      user: { id: user.id, email: user.email, name: user.user_metadata?.full_name || user.user_metadata?.name || "" },
      business,
      gmail: integrations?.[0] || null
    });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Session unavailable" });
  }
}
