// Preview deploys share owner-scoped Auth/RLS reads, never signing credentials.
// Bootstrap may load an existing business and initialize its draft/network rows;
// a new business requires an explicit name and cannot be created in previews.
// every financial/configuration action remains disabled, including worker calls.
export function isReadOnlyPreview() {
  return process.env.VERCEL_ENV === "preview" || process.env.INBOXPAY_PREVIEW_READ_ONLY === "true";
}

export function rejectPreviewRequest(req, res, { bootstrap = false, blocked = false } = {}) {
  if (!isReadOnlyPreview()) return false;
  const bootstrapAllowed = bootstrap && req.method === "POST" && req.body?.action === "approve" && req.body?.businessName === undefined;
  if (!blocked && (req.method === "GET" || bootstrapAllowed)) return false;
  res.status(403).json({ code: "READ_ONLY_PREVIEW", error: "This preview shows saved business records. Inbox connections, financial actions, and account changes are disabled." });
  return true;
}
