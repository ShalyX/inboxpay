import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { encryptSecret } from '../lib/secure-tokens.mjs';
import { runInNewContext } from 'node:vm';
process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture-public';
process.env.SUPABASE_SECRET_KEY = 'fixture-server';
process.env.VERCEL_ENV = 'production';
process.env.INBOXPAY_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.GMAIL_CLIENT_ID = 'fixture-client'; process.env.GMAIL_CLIENT_SECRET = 'fixture-secret';
delete process.env.INBOXPAY_PREVIEW_READ_ONLY;
const { default: handler } = await import('../api/session.mjs');
let calls = [], row = { id: 'integration-a', user_id: 'owner-a', business_id: 'business-a', status: 'connected', access_token_encrypted: 'secret-access', refresh_token_encrypted: 'secret-refresh' };
let failWrite = false, failAudit = false, emptyWrite = false;
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url); calls.push({ u, options });
  let body = [];
  if (u.pathname.endsWith('/user')) body = { id: 'owner-a', email: 'fixture@example.invalid' };
  else if (u.pathname.endsWith('/businesses')) body = [{ id: 'business-a', owner_user_id: 'owner-a' }];
  else if (u.pathname.endsWith('/business_network_accounts')) body = [];
  else if (u.pathname.endsWith('/integrations')) {
    assert.equal(u.searchParams.get('user_id'), 'eq.owner-a');
    if (options.method === 'PATCH') assert.equal(u.searchParams.get('or'), '(business_id.eq.business-a,business_id.is.null)');
    else if (!u.searchParams.has('select')) assert.equal(u.searchParams.get('business_id'), 'eq.business-a');
    assert.equal(u.searchParams.get('provider'), 'eq.google_gmail');
    assert.equal(options.headers.Authorization, 'Bearer fixture-owner');
    if (options.method === 'PATCH') {
      if (failWrite) return new Response('{}', { status: 503 });
      if (emptyWrite) return new Response('[]', { status:200 });
      row = { ...row, ...JSON.parse(options.body) }; body = [row];
    } else body = [row];
  } else if (u.pathname.endsWith('/audit_events')) {
    if (failAudit) return new Response('{}', { status: 503 });
    const event = JSON.parse(options.body);
    assert.equal(event.business_id, 'business-a'); assert.equal(event.user_id, 'owner-a');
    assert.equal(event.event_type, 'gmail_disconnected');
    assert.doesNotMatch(options.body, /secret-access|secret-refresh/);
  } else throw new Error('Unexpected access: ' + u.pathname);
  return new Response(JSON.stringify(body), { status: 200 });
};
const response = () => ({ code: 200, headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(n) { this.code=n; return this; }, json(b) { this.body=b; return this; } });
const run = async (body, headers = { authorization: 'Bearer fixture-owner' }) => { calls=[]; const res=response(); await handler({method:'POST', headers, body},res); return res; };
let res = await run({ action: 'disconnect_gmail', confirm: true, businessId: 'other-business' });
assert.equal(res.code, 200, 'owner can remove Gmail tokens through the real session route');
assert.equal(row.status, 'revoked');
for (const key of ['access_token_encrypted','refresh_token_encrypted','token_expires_at','provider_account_id']) assert.equal(row[key], null);
assert.deepEqual(row.scopes, []);
assert.doesNotMatch(JSON.stringify(res.body), /secret-access|secret-refresh/);
assert.equal(calls.filter(c => c.options.method === 'PATCH').length, 1);
assert.ok(calls.every(c => !/policies|wallets|invoices/.test(c.u.pathname)), 'no payment authority or invoice deletion');
res = await run({ action: 'disconnect_gmail', confirm: true }); assert.equal(res.code,200);
res = await run({ action: 'disconnect_gmail' }); assert.equal(res.code,400); assert.equal(calls.length,0);
res = await run({ action:'wrong', confirm:true }); assert.equal(res.code,400); assert.equal(calls.length,0);
res = await run({ action:'disconnect_gmail', confirm:true },{}); assert.equal(res.code,401); assert.equal(calls.length,0);
process.env.INBOXPAY_PREVIEW_READ_ONLY = 'true';
res = await run({action:'disconnect_gmail',confirm:true}); assert.equal(res.code,403); assert.equal(calls.length,0);
delete process.env.INBOXPAY_PREVIEW_READ_ONLY;
failWrite=true; res=await run({action:'disconnect_gmail',confirm:true}); assert.equal(res.code,503); assert.ok(!calls.some(c=>c.u.pathname.endsWith('/audit_events')));
failWrite=false; failAudit=true; res=await run({action:'disconnect_gmail',confirm:true}); assert.equal(res.code,200); assert.equal(res.body.auditRecorded,false);
failAudit=false; emptyWrite=true;
row={...row,status:'connected',access_token_encrypted:'still-present',refresh_token_encrypted:'still-present'};
res=await run({action:'disconnect_gmail',confirm:true});
assert.equal(res.code,503,'zero matched rows must not report removal while credentials remain');
assert.notEqual(res.body.storedTokensRemoved,true);
emptyWrite=false; await run({action:'disconnect_gmail',confirm:true});
const { getFreshGmailAccessToken } = await import('../lib/gmail-account.mjs');
calls=[]; await assert.rejects(getFreshGmailAccessToken('fixture-owner','owner-a','business-a'), /Connect Gmail/);
assert.equal(calls.length,1,'revoked connection never reaches Google refresh');
// Disconnect completes while a provider refresh is in flight. Its stale write must fail closed.
let raceCalls = [];
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url); raceCalls.push({u,options});
  let body;
  if (u.pathname.endsWith('/integrations') && options.method === 'GET') body = [{
    id:'integration-a', status:'connected', refresh_token_encrypted: encryptSecret('fixture-refresh'), token_expires_at:'2000-01-01'
  }];
  else if (u.pathname === '/token') body = {access_token:'fresh-access',expires_in:3600};
  else if (options.method === 'PATCH') {
    assert.equal(u.searchParams.get('status'),'eq.connected');
    assert.equal(u.searchParams.get('user_id'),'eq.owner-a');
    assert.equal(u.searchParams.get('business_id'),'eq.business-a');
    assert.ok(u.searchParams.get('refresh_token_encrypted').startsWith('eq.'));
    body=[]; // revoked row no longer matches
  } else throw new Error('Unexpected refresh access');
  return new Response(JSON.stringify(body),{status:200});
};
await assert.rejects(getFreshGmailAccessToken('fixture-owner','owner-a','business-a'),/changed during refresh/);
assert.equal(raceCalls.length,3);
const account = await readFile(new URL('../lib/gmail-account.mjs',import.meta.url),'utf8');
assert.match(account,/status=eq.connected/,'refresh writes must not revive a revoked connection');
const app = await readFile(new URL('../public/inboxpay.js',import.meta.url),'utf8');
assert.match(app,/async function disconnectGmail/); assert.match(app,/disconnect_gmail/);
const begin = app.indexOf('async function disconnectGmail() {');
const source = app.slice(begin, app.indexOf('\n}',begin)+2);
const nodes = new Map();
const node = id => { if(!nodes.has(id)) nodes.set(id,{textContent:'',className:'',disabled:false,focus(){}}); return nodes.get(id); };
let uiCalls=0, confirmed=false, ok=true;
const uiState={gmail:{status:'connected'}, previewReadOnly:false};
const context={state:uiState,$:node,window:{confirm:()=>confirmed},renderAccount(){},
  async apiFetch(url,options){ uiCalls++; assert.equal(url,'/api/session'); assert.deepEqual(JSON.parse(options.body),{action:'disconnect_gmail',confirm:true}); return {ok}; },
  async readJsonResponse(){return ok ? {storedTokensRemoved:true,auditRecorded:true} : {error:'Try again'};}
};
const disconnectUi=()=>runInNewContext(source+'\ndisconnectGmail();',context);
await disconnectUi(); assert.equal(uiCalls,0,'cancel must not send a request');
confirmed=true; uiState.previewReadOnly=true; await disconnectUi(); assert.equal(uiCalls,0,'preview must not send a request');
uiState.previewReadOnly=false; ok=false; await disconnectUi(); assert.equal(uiState.gmail.status,'connected','failed removal preserves prior UI state');
assert.equal(node('gmail-disconnect-message').textContent,'Try again');
ok=true; await disconnectUi(); assert.equal(uiState.gmail,null); assert.equal(uiState.liveGmail,false);
assert.equal(uiState.disconnectingGmail,false); assert.match(node('gmail-disconnect-message').textContent,/Stored tokens removed/);
console.log('Gmail disconnect owner boundary, token removal, preview rejection and failure checks passed');
