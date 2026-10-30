import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { verifyDataControlsRelease } from './verification/data-controls-live-check.mjs';
const source=(await readFile('public/data-controls.js','utf8')).replace(/^import[^\n]*\n/,'');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(preview=false) {
  const ids=['account','message','request-form','scope','confirm','submit','requests'];
  const nodes=Object.fromEntries(ids.map(id=>[id,{textContent:'',disabled:false,checked:false,value:'invoice_evidence',handlers:{},children:[],
    addEventListener(event,handler){this.handlers[event]=handler;},replaceChildren(){this.children=[];this.textContent='';},append(node){this.children.push(node);}}]));
  let authCallback, pending, failures=0;const posts=[];
  const session={user:{id:'owner-a'},access_token:'synthetic-access'};
  const client={auth:{getSession:async()=>({data:{session}}),onAuthStateChange(callback){authCallback=callback;}}};
  runInNewContext(source,{document:{getElementById:id=>nodes[id],createElement:()=>({textContent:''})},
    createClient:()=>client,crypto:{randomUUID:()=> 'synthetic-request'},fetch:async(url,options={})=>{
      if(url==='/api/config') return Response.json({url:'https://synthetic.invalid',publishableKey:'synthetic-public',previewReadOnly:preview});
      if(options.method==='GET') return Response.json({business:{id:'business-a',name:'Business A'},requests:[]});
      posts.push(JSON.parse(options.body));
      if(failures>0){failures--;throw new Error('Synthetic transient failure');}
      return new Promise(resolve=>{pending=resolve;});
    }});
  await tick();await tick();
  return {nodes,posts,submit:()=>nodes['request-form'].handlers.submit({preventDefault(){}}),
    resolve:()=>pending(Response.json({request:{id:'request-receipt',scope:'invoice_evidence',status:'requested'},removalCompleted:false,paymentAuthorityChanged:false})),
    changeOwner:()=>authCallback('SIGNED_OUT',null),fail:()=>{failures++;}};
}
let test=await setup();assert.equal(test.nodes.submit.disabled,false);
await test.submit();assert.equal(test.posts.length,0,'explicit scope acknowledgement required');
test.nodes.confirm.checked=true;const pending=test.submit();await tick();await test.submit();assert.equal(test.posts.length,1,'double submit cannot create another attempt');
test.resolve();await pending;assert.match(test.nodes.message.textContent,/Removal is not complete/);
assert.equal(test.nodes.requests.children[0].textContent,'Invoice evidence removal · requested · Reference request-receipt');
test=await setup();test.nodes.confirm.checked=true;test.fail();await test.submit();assert.equal(test.nodes.submit.disabled,false);
const retry=test.submit();await tick();assert.equal(test.posts[0].requestId,test.posts[1].requestId,'ambiguous failure retries same request ID');test.resolve();await retry;
test=await setup();test.nodes.confirm.checked=true;const stale=test.submit();await tick();test.changeOwner();test.resolve();await stale;
assert.equal(test.nodes.submit.disabled,true);assert.equal(test.nodes.requests.children.length,0);assert.match(test.nodes.message.textContent,/Reload/,'late receipt must not enter another session');
test=await setup(true);test.nodes.confirm.checked=true;await test.submit();assert.equal(test.posts.length,0,'preview cannot submit');
const cloudFetch = async url => {
  const path = new URL(url).pathname;
  if(path==='/api/config')return Response.json({dataControlsEnabled:false,previewReadOnly:false});
  if(path==='/api/session')return new Response('{}',{status:503});
  return new Response(await readFile('public'+path,'utf8'));
};
assert.equal((await verifyDataControlsRelease(cloudFetch)).productionAssetsMatch,true);
await assert.rejects(verifyDataControlsRelease(async()=>Response.json({dataControlsEnabled:true,previewReadOnly:false})),/Unexpected production feature flags/);
await assert.rejects(verifyDataControlsRelease(async url=>new URL(url).pathname==='/api/config'?Response.json({dataControlsEnabled:false,previewReadOnly:false}):new Response('wrong asset')),/asset mismatch/);
console.log('Business data request UI: acknowledgement, double submit, stable retry, session change and preview lock passed');
