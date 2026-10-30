import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const element = id => document.getElementById(id);
let session, business, client, preview = true, busy = false, requestId, changed = false;
const message = text => { element('message').textContent = text; };
function lock(locked) {
  for (const id of ['scope', 'confirm', 'submit']) element(id).disabled = locked;
}
async function call(method, body) {
  const response = await fetch('/api/session' + (method === 'GET' ? '?view=data_requests' : ''), {
    method, cache: 'no-store', headers: { Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request unavailable. Please retry.');
  return result;
}
function showRequests(rows) {
  element('requests').replaceChildren();
  const labels = { invoice_evidence: 'Invoice evidence removal', workspace_closure: 'Workspace closure', export: 'Business data export' };
  for (const row of rows) {
    const li = document.createElement('li');
    li.textContent = `${labels[row.scope] || 'Data request'} · ${row.status} · Reference ${row.id}`;
    element('requests').append(li);
  }
  if (!rows.length) element('requests').textContent = 'No requests yet.';
}
element('scope').addEventListener('change', () => { requestId = null; element('confirm').checked = false; });
element('request-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || preview || changed || !business || !element('confirm').checked) return;
  busy = true; lock(true); message('Recording your request…');
  const owner = session.user.id;
  requestId ||= crypto.randomUUID();
  try {
    const result = await call('POST', { action: 'request_data_removal', confirm: true,
      businessId: business.id, requestId, scope: element('scope').value });
    if (changed || session?.user.id !== owner) return;
    if (!result.request?.id || result.removalCompleted !== false || result.paymentAuthorityChanged !== false) throw new Error('The request receipt could not be verified. Retry before assuming success.');
    showRequests([result.request]);
    message('Request recorded. Reference ' + result.request.id + '. Removal is not complete; payment settings are unchanged.');
    requestId = null; element('confirm').checked = false;
  } catch (error) { if (!changed) message(error.message); }
  finally { busy = false; lock(preview || changed || !business); }
});
async function start() {
  try {
    const configResponse = await fetch('/api/config', { cache: 'no-store' });
    if (!configResponse.ok) throw new Error('Account configuration unavailable.');
    const config = await configResponse.json(); preview = config.previewReadOnly === true;
    client = createClient(config.url, config.publishableKey);
    session = (await client.auth.getSession()).data.session;
    if (!session) throw new Error('Sign in to InboxPay, then return to this page.');
    client.auth.onAuthStateChange((_event, next) => {
      if (next?.user.id !== session?.user.id) {
        changed = true; business = null; requestId = null; lock(true);
        element('requests').replaceChildren(); element('account').textContent = 'Account changed.';
        message('Reload to verify the current business.');
      }
      session = next;
    });
    const data = await call('GET');
    if (changed) return;
    if (!data.business?.id || !Array.isArray(data.requests)) throw new Error('Business data could not be verified.');
    business = data.business; element('account').textContent = 'Business: ' + business.name;
    showRequests(data.requests); lock(preview);
    message(preview ? 'Read-only preview. Requests cannot be sent here.' : 'Requests are reviewed by InboxPay support.');
  } catch (error) { lock(true); element('account').textContent = 'Business not verified.'; message(error.message); }
}
start();
