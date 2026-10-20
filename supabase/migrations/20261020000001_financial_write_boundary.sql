-- Browser sessions may read their own financial records through the existing
-- owner-scoped RLS policies. All invoice and audit mutations are server-only.
-- Existing server routes authenticate the owner before using the service key.
revoke all on table public.invoices from public, anon, authenticated;
revoke all on table public.audit_events from public, anon, authenticated;

grant select on table public.invoices to authenticated;
grant select on table public.audit_events to authenticated;

-- Preserve owner reads without leaving a permissive write policy that a later
-- accidental GRANT could re-expose. Service-role API writes bypass RLS.
drop policy if exists "users own invoices" on public.invoices;
create policy "users own invoices" on public.invoices
  for select to authenticated
  using ((select auth.uid()) = user_id);

comment on table public.invoices is
  'Owner-readable. Inserts, settlement updates, and deletion require the server credential; browser sessions cannot write financial state.';
comment on table public.audit_events is
  'Owner-readable append-only audit trail. Browser sessions cannot forge, edit, or delete events.';
