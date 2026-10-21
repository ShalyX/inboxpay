begin;

-- The authenticated owner calls this RPC, but direct audit inserts were
-- correctly revoked from browser sessions. Run only this audited operation
-- with the function owner's privileges; the function itself checks auth.uid(),
-- the vendor's business owner, and the exact network before changing a row.
alter function public.update_vendor_invoice_senders(uuid, text, text[], boolean)
  security definer;

revoke all on function public.update_vendor_invoice_senders(uuid, text, text[], boolean)
  from public, anon;
grant execute on function public.update_vendor_invoice_senders(uuid, text, text[], boolean)
  to authenticated;

comment on function public.update_vendor_invoice_senders(uuid, text, text[], boolean) is
  'Owner-checked vendor sender update with an atomic audit event. No direct authenticated audit table writes.';

commit;
