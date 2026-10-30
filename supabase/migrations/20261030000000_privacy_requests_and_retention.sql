begin;

-- A request records authenticated ownership; it does not authorize an operator
-- to bypass payment review or delete a workspace via cascading foreign keys.
create table public.business_data_requests (
  id uuid primary key,
  business_id uuid not null references public.businesses(id),
  user_id uuid not null references auth.users(id),
  scope text not null check (scope in ('invoice_evidence', 'workspace_closure', 'export')),
  status text not null default 'requested' check (status in ('requested', 'reviewing', 'blocked', 'cancelled')),
  identity_method text not null default 'signed_in_owner' check (identity_method = 'signed_in_owner'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.business_data_requests enable row level security;
revoke all on public.business_data_requests from public, anon, authenticated;
grant select on public.business_data_requests to authenticated;
grant all on public.business_data_requests to service_role;
create policy business_data_requests_owner_read on public.business_data_requests
for select to authenticated using (
  user_id = (select auth.uid()) and exists (
    select 1 from public.businesses b where b.id = business_data_requests.business_id and b.owner_user_id = (select auth.uid())
  )
);
create unique index business_data_requests_one_open_scope on public.business_data_requests (business_id, scope)
where status in ('requested', 'reviewing', 'blocked');

create function public.request_business_data_removal(p_request_id uuid, p_business_id uuid, p_scope text)
returns setof public.business_data_requests
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid(); existing public.business_data_requests%rowtype;
begin
  if owner_id is null or auth.role() is distinct from 'authenticated' then raise exception 'Authenticated owner required'; end if;
  -- Serialize per business so concurrent retries return one open request.
  perform 1 from public.businesses b where b.id = p_business_id and b.owner_user_id = owner_id for update;
  if not found then raise exception 'Business ownership mismatch'; end if;
  if p_request_id is null or p_scope is null or p_scope not in ('invoice_evidence', 'workspace_closure', 'export') then
    raise exception 'Unsupported data request';
  end if;
  select * into existing from public.business_data_requests r where r.id = p_request_id;
  if found then
    if existing.business_id <> p_business_id or existing.user_id <> owner_id or existing.scope <> p_scope then
      raise exception 'Request identity mismatch';
    end if;
    return next existing; return;
  end if;
  select * into existing from public.business_data_requests r where r.business_id = p_business_id and r.scope = p_scope
    and r.status in ('requested', 'reviewing', 'blocked');
  if found then return next existing; return; end if;
  return query insert into public.business_data_requests (id, business_id, user_id, scope)
    values (p_request_id, p_business_id, owner_id, p_scope) returning *;
end;
$$;
revoke all on function public.request_business_data_removal(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.request_business_data_removal(uuid, uuid, text) to authenticated;

-- Keep source_key tombstones: deleting the jobs would permit an old audit event
-- to enqueue a second notification. Only terminal payloads age out.
alter table public.business_payment_notification_jobs add column payload_redacted_at timestamptz;
create function public.protect_redacted_notification()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.payload_redacted_at is not null and (
    new.payload_redacted_at is distinct from old.payload_redacted_at
    or new.payload <> '{}'::jsonb or new.last_error is not null
    or new.telegram_message_id is not null or new.status not in ('delivered', 'failed', 'skipped')
  ) then raise exception 'Redacted notification cannot be reactivated'; end if;
  return new;
end;
$$;
create trigger protect_redacted_notification before update on public.business_payment_notification_jobs
for each row execute function public.protect_redacted_notification();

create function public.run_business_data_retention(p_dry_run boolean default true, p_batch_size integer default 500)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare links integer; jobs integer; clock_time timestamptz := statement_timestamp();
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_dry_run is null or p_batch_size is null or p_batch_size < 1 or p_batch_size > 1000 then
    raise exception 'Invalid retention parameters';
  end if;
  if p_dry_run then
    select count(*) into links from (select id from public.business_notification_link_tokens
      where expires_at < clock_time - interval '1 day' limit p_batch_size) candidates;
    select count(*) into jobs from (select id from public.business_payment_notification_jobs
      where status in ('delivered', 'failed', 'skipped') and updated_at < clock_time - interval '30 days'
        and payload_redacted_at is null limit p_batch_size) candidates;
  else
    with candidates as (select id from public.business_notification_link_tokens
      where expires_at < clock_time - interval '1 day' order by expires_at, id
      for update skip locked limit p_batch_size)
    delete from public.business_notification_link_tokens t using candidates c where t.id = c.id;
    get diagnostics links = row_count;
    with candidates as (select id from public.business_payment_notification_jobs
      where status in ('delivered', 'failed', 'skipped') and updated_at < clock_time - interval '30 days'
        and payload_redacted_at is null order by updated_at, id for update skip locked limit p_batch_size)
    update public.business_payment_notification_jobs j set payload = '{}'::jsonb, last_error = null,
      telegram_message_id = null, lease_token = null, lease_expires_at = null,
      payload_redacted_at = clock_time
    from candidates c where j.id = c.id;
    get diagnostics jobs = row_count;
  end if;
  return jsonb_build_object('dryRun', p_dry_run, 'expiredLinks', links, 'terminalPayloads', jobs, 'batchSize', p_batch_size);
end;
$$;
revoke all on function public.run_business_data_retention(boolean, integer) from public, anon, authenticated;
grant execute on function public.run_business_data_retention(boolean, integer) to service_role;
commit;
