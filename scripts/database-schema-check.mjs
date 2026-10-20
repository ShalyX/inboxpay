import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const migrationDirectory = path.resolve("supabase", "migrations");
const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
const requiredFiles = [
  "20261004172924_create_inboxpay_multi_user_core.sql",
  "20261004174052_add_business_wallet_and_vendor_tenants.sql",
  "20261004175622_add_business_policy_contract_state.sql",
  "20261004175808_track_policy_contract_configuration.sql",
  "20261012000000_business_network_accounts.sql",
  "20261015000000_vendor_aware_invoice_discovery.sql",
  "20261015010000_autonomy_and_withdrawals.sql",
  "20261017232500_operations_service_states.sql",
  "20261019000000_business_notification_channels.sql",
  "20261019000001_fix_telegram_link_conflict.sql",
  "20261020000000_customer_payment_notifications.sql",
  "20261020000001_financial_write_boundary.sql"
];

assert.deepEqual(files, requiredFiles, "Migration inventory or ordering changed without updating the schema gate");

const sql = Object.fromEntries(await Promise.all(files.map(async (file) => [
  file,
  await readFile(path.join(migrationDirectory, file), "utf8")
])));

const baseline = sql[requiredFiles[0]];
for (const table of ["integrations", "invoices", "policies", "audit_events"]) {
  assert.match(baseline, new RegExp(`create table public\\.${table}\\b`, "i"));
  assert.match(baseline, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
}

const tenancy = sql[requiredFiles[1]];
assert.match(tenancy, /create table public\.businesses\b/i);
assert.match(tenancy, /create table public\.vendors\b/i);
assert.match(tenancy, /business owners own vendors/i);

const combined = Object.values(sql).join("\n");
for (const table of ["business_network_accounts", "invoice_execution_jobs", "wallet_withdrawals", "operations_service_states", "business_notification_channels", "business_notification_link_tokens", "business_payment_notification_jobs"]) {
  assert.match(combined, new RegExp(`create table(?: if not exists)? public\\.${table}\\b`, "i"));
  assert.match(combined, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
}
assert.match(combined, /revoke all on public\.business_notification_channels from anon, authenticated/i);
assert.match(combined, /revoke all on public\.business_notification_link_tokens from anon, authenticated/i);

assert.match(combined, /create policy[\s\S]*audit_events[\s\S]*for insert/i,
  "Audit events must retain the owner-scoped insert policy");
assert.match(combined, /claim_invoice_execution_jobs/i,
  "The durable autonomy queue claim function must remain in migrations");
assert.match(combined, /create or replace function public\.consume_business_telegram_link/i);
assert.match(combined, /revoke all on function public\.consume_business_telegram_link\(text, text, text, text\) from public, anon, authenticated/i);
assert.match(sql["20261019000001_fix_telegram_link_conflict.sql"], /on conflict on constraint business_notification_channels_business_id_channel_key/i,
  "Telegram link upsert must avoid PL/pgSQL output-parameter ambiguity");
const customer = sql["20261020000000_customer_payment_notifications.sql"];
assert.match(customer, /after insert on public\.audit_events/i);
assert.match(customer, /auth\.role\(\) <> 'service_role'/i,
  "Owner-writable audit rows must not generate customer payment alerts");
assert.match(customer, /invoice_record\.settlement_status is distinct from 'confirmed'/i,
  "Confirmed customer alerts require the persisted reconciled state");
assert.match(customer, /for update skip locked/i);
assert.match(customer, /revoke all on public\.business_payment_notification_jobs from anon, authenticated/i);
const financialBoundary = sql["20261020000001_financial_write_boundary.sql"];
for (const table of ["invoices", "audit_events"]) {
  assert.match(financialBoundary, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
  assert.match(financialBoundary, new RegExp(`grant select on table public\\.${table} to authenticated`, "i"));
}
assert.match(financialBoundary, /create policy "users own invoices" on public\.invoices\s+for select to authenticated/i,
  "Invoice owner RLS must no longer permit direct writes even if table grants change");

console.log(`Database schema gate passed (${files.length} ordered migrations)`);
