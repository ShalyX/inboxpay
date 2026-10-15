import { keccak256 } from "viem";
import { getBusiness, getBusinessForNetwork } from "./businesses.mjs";
import { evaluateInvoiceRecords } from "./evaluator.mjs";
import { getFreshGmailAccessToken } from "./gmail-account.mjs";
import { scanGmailInvoices } from "./gmail-live.mjs";
import { supabaseRest } from "./supabase-server.mjs";

export { getBusiness };

export async function getBusinessVendors(token, businessId, network) {
  return await supabaseRest(
    "vendors?select=*&business_id=eq." + encodeURIComponent(businessId) +
      "&network=eq." + encodeURIComponent(network) + "&order=name",
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

function invoiceIdentityKey(invoice) {
  return [
    String(invoice.vendor || "").trim().toLowerCase(),
    String(invoice.invoice_number || invoice.invoiceNumber || "").trim().toLowerCase(),
    String(invoice.due_date || invoice.dueDate || "").trim()
  ].join("|");
}

function preferredInvoice(current, candidate) {
  if (!current) return candidate;
  if (current.settlement_status === "confirmed") return current;
  if (candidate.settlement_status === "confirmed") return candidate;
  if (current.settlement_status === "processing") return current;
  if (candidate.settlement_status === "processing") return candidate;
  return new Date(candidate.updated_at || candidate.created_at || 0) > new Date(current.updated_at || current.created_at || 0)
    ? candidate
    : current;
}

export function dedupeInvoiceRows(rows) {
  const byIdentity = new Map();
  for (const row of rows || []) {
    const key = invoiceIdentityKey(row) || "row:" + row.id;
    byIdentity.set(key, preferredInvoice(byIdentity.get(key), row));
  }
  return [...byIdentity.values()];
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

export async function persistInvoice(token, userId, businessId, integrationId, invoice, network = invoice?.settlementNetwork || "ARC-TESTNET") {
  const row = {
    user_id: userId,
    business_id: businessId,
    integration_id: integrationId,
    settlement_network: network,
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

  const dueDateFilter = row.due_date
    ? "&due_date=eq." + encodeURIComponent(row.due_date)
    : "&due_date=is.null";
  const identityQuery =
    "invoices?user_id=eq." + encodeURIComponent(userId) +
    "&business_id=eq." + encodeURIComponent(businessId) +
    "&settlement_network=eq." + encodeURIComponent(network) +
    "&vendor=eq." + encodeURIComponent(row.vendor || "") +
    "&invoice_number=eq." + encodeURIComponent(row.invoice_number || "") +
    dueDateFilter +
    "&order=created_at.asc&limit=100";
  const uniqueQuery = row.external_message_id && row.invoice_number
    ? "invoices?user_id=eq." + encodeURIComponent(userId) +
      "&external_message_id=eq." + encodeURIComponent(row.external_message_id) +
      "&invoice_number=eq." + encodeURIComponent(row.invoice_number) +
      "&settlement_network=eq." + encodeURIComponent(network) +
      "&limit=1"
    : null;

  const updateExisting = async (existing) => {
    const updated = await supabaseRest(
      "invoices?id=eq." + encodeURIComponent(existing.id) +
        "&business_id=eq." + encodeURIComponent(businessId) +
        "&settlement_network=eq." + encodeURIComponent(network),
      { token, method: "PATCH", body: { ...row, payment_id: existing.payment_id || row.payment_id } }
    );
    return updated?.[0] || { ...existing, ...row, payment_id: existing.payment_id || row.payment_id };
  };

  let existingRows = uniqueQuery ? await supabaseRest(uniqueQuery, { token }) : [];
  if (!existingRows?.length) existingRows = await supabaseRest(identityQuery, { token });
  const existing = (existingRows || []).find((candidate) => candidate.settlement_status === "confirmed") || existingRows?.[0];
  if (existing?.id) return updateExisting(existing);

  try {
    const created = await supabaseRest("invoices", {
      token,
      method: "POST",
      body: { ...row, created_at: new Date().toISOString() }
    });
    return created?.[0] || row;
  } catch (error) {
    if (!uniqueQuery || !String(error?.message || "").startsWith("Supabase 409:")) throw error;
    const conflictingRows = await supabaseRest(uniqueQuery, { token });
    const conflicting = (conflictingRows || []).find((candidate) => candidate.id);
    if (!conflicting) throw error;
    return updateExisting(conflicting);
  }

}

async function recordEvaluationDecision(token, userId, business, invoice) {
  if (!invoice?.id) return;
  const prior = await supabaseRest(
    "audit_events?select=id,data&business_id=eq." + encodeURIComponent(business.id) +
      "&user_id=eq." + encodeURIComponent(userId) +
      "&network=eq." + encodeURIComponent(business.wallet_blockchain) +
      "&invoice_id=eq." + encodeURIComponent(invoice.id) +
      "&event_type=eq.invoice_evaluated&order=created_at.desc&limit=1",
    { token }
  );
  const last = prior?.[0]?.data || null;
  if (last?.decision === invoice.decision && last?.raw_fingerprint === invoice.raw_fingerprint) return;
  await supabaseRest("audit_events", {
    token,
    method: "POST",
    body: {
      user_id: userId,
      business_id: business.id,
      network: business.wallet_blockchain,
      invoice_id: invoice.id,
      event_type: "invoice_evaluated",
      actor: "agent",
      data: {
        invoice_number: invoice.invoice_number,
        decision: invoice.decision,
        reasons: invoice.decision_reasons || [],
        raw_fingerprint: invoice.raw_fingerprint
      }
    }
  });
}

async function syncInvoicesForBusiness(token, userId, business) {
  if (!business) throw new Error("Complete business onboarding first");

  const vendors = await getBusinessVendors(token, business.id, business.wallet_blockchain);
  const registry = registryFromRows(vendors);
  const { integration, accessToken } = await getFreshGmailAccessToken(token, userId, business.id);
  const scan = await scanGmailInvoices(accessToken);
  const evaluated = evaluateInvoiceRecords(scan.invoices || [], registry);

  const persisted = [];
  const uniqueInvoices = new Map();
  for (const invoice of evaluated.invoices || []) {
    uniqueInvoices.set(invoiceIdentityKey(invoice), invoice);
  }
  for (const invoice of uniqueInvoices.values()) {
    const saved = await persistInvoice(token, userId, business.id, integration.id, invoice, business.wallet_blockchain);
    await recordEvaluationDecision(token, userId, business, saved);
    persisted.push(saved);
  }

  const rows = await supabaseRest(
    "invoices?select=*&business_id=eq." + encodeURIComponent(business.id) +
      "&settlement_network=eq." + encodeURIComponent(business.wallet_blockchain) + "&order=updated_at.desc&limit=100",
    { token }
  );
  const invoices = dedupeInvoiceRows(rows || []);

  return {
    scannedAt: scan.scannedAt,
    count: invoices.length,
    business,
    gmail: {
      providerAccountId: integration.provider_account_id,
      status: integration.status
    },
    invoices
  };
}

export async function syncBusinessInvoices(token, userId) {
  return syncInvoicesForBusiness(token, userId, await getBusiness(token, userId));
}

export async function syncBusinessInvoicesForNetwork(token, userId, network) {
  return syncInvoicesForBusiness(token, userId, await getBusinessForNetwork(token, userId, network));
}

export async function listBusinessInvoices(token, userId) {
  const business = await getBusiness(token, userId);
  if (!business) throw new Error("Complete business onboarding first");
  const rows = await supabaseRest(
    "invoices?select=*&business_id=eq." + encodeURIComponent(business.id) +
      "&settlement_network=eq." + encodeURIComponent(business.wallet_blockchain) + "&order=updated_at.desc&limit=100",
    { token }
  );
  return { business, invoices: dedupeInvoiceRows(rows || []) };
}
