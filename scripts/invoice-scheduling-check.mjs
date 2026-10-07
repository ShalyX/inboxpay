import assert from "node:assert/strict";
import { resolveScheduleEvents, scheduleForDueDate, validateScheduleTarget } from "../lib/invoice-scheduling.mjs";

const now = new Date("2026-10-07T12:00:00.000Z");
assert.equal(scheduleForDueDate("2026-10-08", now), "2026-10-08T09:00:00.000Z");
assert.equal(validateScheduleTarget("2026-10-08T13:00:00Z", now), "2026-10-08T13:00:00.000Z");
assert.throws(() => scheduleForDueDate("2026-10-06", now), /future/);
assert.throws(() => scheduleForDueDate("not-a-date", now), /valid date/);
assert.throws(() => validateScheduleTarget("2028-10-08T13:00:00Z", now), /366 days/);
assert.throws(() => scheduleForDueDate(null, now), /due date/);

const queued = resolveScheduleEvents([
  { id: "schedule-1", event_type: "invoice_scheduled", created_at: "2026-10-07T12:01:00Z", data: { scheduled_for: "2026-10-08T09:00:00.000Z", reason: "review" } },
  { id: "cancel-1", event_type: "invoice_schedule_cancelled", created_at: "2026-10-07T12:02:00Z", data: {} },
  { id: "schedule-2", event_type: "invoice_scheduled", created_at: "2026-10-07T12:03:00Z", data: { scheduled_for: "2026-10-09T09:00:00.000Z", reason: "review again" } },
  { id: "reschedule-1", event_type: "invoice_schedule_rescheduled", created_at: "2026-10-07T12:04:00Z", data: { scheduled_for: "2026-10-10T09:00:00.000Z", reason: "owner moved review" } }
]);
assert.deepEqual(queued, { status: "queued", scheduledFor: "2026-10-10T09:00:00.000Z", reason: "owner moved review", createdAt: "2026-10-07T12:04:00Z", eventId: "reschedule-1" });
assert.equal(resolveScheduleEvents([{ event_type: "invoice_schedule_cancelled", created_at: "2026-10-07T12:03:00Z", data: {} }]), null);

console.log("invoice scheduling checks passed");
