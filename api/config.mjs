import { publicSupabaseConfig } from "../lib/supabase-server.mjs";

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  try {
    return res.status(200).json(publicSupabaseConfig());
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Config unavailable" });
  }
}
