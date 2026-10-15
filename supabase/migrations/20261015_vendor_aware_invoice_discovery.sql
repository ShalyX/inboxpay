begin;

alter table public.vendors
  add column if not exists invoice_sender_emails text[] not null default '{}'::text[];

alter table public.vendors
  drop constraint if exists vendors_invoice_sender_emails_limit;

alter table public.vendors
  add constraint vendors_invoice_sender_emails_limit
  check (cardinality(invoice_sender_emails) <= 5);

alter table public.integrations
  add column if not exists invoice_discovery_started_at timestamptz;

update public.integrations
set invoice_discovery_started_at = now()
where provider = 'google_gmail'
  and invoice_discovery_started_at is null;

alter table public.integrations
  alter column invoice_discovery_started_at set default now();

create index if not exists vendors_invoice_sender_emails_idx
  on public.vendors using gin (invoice_sender_emails);

create unique index if not exists audit_events_ingestion_review_fingerprint_key
  on public.audit_events (business_id, network, ((data ->> 'fingerprint')))
  where event_type = 'invoice_ingestion_review_required';

create or replace function public.update_vendor_invoice_senders(
  p_vendor_id uuid,
  p_network text,
  p_sender_emails text[],
  p_confirm_mainnet boolean default false
)
returns setof public.vendors
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_vendor public.vendors%rowtype;
  v_email text;
begin
  if p_network not in ('ARC-TESTNET', 'ARC') then
    raise exception 'Unsupported vendor network';
  end if;
  if p_network = 'ARC' and not p_confirm_mainnet then
    raise exception 'Mainnet vendor sender changes require explicit confirmation';
  end if;
  if coalesce(cardinality(p_sender_emails), 0) > 5 then
    raise exception 'At most five invoice sender emails are allowed';
  end if;
  foreach v_email in array coalesce(p_sender_emails, '{}'::text[]) loop
    if v_email <> lower(trim(v_email))
       or v_email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$' then
      raise exception 'Invoice sender emails must be normalized valid email addresses';
    end if;
  end loop;
  if coalesce(cardinality(p_sender_emails), 0) <> (
    select count(distinct email) from unnest(coalesce(p_sender_emails, '{}'::text[])) as email
  ) then
    raise exception 'Invoice sender emails must be unique';
  end if;

  select v.* into v_vendor
  from public.vendors v
  join public.businesses b on b.id = v.business_id
  where v.id = p_vendor_id
    and v.network = p_network
    and b.owner_user_id = auth.uid()
  for update of v;

  if v_vendor.id is null then
    raise exception 'Vendor not found';
  end if;

  update public.vendors
  set invoice_sender_emails = coalesce(p_sender_emails, '{}'::text[]),
      updated_at = now()
  where id = v_vendor.id
  returning * into v_vendor;

  insert into public.audit_events (
    user_id,
    business_id,
    network,
    event_type,
    actor,
    data
  ) values (
    auth.uid(),
    v_vendor.business_id,
    p_network,
    'vendor_invoice_senders_updated',
    'user',
    jsonb_build_object('vendor', v_vendor.name, 'sender_emails', v_vendor.invoice_sender_emails)
  );

  return next v_vendor;
end;
$$;

revoke all on function public.update_vendor_invoice_senders(uuid, text, text[], boolean) from public, anon;
grant execute on function public.update_vendor_invoice_senders(uuid, text, text[], boolean) to authenticated;

commit;
