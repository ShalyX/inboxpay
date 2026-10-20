\set ON_ERROR_STOP on

-- Read-only production smoke test. Select two existing owners who each have
-- invoice and audit data; never print their identifiers or row contents.
begin read only;
select 1 / (case when (
  select count(*) from (
    select user_id from public.invoices
    intersect
    select user_id from public.audit_events
  ) owners
) >= 2 then 1 else 0 end) as two_owner_coverage;

with owners as (
  select user_id from public.invoices
  intersect
  select user_id from public.audit_events
)
select
  (select user_id::text from owners order by user_id limit 1) as owner_a,
  (select user_id::text from owners order by user_id offset 1 limit 1) as owner_b
\gset

select
  (select count(*) from public.invoices where user_id = :'owner_a'::uuid) as a_invoice,
  (select count(*) from public.audit_events where user_id = :'owner_a'::uuid) as a_audit,
  (select count(*) from public.invoices where user_id = :'owner_b'::uuid) as b_invoice,
  (select count(*) from public.audit_events where user_id = :'owner_b'::uuid) as b_audit
\gset
rollback;

-- Simulate the exact database role and JWT-sub claim PostgREST uses for an
-- authenticated owner. The transaction cannot change any financial data.
begin read only;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'owner_a', true) as jwt_sub \gset
select 1 / (case when
  (select auth.uid()) = :'owner_a'::uuid
  and (select count(*) from public.invoices) = :a_invoice
  and (select count(*) from public.audit_events) = :a_audit
  and not exists (select 1 from public.invoices where user_id <> :'owner_a'::uuid)
  and not exists (select 1 from public.audit_events where user_id <> :'owner_a'::uuid)
  and has_table_privilege(current_user, 'public.invoices', 'SELECT')
  and not has_table_privilege(current_user, 'public.invoices', 'INSERT, UPDATE, DELETE')
  and has_table_privilege(current_user, 'public.audit_events', 'SELECT')
  and not has_table_privilege(current_user, 'public.audit_events', 'INSERT, UPDATE, DELETE')
then 1 else 0 end) as owner_a_isolated;
rollback;

begin read only;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'owner_b', true) as jwt_sub \gset
select 1 / (case when
  (select auth.uid()) = :'owner_b'::uuid
  and (select count(*) from public.invoices) = :b_invoice
  and (select count(*) from public.audit_events) = :b_audit
  and not exists (select 1 from public.invoices where user_id <> :'owner_b'::uuid)
  and not exists (select 1 from public.audit_events where user_id <> :'owner_b'::uuid)
  and has_table_privilege(current_user, 'public.invoices', 'SELECT')
  and not has_table_privilege(current_user, 'public.invoices', 'INSERT, UPDATE, DELETE')
  and has_table_privilege(current_user, 'public.audit_events', 'SELECT')
  and not has_table_privilege(current_user, 'public.audit_events', 'INSERT, UPDATE, DELETE')
then 1 else 0 end) as owner_b_isolated;
rollback;
