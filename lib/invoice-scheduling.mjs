import { getBusiness } from "./businesses.mjs";
import { supabaseRest } from "./supabase-server.mjs";

const MAX_SCHEDULE_DAYS = 366;

export function scheduleForDueDate(dueDate, now = new Date()) {
  if (!dueDate) throw new Error("Scheduled invoices need a due date");
  const target = new Date(String(dueDate).slice(0, 10) + "T09:00:00.000Z");
  if (Number.isNaN(target.getTime())) throw new Error("Due date must be a valid date");
  return validateScheduleTarget(target.toISOString(), now);
}

export function validateScheduleTarget(value, now = new Date()) {
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) throw new Error("Scheduled time must be a valid ISO date");
  const current = new Date(now);
  if (Number.isNaN(current.getTime())) throw new Error("Current time is invalid");
  if (target.getTime() <= current.getTime()) throw new Error("Scheduled time must be in the future");
  if (target.getTime() > current.getTime() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error("Scheduled time cannot be more than 366 days ahead");
  }
  return target.toISOString();
}

export function isScheduleDue(schedule, now = new Date()) {
  const target = Date.parse(schedule?.scheduledFor || "");
  const current = new Date(now).getTime();
  return Number.isFinite(target) && Number.isFinite(current) && target <= current;
}

export function resolveScheduleEvents(events = []) {
  const ordered = [...events].sort((a, b) => Date.parse(a.created_at || "") - Date.parse(b.created_at || ""));
  let state = null;
  for (const event of ordered) {
    if (event.event_type === "invoice_scheduled" || event.event_type === "invoice_schedule_rescheduled") {
      state = {
        status: "queued",
        scheduledFor: event.data?.scheduled_for || null,
        reason: event.data?.reason || "Queued for explicit payment review",
        createdAt: event.created_at || null,
        eventId: event.id || null
      };
    } else if (event.event_type === "invoice_schedule_cancelled") {
      state = null;
    }
  }
  return state;
}

