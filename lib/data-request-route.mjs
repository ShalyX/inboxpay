import { requireUser, supabaseRest } from './supabase-server.mjs';
import { getBusinessRecord } from './businesses.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const scopes = new Set(['invoice_evidence', 'workspace_closure', 'export']);
const view = (row) => ({ id: row.id, scope: row.scope, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });

export default async function dataRequestRoute(req, res) {
  if (process.env.INBOXPAY_DATA_CONTROLS_ENABLED !== 'true') {
    return res.status(503).json({ error: 'Data requests are not enabled here. Contact inboxpaysupport@gmail.com.' });
  }
  if (req.method === 'POST' && (req.body?.confirm !== true || !uuid.test(req.body?.requestId || '')
    || !uuid.test(req.body?.businessId || '') || !scopes.has(req.body?.scope))) {
    return res.status(400).json({ error: 'Confirm the exact business and request scope.' });
  }
  let authenticated = false;
  try {
    const { token, user } = await requireUser(req);
    authenticated = true;
    const business = await getBusinessRecord(token, user.id);
    if (!business) return res.status(409).json({ error: 'Business onboarding is required.' });
    if (req.method === 'POST') {
      if (req.body.businessId !== business.id) return res.status(409).json({ error: 'Business changed. Reload before requesting.' });
      const rows = await supabaseRest('rpc/request_business_data_removal', { token, method: 'POST', body: {
        p_request_id: req.body.requestId, p_business_id: business.id, p_scope: req.body.scope
      } });
      const row = rows?.[0];
      if (!row || row.business_id !== business.id || row.user_id !== user.id || row.scope !== req.body.scope) throw new Error('Invalid request receipt');
      return res.status(200).json({ request: view(row), removalCompleted: false, paymentAuthorityChanged: false });
    }
    const rows = await supabaseRest('business_data_requests?select=id,scope,status,created_at,updated_at&business_id=eq.'
      + encodeURIComponent(business.id) + '&user_id=eq.' + encodeURIComponent(user.id) + '&order=created_at.desc&limit=20', { token });
    if (!Array.isArray(rows)) throw new Error('Invalid request list');
    return res.status(200).json({ business: { id: business.id, name: business.name }, requests: rows.map(view) });
  } catch {
    return res.status(authenticated ? 503 : 401).json({ error: authenticated
      ? 'Request status could not be verified. Retry with the same request identifier.' : 'Sign in to manage business data requests.' });
  }
}
