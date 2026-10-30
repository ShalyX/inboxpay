import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { runRetention } from './privacy/run-retention.mjs';
import { buildReleaseSQL } from './privacy/build-release-sql.mjs';

const db = new PGlite();
const ownerA = '00000000-0000-4000-8000-000000000001', ownerB = '00000000-0000-4000-8000-000000000002';
const businessA = '10000000-0000-4000-8000-000000000001', businessB = '10000000-0000-4000-8000-000000000002';
const requestA = '20000000-0000-4000-8000-000000000001';
const identity = async (owner, role = 'authenticated') => {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)", [owner, role]);
  await db.exec('set role ' + role);
};
try {
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role bypassrls;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role', true),'')$$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  await db.exec('create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text);');
  for (const file of (await readdir('supabase/migrations')).filter(x => x.endsWith('.sql')).sort()) {
    const source = await readFile('supabase/migrations/' + file, 'utf8');
    if (file.startsWith('20261030000000')) {
      await db.exec(buildReleaseSQL(source));
      await db.exec(buildReleaseSQL(source));
      await assert.rejects(db.exec(buildReleaseSQL(source.replace('begin;', 'begin;\n-- changed source'))), /identity differs/);
      await db.exec('rollback');
      assert.equal((await db.query("select count(*)::int n from supabase_migrations.schema_migrations where version='20261030000000'")).rows[0].n,1);
    } else await db.exec(source);
  }
  await db.query('insert into auth.users values ($1),($2)', [ownerA, ownerB]);
  await db.query("insert into businesses(id,owner_user_id,name,slug) values ($1,$2,'Business A','a'),($3,$4,'Business B','b')", [businessA,ownerA,businessB,ownerB]);
  await identity(ownerA);
  const submit = (id = requestA, business = businessA, scope = 'invoice_evidence') => db.query('select * from request_business_data_removal($1,$2,$3)', [id,business,scope]);
  assert.equal((await submit()).rows[0].status, 'requested');
  assert.equal((await submit()).rows[0].id, requestA, 'same request retry');
  assert.equal((await submit('20000000-0000-4000-8000-000000000002')).rows[0].id, requestA, 'new retry ID cannot open duplicate scope');
  await assert.rejects(submit(requestA, businessA, 'export'), /identity mismatch/);
  await assert.rejects(submit(requestA, businessB), /ownership mismatch/);
  await assert.rejects(submit(requestA, businessA, 'arbitrary_delete'), /Unsupported/);
  await assert.rejects(db.query("update business_data_requests set status='reviewing'"), /permission denied/);
  await assert.rejects(db.query('delete from business_data_requests'), /permission denied/);
  await assert.rejects(db.query('select run_business_data_retention(false,500)'), /permission denied/);
  await identity(ownerB);
  assert.equal((await db.query('select * from business_data_requests')).rows.length, 0, 'two real SQL roles cannot see the other owner request');
  await assert.rejects(submit(), /ownership mismatch/);
  await assert.rejects(submit(requestA, businessB), /identity mismatch/, 'another owner cannot reuse a receipt ID');
  await identity('', 'anon');
  await assert.rejects(db.query('select * from business_data_requests'), /permission denied/);
  await assert.rejects(submit(), /permission denied/);
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.role','',false)");
  await assert.rejects(db.query('select run_business_data_retention(false,500)'), /Service role required/, 'missing claim fails closed even with SQL owner privileges');
  await identity(ownerA, 'service_role');
  for (const [business, owner] of [[businessA,ownerA],[businessB,ownerB]]) {
    await db.query(`insert into business_notification_link_tokens(business_id,user_id,channel,token_hash,expires_at)
      values ($1,$2,'telegram',$3,now()-interval '2 days'),($1,$2,'telegram',$4,now()-interval '1 hour'),($1,$2,'telegram',$5,now()+interval '1 day')`, [business,owner,business+'old',business+'recent',business+'live']);
    const channel = (await db.query(`insert into business_notification_channels(business_id,user_id,channel,destination_encrypted,destination_hint)
      values ($1,$2,'telegram','synthetic-secret','chat-hint') returning id,linked_at`, [business,owner])).rows[0];
    await db.query(`insert into invoices(user_id,business_id,settlement_network,invoice_number,payment_id,settlement_status,payment_tx_hash)
      values ($1,$2,'ARC-TESTNET','synthetic-invoice',$3,'confirmed','synthetic-hash')`, [owner,business,business+'payment']);
    for (const [status, age] of [['delivered',40],['failed',40],['skipped',40],['queued',40],['leased',40],['delivered',2]]) {
      await db.query(`insert into business_payment_notification_jobs(business_id,user_id,network,channel_id,channel_linked_at,event_type,source_key,payload,status,updated_at,last_error,telegram_message_id)
        values ($1,$2,'ARC-TESTNET',$3,$4,'payment_confirmed',$5,'{"vendor":"private-vendor","invoice_number":"private-invoice"}'::jsonb,$6,now()-($7*interval '1 day'),'private-error',123)`,
        [business,owner,channel.id,channel.linked_at,business+status+age,status,age]);
    }
  }
  const financial = (await db.query('select * from invoices order by id')).rows;
  const dry = (await db.query('select run_business_data_retention() result')).rows[0].result;
  assert.equal(dry.dryRun, true); assert.equal(dry.expiredLinks, 2); assert.equal(dry.terminalPayloads, 6);
  const productionDryRun = (await readFile('scripts/verification/privacy-retention-dry-run.sql','utf8')).replace(/^\\set[^\n]*\n/m,'');
  await db.exec('reset role');
  await db.exec(productionDryRun);
  await identity(ownerA, 'service_role');
  assert.equal((await db.query('select count(*)::int n from business_notification_link_tokens')).rows[0].n, 6);
  await assert.rejects(db.query('select run_business_data_retention(null,500)'), /Invalid/);
  await assert.rejects(db.query('select run_business_data_retention(false,1001)'), /Invalid/);
  // Force a later mutation to fail: earlier token removals must roll back too.
  await db.exec('reset role');
  await db.exec(`create function block_redaction() returns trigger language plpgsql as $$begin raise exception 'synthetic failure'; end$$;
    create trigger block_redaction before update on business_payment_notification_jobs for each row execute function block_redaction();`);
  await identity(ownerA, 'service_role');
  await assert.rejects(db.query('select run_business_data_retention(false,500)'), /synthetic failure/);
  assert.equal((await db.query('select count(*)::int n from business_notification_link_tokens')).rows[0].n, 6);
  await db.exec('reset role; drop trigger block_redaction on business_payment_notification_jobs');
  await identity(ownerA, 'service_role');
  const applied = (await db.query('select run_business_data_retention(false,1) result')).rows[0].result;
  assert.equal(applied.expiredLinks, 1); assert.equal(applied.terminalPayloads, 1, 'bounded batch');
  const applyBatch = (await readFile('scripts/privacy/apply-retention-batch.sql','utf8')).replace(/^\\set[^\n]*\n/m,'');
  await assert.rejects(db.exec(applyBatch),/Explicit retention apply approval/);
  await db.exec('rollback');
  await db.exec("set inboxpay.retention_mode='approved_apply'");
  await db.exec(`reset role;
    create function tamper_retention_readback() returns trigger language plpgsql as $$begin new.source_key := new.source_key || ':tampered'; return new; end$$;
    create trigger tamper_retention_readback before update on business_payment_notification_jobs for each row execute function tamper_retention_readback();`);
  await identity(ownerA,'service_role');
  await assert.rejects(db.exec(applyBatch),/Retention readback failed/);
  await db.exec('rollback');
  assert.equal((await db.query('select count(*)::int n from business_notification_link_tokens')).rows[0].n,5,'failed readback rolls back deletion');
  await db.exec('reset role; drop trigger tamper_retention_readback on business_payment_notification_jobs');
  await identity(ownerA,'service_role');
  const verifiedBatch = await db.exec(applyBatch);
  const receipt = verifiedBatch.flatMap(result=>result.rows).find(row=>row.committed_retention_receipt)?.committed_retention_receipt;
  assert.equal(receipt?.verified,true);assert.equal(receipt.applied.expiredLinks,1);assert.equal(receipt.applied.terminalPayloads,5);
  assert.equal(receipt.remaining.expiredLinks,0);assert.equal(receipt.remaining.terminalPayloads,0);
  const repeated = (await db.query('select run_business_data_retention(false,500) result')).rows[0].result;
  assert.equal(repeated.expiredLinks,0); assert.equal(repeated.terminalPayloads,0);
  assert.equal((await db.query('select count(*)::int n from business_payment_notification_jobs')).rows[0].n,12,'dedupe rows preserved');
  assert.equal((await db.query("select count(*)::int n from business_payment_notification_jobs where payload='{}' and last_error is null and telegram_message_id is null and payload_redacted_at is not null")).rows[0].n,6);
  assert.equal((await db.query("select count(*)::int n from business_payment_notification_jobs where status in ('queued','leased') and payload <> '{}'::jsonb")).rows[0].n,4,'pending delivery data untouched');
  await assert.rejects(db.query("update business_payment_notification_jobs set status='queued' where payload_redacted_at is not null"), /cannot be reactivated/);
  await assert.rejects(db.query("update business_payment_notification_jobs set payload='{" + '"vendor":"resurrected"' + "}' where payload_redacted_at is not null"), /cannot be reactivated/);
  const source = businessA+'delivered40';
  const before = (await db.query('select count(*)::int n from business_payment_notification_jobs')).rows[0].n;
  await db.query(`insert into business_payment_notification_jobs select gen_random_uuid(),business_id,user_id,invoice_id,network,channel_id,channel_linked_at,event_type,source_key,payload,status,attempt_count,next_attempt_at,lease_token,lease_expires_at,telegram_message_id,last_error,created_at,delivered_at,updated_at,payload_redacted_at
    from business_payment_notification_jobs where source_key=$1 on conflict(source_key) do nothing`, [source]);
  assert.equal((await db.query('select count(*)::int n from business_payment_notification_jobs')).rows[0].n,before,'source key still rejects replay');
  assert.deepEqual((await db.query('select * from invoices order by id')).rows, financial);
  await db.exec('reset role');
  const restore = await readFile('scripts/recovery/invalidate-restored-notifications.sql','utf8');
  await assert.rejects(db.exec(restore), /isolated restore/);
  await db.exec('rollback');
  await db.exec("set inboxpay.restore_mode='isolated'");
  await db.exec(`create function block_notification_cleanup() returns trigger language plpgsql as $$begin new.destination_encrypted := 'blocked'; return new; end$$;
    create trigger block_notification_cleanup before update on business_notification_channels for each row execute function block_notification_cleanup();`);
  await assert.rejects(db.exec(restore), /cleanup verification failed/);
  await db.exec('rollback');
  assert.equal((await db.query('select count(*)::int n from business_notification_link_tokens')).rows[0].n,4,'failed restore cleanup must roll back token deletion');
  await db.exec('drop trigger block_notification_cleanup on business_notification_channels');
  await db.exec(restore); await db.exec(restore);
  assert.equal((await db.query("select count(*)::int n from business_notification_channels where status='active' or destination_encrypted<>''")).rows[0].n,0);
  assert.equal((await db.query("select count(*)::int n from business_payment_notification_jobs where status<>'skipped' or payload<>'{}'")).rows[0].n,0);
  assert.deepEqual((await db.query('select * from invoices order by id')).rows, financial, 'restore does not touch financial receipts');
} finally { await db.close(); }

const env = { SUPABASE_URL:'https://synthetic.supabase.co', SUPABASE_RETENTION_SERVICE_KEY:'synthetic-key' };
let calls=0;
const fakeFetch = async (_url, options) => { calls++; assert.doesNotMatch(options.body,/synthetic-key/); return new Response(JSON.stringify({dryRun:JSON.parse(options.body).p_dry_run,expiredLinks:0,terminalPayloads:1,batchSize:500})); };
await assert.rejects(runRetention({env,apply:true,fetchImpl:fakeFetch}),/disabled/); assert.equal(calls,0);
await assert.rejects(runRetention({env:{...env,SUPABASE_URL:'https://example.invalid'},fetchImpl:fakeFetch}),/Supabase origin/); assert.equal(calls,0);
await runRetention({env,fetchImpl:fakeFetch}); assert.equal(calls,1);
await runRetention({env:{...env,INBOXPAY_RETENTION_ENABLED:'true'},apply:true,fetchImpl:fakeFetch});
await assert.rejects(runRetention({env,fetchImpl:async()=>new Response('{}',{status:503})}),/failed/);
console.log('Privacy SQL: full migrations, two-owner RLS, idempotent requests, bounded retention, rollback, replay protection and isolated notification recovery passed');
