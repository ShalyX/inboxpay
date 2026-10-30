import assert from 'node:assert/strict';
process.env.SUPABASE_PUBLISHABLE_KEY='synthetic-public';
process.env.SUPABASE_SECRET_KEY='synthetic-service';
process.env.INBOXPAY_DATA_CONTROLS_ENABLED='true';
process.env.VERCEL_ENV='production';
delete process.env.INBOXPAY_PREVIEW_READ_ONLY;
const { default: handler } = await import('../api/session.mjs');
const business='10000000-0000-4000-8000-000000000001', owner='00000000-0000-4000-8000-000000000001';
const requestId='20000000-0000-4000-8000-000000000001';
let calls=[], fail=false, wrongReceipt=false;
globalThis.fetch=async(url,options={})=>{
  const path=new URL(url); calls.push({path,options});
  if(path.pathname.endsWith('/auth/v1/user')) {
    if(options.headers.Authorization!=='Bearer synthetic-owner') return new Response('{}',{status:401});
    return Response.json({id:owner,email:'synthetic@example.invalid'});
  }
  if(path.pathname.endsWith('/businesses')) return Response.json([{id:business,owner_user_id:owner,name:'Synthetic business'}]);
  if(path.pathname.endsWith('/rpc/request_business_data_removal')) {
    assert.equal(options.headers.Authorization,'Bearer synthetic-owner','do not replace owner identity with service role');
    const args=JSON.parse(options.body); assert.equal(args.p_business_id,business);
    if(fail) return new Response('{}',{status:503});
    return Response.json([{id:requestId,business_id:wrongReceipt?'other':business,user_id:owner,scope:args.p_scope,status:'requested',created_at:'2026-10-30T00:00:00Z'}]);
  }
  if(path.pathname.endsWith('/business_data_requests')) {
    assert.equal(path.searchParams.get('business_id'),'eq.'+business);
    assert.equal(path.searchParams.get('user_id'),'eq.'+owner);
    return Response.json([]);
  }
  throw new Error('Unexpected access: '+path.pathname);
};
const run=async(method='POST',body={action:'request_data_removal',confirm:true,businessId:business,requestId,scope:'invoice_evidence'},headers={authorization:'Bearer synthetic-owner'})=>{
  calls=[];const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method,body,headers,query:method==='GET'?{view:'data_requests'}:{}},res);return res;
};
let result=await run();assert.equal(result.code,200);assert.equal(result.body.removalCompleted,false);assert.equal(result.body.paymentAuthorityChanged,false);
assert.equal(result.body.request.id,requestId);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
assert.ok(calls.every(c=>!/integrations|invoices|policies|withdrawals|circle|telegram/.test(c.path.pathname)));
result=await run('GET');assert.equal(result.code,200);assert.deepEqual(result.body.requests,[]);
result=await run('POST',{action:'request_data_removal',confirm:true,businessId:'10000000-0000-4000-8000-000000000002',requestId,scope:'invoice_evidence'});assert.equal(result.code,409);
assert.ok(!calls.some(c=>c.path.pathname.includes('/rpc/')));
result=await run('POST',{action:'request_data_removal',confirm:false});assert.equal(result.code,400);assert.equal(calls.length,0);
result=await run('POST',undefined,{});assert.equal(result.code,401);assert.equal(calls.length,0);
fail=true;result=await run();assert.equal(result.code,503);assert.equal(result.body.request,undefined);fail=false;
wrongReceipt=true;result=await run();assert.equal(result.code,503);wrongReceipt=false;
process.env.INBOXPAY_PREVIEW_READ_ONLY='true';result=await run();assert.equal(result.code,403);assert.equal(calls.length,0);delete process.env.INBOXPAY_PREVIEW_READ_ONLY;
delete process.env.INBOXPAY_DATA_CONTROLS_ENABLED;result=await run();assert.equal(result.code,503);assert.equal(calls.length,0);
console.log('Real session route: authenticated scope, mismatch rejection, read-only preview, feature gate, provider failure and no financial calls passed');
