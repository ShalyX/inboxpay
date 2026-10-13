const GMAIL_REAUTH_PATTERN =
  /token has been expired or revoked|invalid_grant|gmail authorization must be renewed/i;

const SESSION_PATTERN = /authentication required|invalid or expired inboxpay session/i;

export function classifyInvoiceRouteError(error) {
  const message = error instanceof Error ? error.message : String(error || "");

  if (GMAIL_REAUTH_PATTERN.test(message)) {
    return {
      status: 409,
      body: {
        error: "Gmail authorization must be renewed",
        code: "GMAIL_REAUTH_REQUIRED"
      },
      log: "warning"
    };
  }

  if (SESSION_PATTERN.test(message)) {
    return {
      status: 401,
      body: { error: "Authentication required" },
      log: "none"
    };
  }

  return {
    status: 500,
    body: { error: "Invoice data unavailable" },
    log: "error"
  };
}