async function invoiceFor(token, userId, businessId, invoiceNumber) {
  const rows = await supabaseRest(
    "invoices?select=*&user_id=eq." + encodeURIComponent(userId) +
      "&business_id=eq." + encodeURIComponent(businessId) +
      "&invoice_number=eq." + encodeURIComponent(invoiceNumber) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

export async function scheduleEvents(token, businessId, userId, invoiceId, rest = supabaseRest) {
  return await rest(
    "audit_events?select=id,event_type,data,created_at&business_id=eq." + encodeURIComponent(businessId) +
      "&user_id=eq." + encodeURIComponent(userId) +
      "&invoice_id=eq." + encodeURIComponent(invoiceId) +
      "&event_type=in.(invoice_scheduled,invoice_schedule_rescheduled,invoice_schedule_cancelled)&order=created_at.desc&limit=50",
    { token }
  ) || [];
}

export async function invoiceScheduleStates(token, businessId, userId, invoices = []) {
  const scheduled = (invoices || []).filter((invoice) => ["scheduled", "review"].includes(invoice.settlement_status));
  const entries = await Promise.all(scheduled.map(async (invoice) => [
    invoice.id,
    resolveScheduleEvents(await scheduleEvents(token, businessId, userId, invoice.id))
  ]));
  return new Map(entries.filter(([, state]) => state));
}

export async function advanceDueSchedules(token, userId, business, invoices = [], now = new Date()) {
  const candidates = (invoices || []).filter((invoice) => invoice.settlement_status === "scheduled");
  const transitioned = [];
  let due = 0;
  let auditFailures = 0;

  for (const invoice of candidates) {
    const schedule = resolveScheduleEvents(await scheduleEvents(token, business.id, userId, invoice.id));
    if (!isScheduleDue(schedule, now)) continue;
    due += 1;
    const updated = await supabaseRest(
      "invoices?id=" + encodeURIComponent(invoice.id) +
        "&business_id=eq." + encodeURIComponent(business.id) +
        "&user_id=eq." + encodeURIComponent(userId) +
        "&settlement_status=eq.scheduled",
      { token, method: "PATCH", body: { settlement_status: "review", updated_at: new Date().toISOString() } }
    );
    if (!updated?.[0]) continue;

    try {
      await supabaseRest("audit_events", {
        token,
        method: "POST",
        body: {
          user_id: userId,
          business_id: business.id,
          invoice_id: invoice.id,
          event_type: "invoice_schedule_due",
          actor: "agent",
          data: {
            invoice_number: invoice.invoice_number,
            scheduled_for: schedule.scheduledFor,
            transition: "review",
            execution: "manual_review_required",
            reason: "The review target has arrived; vendor verification, live policy preflight, and explicit payment authorization are still required."
          }
        }
      });
    } catch (error) {
      auditFailures += 1;
      console.error("InboxPay schedule due audit failed", { invoiceId: invoice.id, message: error.message });
    }
    transitioned.push(updated[0]);
  }

  const replacements = new Map(transitioned.map((invoice) => [invoice.id, invoice]));
  return {
    invoices: (invoices || []).map((invoice) => replacements.get(invoice.id) || invoice),
    scanned: candidates.length,
    due,
    transitioned: transitioned.length,
    auditFailures
  };
}

export async function scheduleBusinessInvoice(token, userId, invoiceNumber, { action = "schedule", scheduledFor } = {}) {
  const business = await getBusiness(token, userId);
  if (!business) throw new Error("Complete business onboarding first");
  const invoice = await invoiceFor(token, userId, business.id, invoiceNumber);
  if (!invoice) throw new Error("Invoice not found: " + invoiceNumber);

  const currentEvents = await scheduleEvents(token, business.id, userId, invoice.id);
  const currentSchedule = resolveScheduleEvents(currentEvents);

  if (action === "cancel") {
    const queuedState = ["scheduled", "review"].includes(invoice.settlement_status) && currentSchedule;
    if (!queuedState) {
      return { business, invoice, schedule: null, idempotent: true };
    }
    const cleared = await supabaseRest(
      "invoices?id=eq." + encodeURIComponent(invoice.id) + "&business_id=eq." + encodeURIComponent(business.id) +
        "&settlement_status=eq." + encodeURIComponent(invoice.settlement_status),
      { token, method: "PATCH", body: { settlement_status: null, updated_at: new Date().toISOString() } }
    );
    if (!cleared?.[0]) {
      const latest = await invoiceFor(token, userId, business.id, invoiceNumber);
      if (latest?.settlement_status !== "scheduled") return { business, invoice: latest || invoice, schedule: null, idempotent: true };
      throw new Error("The schedule changed before it could be cancelled. Refresh and try again.");
    }
    await supabaseRest("audit_events", {
      token,
      method: "POST",
      body: {
        user_id: userId,
        business_id: business.id,
        invoice_id: invoice.id,
        event_type: "invoice_schedule_cancelled",
        actor: "user",
        data: { invoice_number: invoice.invoice_number, previous_scheduled_for: currentSchedule?.scheduledFor || null }
      }
    });
    return { business, invoice: cleared[0], schedule: null, idempotent: false };
  }

  if (action === "reschedule") {
    if (invoice.settlement_status !== "scheduled") {
      throw new Error("Only a queued invoice can be rescheduled");
    }
    if (!scheduledFor) throw new Error("A new scheduled time is required");
    const target = validateScheduleTarget(scheduledFor, new Date());
    const reason = "Review queue rescheduled by the business owner; vendor verification and live policy preflight remain required before any payment.";
    const eventRows = await supabaseRest("audit_events", {
      token,
      method: "POST",
      body: {
        user_id: userId,
        business_id: business.id,
        invoice_id: invoice.id,
        event_type: "invoice_schedule_rescheduled",
        actor: "user",
        data: {
          invoice_number: invoice.invoice_number,
          scheduled_for: target,
          previous_scheduled_for: currentSchedule?.scheduledFor || null,
          reason,
          execution: "manual_review_required"
        }
      }
    });
    return {
      business,
      invoice,
      schedule: {
        status: "queued",
        scheduledFor: target,
        reason,
        createdAt: eventRows?.[0]?.created_at || new Date().toISOString(),
        eventId: eventRows?.[0]?.id || null
      },
      idempotent: false
    };
  }

  if (invoice.decision !== "SCHEDULE") throw new Error("Only invoices with a SCHEDULE decision can enter the schedule queue");
  if (invoice.settlement_status === "scheduled") {
    return { business, invoice, schedule: currentSchedule, idempotent: true };
  }
  if (invoice.settlement_status) throw new Error("Invoice cannot be scheduled from settlement state " + invoice.settlement_status);

  const target = validateScheduleTarget(
    scheduledFor || scheduleForDueDate(invoice.due_date),
    new Date()
  );
  const reason = "Queued for explicit payment review; vendor verification and live policy preflight remain required before any payment.";
  const eventRows = await supabaseRest("audit_events", {
    token,
    method: "POST",
    body: {
      user_id: userId,
      business_id: business.id,
      invoice_id: invoice.id,
      event_type: "invoice_scheduled",
      actor: "user",
      data: { invoice_number: invoice.invoice_number, scheduled_for: target, reason, execution: "manual_review_required" }
    }
  });
  const claimed = await supabaseRest(
    "invoices?id=eq." + encodeURIComponent(invoice.id) + "&business_id=eq." + encodeURIComponent(business.id) + "&settlement_status=is.null&decision=eq.SCHEDULE",
    { token, method: "PATCH", body: { settlement_status: "scheduled", updated_at: new Date().toISOString() } }
  );
  if (!claimed?.[0]) {
    const latest = await invoiceFor(token, userId, business.id, invoiceNumber);
    if (latest?.settlement_status === "scheduled") {
      return { business, invoice: latest, schedule: currentSchedule || { status: "queued", scheduledFor: target, reason, eventId: eventRows?.[0]?.id || null }, idempotent: true };
    }
    throw new Error("The invoice changed before it could be scheduled. Refresh and try again.");
  }
  return {
    business,
    invoice: claimed[0],
    schedule: { status: "queued", scheduledFor: target, reason, createdAt: eventRows?.[0]?.created_at || new Date().toISOString(), eventId: eventRows?.[0]?.id || null },
    idempotent: false
  };
}
