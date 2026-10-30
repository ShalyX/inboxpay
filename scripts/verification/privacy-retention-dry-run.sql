\set ON_ERROR_STOP on
begin read only;
set local statement_timeout = '30s';
do $$ begin
  if to_regclass('public.business_data_requests') is null
    or not exists (select 1 from pg_class where oid='public.business_data_requests'::regclass and relrowsecurity)
    or not exists (select 1 from supabase_migrations.schema_migrations where version='20261030000000') then
    raise exception 'Data-controls migration is not recorded or RLS is absent';
  end if;
  if has_function_privilege('anon','public.run_business_data_retention(boolean,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.run_business_data_retention(boolean,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.run_business_data_retention(boolean,integer)','EXECUTE')
    or has_table_privilege('authenticated','public.business_data_requests','INSERT,UPDATE,DELETE')
    or has_function_privilege('anon','public.request_business_data_removal(uuid,uuid,text)','EXECUTE') then
    raise exception 'Data-controls privilege boundary verification failed';
  end if;
end $$;
set local role service_role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claims = '{"role":"service_role"}';
select public.run_business_data_retention(true,500) as production_retention_dry_run;
rollback;
