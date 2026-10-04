import { keccak256 } from "viem";
import { evaluateInvoiceRecords } from "./evaluator.mjs";
import { getFreshGmailAccessToken } from "./gmail-account.mjs";
import { scanGmailInvoices } from "./gmail-live.mjs";
import { supabaseRest } from "./supabase-server.mjs";

export async function getBusiness(token, userId) {
  const rows = await supabaseRest(
    "businesses?select=*&owner_user_id=eq." + encodeURIComponent(userId) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

export async function getBusinessVendors(token, businessId) {
  return await supabaseRest(
    "vendors?select=*&business_id=eq." + encodeURIComponent(businessId) + "&order=name",
    { token }
  );
}

function registryFromRows(rows) {
  return Object.fromEntries((rows || []).map((vendor) => [
    vendor.name,
    { recipient: vendor.recipient_address, currency: vendor.currency, status: vendor.status }
  ]));
}

function dateOnly(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function fingerprint(invoice) {
  return keccak256(new TextEncoder().encode(JSON.stringify([
    invoice.external_message_id || invoice.messageId || "",
    invoice.invoiceNumber || "",
    invoice.amount,
    invoice.currency,
    invoice.dueDate || ""
  ])));
}

async function persistInvoice(token, userId, businessId, integrationId, invoice) {
  const row = {
    user_id: userId,
    business_id: businessId,
    integration_id: integrationId,
    external_message_id: invoice.messageId || null,
    external_thread_id: invoice.threadId || null,
    vendor: invoice.vendor || null,
    invoice_number: invoice.invoiceNumber || null,
    amount: invoice.amount,
    currency: invoice.currency || null,
    due_date: dateOnly(invoice.dueDate),
    decision: invoice.agentDecision || null,
    decision_reasons: invoice.decisionReasons || [],
    extraction: invoice.extraction || {},
    sources: invoice.sources || [],
    payment_id: invoice.paymentId || null,
    raw_fingerprint: fingerprint(invoice),
    updated_at: new Date().toISOString()
  };

  const query =
    "invoices?user_id=eq." + encodeURIComponent(userId) +
    "&external_message_id=eq." + encodeURIComponent(row.external_message_id || "") +
    "&invoice_number=eq." + encodeURIComponent(row.invoice_number || "") +
    "&limit=1";

  const existing = await supabaseRest(query, { token });
  if (existing?.[0]?.id) {
    const updated = await supabaseRest(
      "invoices?id=eq." + encodeURIComponent(existing[0].id),
      { token, method: "PATCH", body: row }
    );
    return updated?.[0] || { ...existing[0], ...row };
  }

  const created = await supabaseRest("invoices", {
    token,
    method: "POST",
    body: { ...row, created_at: new Date().toISOString() }
  });
  return created?.[0] || row;
}

export async function syncBusinessInvoices(token, userId) {
  const business = await getBusiness(token, userId);
  if (!business) throw new Error("Complete business onboarding first");

  const vendors = await getBusinessVendors(token, business.id);
  const registry = registryFromRows(vendors);
  const { integration, accessToken } = await getFreshGmailAccessToken(token, userId);
  const scan = await scanGmailInvoices(accessToken);
  const evaluated = evaluateInvoiceRecords(scan.invoices || [], registry);

  const persisted = [];
  for (const invoice of evaluated.invoices || []) {
    persisted.push(await persistInvoice(token, userId, business.id, integration.id, invoice));
  }

  return {
    scannedAt: scan.scannedAt,
    count: persisted.length,
    business,
    gmail: {
      providerAccountId: integration.provider_account_id,
      status: integration.status
    },
    invoices: persisted
  };
}

export async function listBusinessInvoices(token, userId) {
  const business = await getBusiness(token, userId);
  if (!business) throw new Error("Complete business onboarding first");
  const rows = await supabaseRest(
    "invoices?select=*&business_id=eq." + encodeURIComponent(business.id) + "&order=updated_at.desc&limit=100",
    { token }
  );
  return { business, invoices: rows || [] };
}
