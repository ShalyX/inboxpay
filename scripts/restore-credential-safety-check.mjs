import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sanitize = await readFile(new URL('./recovery/invalidate-restored-gmail.sql', import.meta.url), 'utf8');
const { PGlite } = await import('@electric-sql/pglite');
const db = new PGlite();
const baseline = await readFile(new URL('../supabase/migrations/20261004172924_create_inboxpay_multi_user_core.sql', import.meta.url), 'utf8');
const integrationDDL = baseline.slice(0, baseline.indexOf('create table public.invoices'));
try {
  await db.exec(`create schema auth; create table auth.users(id uuid primary key); ${integrationDDL}
    alter table public.integrations add column business_id uuid;
    create table public.invoices(id integer primary key, integration_id uuid references public.integrations(id), evidence text);
    create table public.policies(id integer primary key, limits text);
    insert into auth.users values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
    insert into public.integrations(id,user_id,provider,status,access_token_encrypted,refresh_token_encrypted,provider_account_id,scopes,token_expires_at)
      values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','google_gmail','connected','old-access','old-refresh','old-sub',array['gmail.readonly'],now()),
             ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','google_gmail','revoked','resurrected-access','resurrected-refresh','old-sub-2',array['gmail.readonly'],now());
    insert into public.invoices values (1,'10000000-0000-0000-0000-000000000001','invoice evidence'),(2,'10000000-0000-0000-0000-000000000002','settled receipt');
    insert into public.policies values(1,'unchanged');`);
  await assert.rejects(db.exec(sanitize), /isolated restore/,'unmarked database must reject sanitization');
  assert.equal((await db.query('select count(*)::int n from public.integrations where access_token_encrypted is not null')).rows[0].n,2);
  await db.exec("set inboxpay.restore_mode = 'isolated';");
  await db.exec(sanitize);
  const rows = (await db.query('select * from public.integrations order by id')).rows;
  assert.equal(rows.length,2,'keep integration rows and references');
  for (const row of rows) {
    assert.equal(row.status,'revoked');
    for (const key of ['access_token_encrypted','refresh_token_encrypted','provider_account_id','token_expires_at']) assert.equal(row[key],null);
    assert.deepEqual(row.scopes,[]);
  }
  assert.deepEqual((await db.query('select evidence from public.invoices order by id')).rows.map(r=>r.evidence),['invoice evidence','settled receipt']);
  assert.equal((await db.query('select limits from public.policies')).rows[0].limits,'unchanged');
  await db.exec(sanitize); // repeatable cleanup
  // A failing verification must roll the entire command back, not leave partial removals.
  await db.exec(`update public.integrations set access_token_encrypted='preserve-on-failure';
    create function public.block_restore_cleanup() returns trigger language plpgsql as $$begin new.refresh_token_encrypted := 'blocked'; return new; end$$;
    create trigger block_restore_cleanup before update on public.integrations for each row execute function public.block_restore_cleanup();`);
  await assert.rejects(db.exec(sanitize),/credential invalidation verification failed/);
  assert.equal((await db.query("select count(*)::int n from public.integrations where access_token_encrypted='preserve-on-failure'")).rows[0].n,2);
  const workflow = await readFile(new URL('../.github/workflows/database-restore-drill.yml',import.meta.url),'utf8');
  assert.ok(workflow.indexOf('invalidate-restored-gmail.sql') > workflow.indexOf('--section=post-data'),'sanitize only after full restore');
  assert.match(workflow,/set inboxpay\.restore_mode = 'isolated'/i);
  assert.match(workflow,/ON_ERROR_STOP=1/);
  assert.match(workflow,/RESTORE_DATABASE_URL: postgresql:\/\/postgres:inboxpay-restore-drill-local-only@127\.0\.0\.1:5432\/inboxpay_restore/,'drill target stays fixed and disposable');
  console.log('Restore credential safety passed in isolated PostgreSQL: guard, removal, preserved evidence, repeatability and rollback');
} finally { await db.close(); }
