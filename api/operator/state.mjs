import { requireOperatorHandoff } from "../../lib/operator-handoff.mjs";
import { listBusinessInvoices, syncBusinessInvoices } from "../../lib/business-data.mjs";
import { getBusinessVendors } from "../../lib/business-data.mjs";
import { supabaseRest } from "../../lib/supabase-server.mjs";

function redactedBusiness(business) {
  return {
    id: business.id,
    name: business.name,
    walletStatus: business.wallet_status,
    walletAddress: business.wallet_address,
    network: business.wallet_blockchain,
    policyStatus: business.policy_contract_status,
    policyVaultAddress: business.policy_contract_address
  };
}

function redactedInvoice(invoice) {
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    vendor: invoice.vendor,
    amount: Number(invoice.amount || 0),
    currency: invoice.currency,
    dueDate: invoice.due_date,
    decision: invoice.decision,
    decisionReasons: invoice.decision_reasons,
    extraction: invoice.extraction,
    sourceCount: invoice.sources?.length || 0,
    settlementStatus: invoice.settlement_status,
    paymentId: invoice.payment_id,
    paymentTxHash: invoice.payment_tx_hash
  };
}

async function snapshot(token, user) {
  const { business, invoices } = await listBusinessInvoices(token, user.id);
  const [vendors, policies, integrations] = await Promise.all([
    getBusinessVendors(token, business.id),
    supabaseRest("policies?select=max_transaction_usdc,daily_limit_usdc,cash_floor_usdc,paused,require_verified_vendor&business_id=eq." + encodeURIComponent(business.id) + "&limit=1", { token }),
    supabaseRest("integrations?select=provider,provider_account_id,status,scopes,token_expires_at&user_id=eq." + encodeURIComponent(user.id) + "&provider=eq.google_gmail&limit=1", { token })
  ]);

  return {
    generatedAt: new Date().toISOString(),
    scope: "rehearsal_read_refresh",
    user: { id: user.id, email: user.email },
    business: redactedBusiness(business),
    gmail: integrations?.[0] ? {
      provider: integrations[0].provider,
      providerAccountId: integrations[0].provider_account_id,
      status: integrations[0].status,
      scopes: integrations[0].scopes,
      tokenExpiresAt: integrations[0].token_expires_at
    } : null,
    policy: policies?.[0] || null,
    vendors: (vendors || []).map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      recipientAddress: vendor.recipient_address,
      currency: vendor.currency,
      status: vendor.status
    })),
    invoices: (invoices || []).map(redactedInvoice)
  };
}

export default async function handler(req, res) {
  try {
    const { token, user } = await requireOperatorHandoff(req);
    if (req.method === "GET") return res.status(200).json(await snapshot(token, user));
    if (req.method === "POST" && req.body?.action === "refresh_invoices") {
      const result = await syncBusinessInvoices(token, user.id);
      return res.status(200).json({
        ok: true,
        refreshedAt: result.scannedAt,
        source: "gmail-live",
        business: redactedBusiness(result.business),
        gmail: result.gmail,
        invoices: (result.invoices || []).map(redactedInvoice)
      });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (error) {
    console.error("InboxPay operator state failed:", error);
    const message = error instanceof Error ? error.message : "Operator state unavailable";
    return res.status(/handoff|session attached|expired|revoked/i.test(message) ? 401 : 500).json({ error: message });
  }
}
