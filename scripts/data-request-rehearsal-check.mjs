import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateGmailRemovalRecord } from './privacy/gmail-request-record.mjs';

// Synthetic identifiers only. Never load a production URL, mailbox or secret here.
const request = {
  version: 1,
  requestId: '00000000-0000-4000-8000-000000000001',
  businessId: '00000000-0000-4000-8000-000000000002',
  ownerUserId: '00000000-0000-4000-8000-000000000003',
  operatorId: '00000000-0000-4000-8000-000000000004',
  scope: 'gmail_credentials',
  receivedAt: '2026-10-23T00:00:00Z',
  identityVerifiedAt: '2026-10-23T00:01:00Z',
  scopeApprovedAt: '2026-10-23T00:02:00Z',
  appliedAt: '2026-10-23T00:03:00Z',
  checkedAt: '2026-10-23T00:04:00Z',
  identityMethod: 'signed_in_owner',
  activeTokensRemoved: true,
  providerMetadataRemoved: true,
  financialRecordsPreserved: true,
  paymentAuthorityChanged: false,
  googleGrantRevoked: false,
  backupStatus: 'expiry_pending',
};

assert.throws(() => validateGmailRemovalRecord({ ...request, scopeApprovedAt: null }), /approval/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, scope: 'workspace_delete' }), /scope/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, ownerUserId: '' }), /ownerUserId/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, identityMethod: 'email_claim' }), /identity/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, identityVerifiedAt: '2026-10-24T00:00:00Z' }), /chronolog/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, checkedAt: 'not-a-date' }), /timestamp/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, activeTokensRemoved: false }), /removal/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, providerMetadataRemoved: false }), /removal/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, paymentAuthorityChanged: true }), /financial/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, financialRecordsPreserved: false }), /financial/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, googleGrantRevoked: true }), /grant/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, backupStatus: 'purged' }), /backup/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, version: 2 }), /version/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, receivedAt: '2026-02-30T00:00:00Z' }), /timestamp/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, refreshToken: 'do-not-retain' }), /field/i);
assert.throws(() => validateGmailRemovalRecord({ ...request, email: 'synthetic@example.invalid' }), /field/i);
assert.throws(() => validateGmailRemovalRecord(null), /record/i);
assert.throws(() => validateGmailRemovalRecord([]), /record/i);
assert.deepEqual(validateGmailRemovalRecord(request), {
  activeRemovalRecorded: true,
  backupErasureProven: false,
  workspaceDeletionComplete: false,
  googleGrantRevocationProven: false,
});

// A minimal independent register stays outside the synthetic restored database.
// This models an old backup reintroducing credentials, not a real backup download.
const independentRegister = structuredClone([request]);
const { PGlite } = await import('@electric-sql/pglite');
const db = new PGlite();
try {
  const baseline = await readFile(new URL('../supabase/migrations/20261004172924_create_inboxpay_multi_user_core.sql', import.meta.url), 'utf8');
  const ddl = baseline.slice(0, baseline.indexOf('alter table public.integrations enable row level security;'));
  await db.exec(`create schema auth; create table auth.users(id uuid primary key); ${ddl}
    alter table public.integrations add column business_id uuid;`);
  await db.query('insert into auth.users values ($1), ($2)', [request.ownerUserId, '00000000-0000-4000-8000-000000000005']);
  for (const [owner, business] of [[request.ownerUserId, request.businessId], ['00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006']]) {
    const integration = (await db.query(`insert into public.integrations(user_id,business_id,provider,access_token_encrypted,refresh_token_encrypted,provider_account_id)
      values ($1,$2,'google_gmail','synthetic-access','synthetic-refresh','synthetic-sub') returning id`, [owner, business])).rows[0].id;
    await db.query(`insert into public.invoices(user_id,integration_id,invoice_number,payment_id,settlement_status,payment_tx_hash)
      values ($1,$2,'SYNTHETIC-ONLY','synthetic-payment','confirmed','synthetic-tx')`, [owner, integration]);
  }
  const before = (await db.query('select * from public.invoices order by user_id')).rows;
  const restored = (await db.query('select count(*)::int n from public.integrations where refresh_token_encrypted is not null')).rows[0].n;
  assert.equal(restored, 2, 'old synthetic database contains credentials');
  for (const entry of independentRegister) validateGmailRemovalRecord(entry);
  const cleanup = await readFile(new URL('./recovery/invalidate-restored-gmail.sql', import.meta.url), 'utf8');
  await assert.rejects(db.exec(cleanup), /isolated restore/);
  await db.exec("set inboxpay.restore_mode = 'isolated';");
  await db.exec(cleanup);
  await db.exec(cleanup);
  assert.equal((await db.query("select count(*)::int n from public.integrations where status <> 'revoked' or access_token_encrypted is not null or refresh_token_encrypted is not null or provider_account_id is not null")).rows[0].n, 0);
  assert.deepEqual((await db.query('select * from public.invoices order by user_id')).rows, before, 'preserve financial evidence across both businesses');
  assert.deepEqual(independentRegister, [request], 'register survives independently of restored database');
  // All Gmail connections require reconnect by the existing restore policy;
  // this does not authorize tenant-specific financial or invoice deletion.
} finally {
  await db.close();
}
console.log('Synthetic Gmail request-record checks passed; not live identity verification or workspace deletion');
