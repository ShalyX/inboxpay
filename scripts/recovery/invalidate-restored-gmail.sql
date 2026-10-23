-- Restore-only helper. Not a live migration. Must run before traffic or workers resume.
-- The caller must independently ensure this is an isolated replacement database,
-- with all traffic/workers stopped. The setting records intent, not host identity.
do $$
begin
  if current_setting('inboxpay.restore_mode', true) is distinct from 'isolated' then
    raise exception 'Gmail credential cleanup requires an explicitly marked isolated restore';
  end if;

  lock table public.integrations in exclusive mode;
  update public.integrations
  set status = 'revoked',
      access_token_encrypted = null,
      refresh_token_encrypted = null,
      provider_account_id = null,
      token_expires_at = null,
      scopes = '{}',
      updated_at = now()
  where provider = 'google_gmail'
    and (status is distinct from 'revoked'
      or access_token_encrypted is not null or refresh_token_encrypted is not null
      or provider_account_id is not null or token_expires_at is not null
      or cardinality(scopes) > 0);

  if exists (
    select 1 from public.integrations
    where provider = 'google_gmail'
      and (status is distinct from 'revoked'
        or access_token_encrypted is not null or refresh_token_encrypted is not null
        or provider_account_id is not null or token_expires_at is not null
        or cardinality(scopes) > 0)
  ) then
    raise exception 'Restored Gmail credential invalidation verification failed';
  end if;
end
$$;
