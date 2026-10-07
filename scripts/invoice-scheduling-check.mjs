import assert from "node:assert/strict";
import { isScheduleDue, resolveScheduleEvents, scheduleEvents, scheduleForDueDate, validateScheduleTarget } from "../lib/invoice-scheduling.mjs";

const now = new Date("2026-10-07T12:00:00.000Z");
assert.equal(scheduleForDueDate("2026-10-08", now), "2026-10-08T09:00:00.000Z");
assert.equal(validateScheduleTarget("2026-10-08T13:00:00Z", now), "2026-10-08T13:00:00.000Z");
assert.throws(() => scheduleForDueDate("2026-10-06", now), /future/);
assert.throws(() => scheduleForDueDate("not-a-date", now), /valid date/);
assert.throws(() => validateScheduleTarget("2028-10-08T13:00:00Z", now), /366 days/);
assert.throws(() => scheduleForDueDate(null, now), /due date/);
assert.equal(isScheduleDue({ scheduledFor: "2026-10-07T12:00:00.000Z" }, now), true);
assert.equal(isScheduleDue({ scheduledFor: "2026-10-07T12:00:00.001Z" }, now), false);
assert.equal(isScheduleDue({ scheduledFor: null }, now), false);

const queued = resolveScheduleEvents([
  { id: "schedule-1", event_type: "invoice_scheduled", created_at: "2026-10-07T12:01:00Z", data: { scheduled_for: "2026-10-08T09:00:00.000Z", reason: "review" } },
  { id: "cancel-1", event_type: "invoice_schedule_cancelled", created_at: "2026-10-07T12:02:00Z", data: {} },
  { id: "schedule-2", event_type: "invoice_scheduled", created_at: "2026-10-07T12:03:00Z", data: { scheduled_for: "2026-10-09T09:00:00.000Z", reason: "review again" } },
  { id: "reschedule-1", event_type: "invoice_schedule_rescheduled", created_at: "2026-10-07T12:04:00Z", data: { scheduled_for: "2026-10-10T09:00:00.000Z", reason: "owner moved review" } },
  { id: "due-1", event_type: "invoice_schedule_due", created_at: "2026-10-10T09:00:00Z", data: { transition: "review" } }
]);
assert.deepEqual(queued, { status: "queued", scheduledFor: "2026-10-10T09:00:00.000Z", reason: "owner moved review", createdAt: "2026-10-07T12:04:00Z", eventId: "reschedule-1" });
assert.equal(resolveScheduleEvents([{ event_type: "invoice_schedule_cancelled", created_at: "2026-10-07T12:03:00Z", data: {} }]), null);

let requestedPath = "";
const queriedEvents = await scheduleEvents("token", "business-1", "user-1", "invoice-1", async (path) => {
  requestedPath = path;
  return [
    { id: "schedule-1", event_type: "invoice_scheduled", created_at: "2026-10-07T12:01:00Z", data: { scheduled_for: "2026-10-08T09:00:00.000Z", reason: "review" } },
    { id: "reschedule-1", event_type: "invoice_schedule_rescheduled", created_at: "2026-10-07T12:04:00Z", data: { scheduled_for: "2026-10-10T09:00:00.000Z", reason: "owner moved review" } }
  ];
});
assert.match(requestedPath, /event_type=in\.\(invoice_scheduled,invoice_schedule_rescheduled,invoice_schedule_cancelled\)/);
assert.equal(resolveScheduleEvents(queriedEvents)?.scheduledFor, "2026-10-10T09:00:00.000Z");

console.log("invoice scheduling checks passed");
