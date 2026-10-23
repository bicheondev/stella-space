import{test}from'node:test';
import assert from'node:assert/strict';
import vm from'node:vm';
import{createDebugDatabase,createDebugSpaceService}from'../server/debug-space.js';
import worker,{initialPage}from'../worker/index.js';
import{createHandler}from'../api/index.js';
import{operations}from'../server/operations.js';
import{adminSessionCookie}from'../server/admin-auth.js';
import{debugChatScript}from'../server/debug-chat.js';
process.env.ADMIN_SESSION_SECRET='isolated-debug-test-key';
const base='https://spacelive.vercel.app';

test('external resolve and replies use an isolated archive, including ended broadcasts',async()=>{
 const original=globalThis.fetch;const db=await createDebugDatabase();const urls=[];
 globalThis.fetch=async url=>{urls.push(String(url));
  if(String(url).includes('guest/activate'))return Response.json({guest_token:'guest'});
  if(String(url).includes('AudioSpaceById'))return Response.json({data:{audioSpace:{metadata:{state:'Ended',title:'external',creator_results:{result:{legacy:{screen_name:'outside'}}}},participants:{total:3}}}});
  if(String(url).includes('/profile/'))return Response.json({code:200,results:[{id:'123456',text:'https://x.com/i/spaces/1ExternalSpace',author:{screen_name:'outside'},created_timestamp:100}]});
  if(String(url).includes('/conversation/'))return Response.json({code:200,status:{replies:1},replies:[{id:'456789',type:'status',replying_to:{status:'123456'},text:'real reply',author:{name:'reader'},created_timestamp:101}]});
  throw Error('Unexpected upstream '+url);
 };
 try{
  const debug=createDebugSpaceService({makeDatabase:async()=>db});
  const resolve=await(await debug(new Request(base+'/api/admin/debug-space/resolve?url=https://x.com/i/spaces/1ExternalSpace'))).json();assert.equal(resolve.tweet,'123456');
  const chat=await(await debug(new Request(base+'/api/admin/debug-space/replies?id=123456&after=99999'))).json();assert.equal(chat.messages[0].text,'real reply');assert.equal(chat.stopped,true);assert.equal(chat.debugOnly,true);assert.equal(chat.hasOlder,false);assert.equal(chat.pollIntervalMs,2000);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM broadcast_messages').bind().first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM broadcast_sessions').bind().first()).n,0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM collector_entries WHERE key LIKE 'member:v2:%'").bind().first()).n,0);
  assert(!urls.some(u=>u.includes('turso')));
 }finally{globalThis.fetch=original;db.close();}
});

test('debug service translates upstream limits and never accepts arbitrary API paths',async()=>{
 const db=await createDebugDatabase();let calls=0;
 try{const debug=createDebugSpaceService({makeDatabase:async()=>db,fetchWorker:async()=>{calls++;return Response.json({error:'외부 조회 오류 (429)'},{status:502})}});
 assert.equal((await debug(new Request(base+'/api/admin/debug-space/members'))).status,404);assert.equal(calls,0);
 const result=await debug(new Request(base+'/api/admin/debug-space/replies?id=123456'));assert.equal(result.status,429);assert.equal(result.headers.get('retry-after'),'30');
 }finally{db.close()}
});

test('private debug endpoint rejects anonymous callers before production database access',async()=>{
 let prod=0;const handler=createHandler({environment:{SPACELIVE_REALTIME_ORIGIN:'https://realtime.example'},getDatabase(){prod++;throw Error('must not open production DB')}});
 const res={headers:{},setHeader(k,v){this.headers[k]=v},end(body){this.body=body}};
 await handler({url:'/api/admin/debug-space/resolve?url=x',method:'GET',headers:{}},res);assert.equal(res.statusCode,404);assert.equal(prod,0);
 const cookie=adminSessionCookie().split(';')[0];const page=await operations({method:'GET',headers:{cookie}},new URL(base+'/api/admin/debug-chat'),null);const html=await page.text();assert(html.includes('let realtimeOrigin='));for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});

test('production debug preserves durable history cursors and older-page flags',async()=>{
 const seen=new Set();let close=0,history=[];
 const ctx=vm.createContext({api:async()=>{throw Error('external test must use private API')},fetch:async()=>Response.json({messages:[{id:'111'}],historyCursor:1,hasOlder:true}),Response,AbortSignal,crypto,performance,Date,location:{origin:base},parent:{postMessage(){}},generation:1,room:{tweet:'123456'},seen,auto:false,document:{hidden:false},realtime:{close(){close++}},realtimeOrigin:'https://realtime.example',connect:async()=>{},requestAnimationFrame(){}});
 vm.runInContext(debugChatScript.slice(0,debugChatScript.indexOf('const debugButton=')),ctx);await vm.runInContext("debugConnect('test')",ctx);assert.equal(close,1);
 const first=await vm.runInContext("api('/api/replies?id=123456')",ctx);seen.add('111');const next=await vm.runInContext("api('/api/replies?id=123456')",ctx);assert.equal(first.historyCursor,1);assert.equal(next.historyCursor,1);assert.equal(next.hasOlder,true);
});

test('authenticated Cloudflare debug relay forwards only to the fixed private test path',async()=>{
 const original=globalThis.fetch,oldOrigin=process.env.SPACELIVE_REALTIME_ORIGIN,oldSecret=process.env.CLOUDFLARE_COLLECTOR_SECRET;
 process.env.SPACELIVE_REALTIME_ORIGIN='https://realtime.example';process.env.CLOUDFLARE_COLLECTOR_SECRET='test-only-secret';let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(url.origin,'https://realtime.example');assert.equal(url.pathname,'/control/debug/resolve');assert.equal(init.headers.Authorization,'Bearer test-only-secret');return Response.json({execution:'cloudflare',id:'1ExternalSpace'});};
 try{const url=new URL(base+'/api/admin/debug-space/cloudflare/resolve?url=https://x.com/i/spaces/1ExternalSpace');
 assert.equal((await operations({method:'GET',headers:{}},url,null)).status,404);assert.equal(calls,0);
 const result=await operations({method:'GET',headers:{cookie:adminSessionCookie().split(';')[0]}},url,null);assert.equal((await result.json()).execution,'cloudflare');assert.equal(calls,1);
 }finally{globalThis.fetch=original;if(oldOrigin===undefined)delete process.env.SPACELIVE_REALTIME_ORIGIN;else process.env.SPACELIVE_REALTIME_ORIGIN=oldOrigin;if(oldSecret===undefined)delete process.env.CLOUDFLARE_COLLECTOR_SECRET;else process.env.CLOUDFLARE_COLLECTOR_SECRET=oldSecret;}
});

test('Cloudflare debug archive batches fit the SQLite 100 parameter ceiling',async()=>{
 const{archiveMessages}=await import('../worker/index.js');const sizes=[];
 const db={maxBatchRows:30,prepare(){return{bind(...args){sizes.push(args.length);return{first:async()=>null}}}}};
 await archiveMessages(db,'123456',Array.from({length:75},(_,i)=>({id:String(i),text:'reply'})));
 assert.deepEqual(sizes,[90,90,45]);
});
