import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function buildReleaseSQL(input) {
  const source = input.replaceAll('\r\n', '\n').trim();
  if (!source.startsWith('begin;\n') || !source.endsWith('\ncommit;')) throw new Error('Expected one migration transaction');
  const body = source.slice('begin;'.length, -'commit;'.length).trim();
  if (body.includes('$inboxpay_source$') || body.includes('$inboxpay_release$')) throw new Error('Unexpected SQL delimiter');
  const digest = createHash('sha256').update(source).digest('hex');
  // Ledger and DDL commit together. An unknown ledger or changed already-applied
  // source fails closed; retrying the same reviewed source is safe.
  return `begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(hashtext('inboxpay-production-schema'));
do $inboxpay_release$
declare migration_source text := $inboxpay_source$${body}$inboxpay_source$;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then raise exception 'Migration ledger missing; inspect before applying'; end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version='20261030000000') then
    if not exists (select 1 from supabase_migrations.schema_migrations where version='20261030000000'
      and statements = array[migration_source] and name='privacy_requests_and_retention') then
      raise exception 'Migration identity differs; inspect before retrying';
    end if;
  else
    execute migration_source;
    insert into supabase_migrations.schema_migrations(version,statements,name)
      values ('20261030000000',array[migration_source],'privacy_requests_and_retention');
  end if;
end;
$inboxpay_release$;
notify pgrst, 'reload schema';
commit;
-- Reviewed migration SHA256: ${digest}
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Expected an output SQL file');
  const source = await readFile(new URL('../../supabase/migrations/20261030000000_privacy_requests_and_retention.sql', import.meta.url), 'utf8');
  await writeFile(process.argv[2], buildReleaseSQL(source));
  console.log('Prepared the fixed data-controls migration with atomic ledger recording.');
}
