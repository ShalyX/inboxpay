import { rejectPreviewRequest, isReadOnlyPreview } from "../lib/preview-boundary.mjs";
import { publicSupabaseConfig } from "../lib/supabase-server.mjs";
import telegramWebhookHandler from "../lib/telegram-webhook-route.mjs";

export default function handler(req, res) {
  if (rejectPreviewRequest(req, res)) return;
  if (req.method === "POST" && req.query?.telegram === "webhook") {
    return telegramWebhookHandler(req, res);
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  try {
    return res.status(200).json({ ...publicSupabaseConfig(), previewReadOnly: isReadOnlyPreview() });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Config unavailable" });
  }
}
