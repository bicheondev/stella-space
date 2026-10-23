import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createHandler,normalizeRealtimeOrigin,publicPage} from '../api/index.js';
import {buildVercel} from '../scripts/build-vercel.mjs';
import {runHeartbeat} from '../scripts/heartbeat.mjs';
import {memberHandles,initialPage} from '../worker/index.js';

function response(){return{statusCode:200,headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},end(body){this.body=body;}};}
test('realtime origin accepts an HTTPS origin and rejects credentials, paths, and injected values',()=>{
 assert.equal(normalizeRealtimeOrigin(undefined),'');assert.equal(normalizeRealtimeOrigin(' https://realtime.example/ '),'https://realtime.example');
 for(const value of ['http://realtime.example','https://name:secret@realtime.example','https://realtime.example/api','https://realtime.example/?secret=x','https://realtime.example/#x',"https://x';alert(1)//",'not a URL'])assert.throws(()=>normalizeRealtimeOrigin(value),/HTTPS origin/);
});

test('migrated public reads redirect to CF without opening the Vercel database or invoking collection',async()=>{
 const forbidden=()=>{throw Error('must not run');};
 const handler=createHandler({environment:{SPACELIVE_REALTIME_ORIGIN:'https://realtime.example'},getDatabase:forbidden,handleOperations:forbidden,fetchWorker:forbidden});
 for(const path of ['/api/members','/api/member?handle=GANGZIIII','/api/resolve?url=https%3A%2F%2Fx.com%2Fi%2Fstatus%2F123','/api/replies?id=123&after=99&latest=1','/api/chat-history?id=123&before=100']){
  const res=response();await handler({url:path,method:'GET',headers:{}},res);assert.equal(res.statusCode,307);assert.equal(res.headers.location,'https://realtime.example'+path);assert.equal(res.headers['cache-control'],'no-store');
 }
 const res=response();await handler({url:'/api/replies',method:'POST',headers:{}},res);assert.equal(res.statusCode,405);
});

test('migration stops public collection and authenticates heartbeat before its migration response',async()=>{
 const forbidden=()=>{throw Error('must not run');};const handler=createHandler({environment:{SPACELIVE_REALTIME_ORIGIN:'https://realtime.example',COLLECTOR_SECRET:'test-key'},getDatabase:forbidden,handleOperations:forbidden,fetchWorker:forbidden});
 const collect=response();await handler({url:'/api/collect-live',method:'GET',headers:{}},collect);assert.equal(JSON.parse(collect.body).migrated,true);assert.equal(JSON.parse(collect.body).pollIntervalMs,60000);
 const unauth=response();await handler({url:'/api/heartbeat',method:'GET',headers:{}},unauth);assert.equal(unauth.statusCode,401);
 const heartbeat=response();await handler({url:'/api/heartbeat',method:'GET',headers:{authorization:'Bearer test-key'}},heartbeat);assert.equal(heartbeat.statusCode,200);assert.equal(JSON.parse(heartbeat.body).migrated,true);
});

test('legacy mode still collects centrally while ops, feedback and auth remain on Vercel',async()=>{
 const paths=[],db={test:true};const handler=createHandler({environment:{COLLECTOR_SECRET:'test-key'},getDatabase:()=>db,handleOperations:async(_req,url)=>url.pathname.startsWith('/api/admin/')?Response.json({private:true}):null,fetchWorker:async request=>{paths.push(new URL(request.url).pathname);return Response.json({liveCount:1});},background(){}});
 const heartbeat=response();await handler({url:'/api/heartbeat',method:'GET',headers:{authorization:'Bearer test-key'}},heartbeat);assert.deepEqual(paths,['/api/members','/api/collect-live']);
 const operation=response();await handler({url:'/api/admin/overview',method:'GET',headers:{}},operation);assert.equal(JSON.parse(operation.body).private,true);assert.equal(paths.length,2);
 const origin='https://realtime.example',handled=[];const hybrid=createHandler({environment:{SPACELIVE_REALTIME_ORIGIN:origin},getDatabase:()=>db,handleOperations:async(_req,url)=>{handled.push(url.pathname);return new Response('private response',{headers:{'Cache-Control':'private, no-store'}});},fetchWorker:()=>{throw Error('private routes must remain protected');}});
 for(const url of ['/ops','/ops/debug','/api/auth/github/callback','/api/feedback','/api/admin/debug-chat']){const res=response();await hybrid({url,method:'GET',headers:{}},res);assert.equal(res.body,'private response');assert.equal(res.headers.location,undefined);}
 assert.equal(handled.length,5);
});

test('public HTML gets the origin and analytics while invalid configuration fails closed',async()=>{
 const html=publicPage(await initialPage(null,'/ShirayukiHina_'),'https://realtime.example');assert(html.includes('const realtimeOrigin="https://realtime.example";'));assert(html.includes('googletagmanager.com'));assert(html.includes('/analytics.js'));
 for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
 const handler=createHandler({environment:{SPACELIVE_REALTIME_ORIGIN:'http://invalid'},getDatabase:()=>{throw Error('must not open');}}),res=response();await handler({url:'/api/members',method:'GET',headers:{}},res);assert.equal(res.statusCode,503);assert.match(res.body,/HTTPS origin/);
});

test('hybrid builds static known pages before the catchall and rollback removes the generated pages',async()=>{
 const output=await mkdtemp(join(tmpdir(),'spacelive-build-'));
 try{
  const result=await buildVercel({output,origin:'https://realtime.example'});assert.equal(result.staticPages,memberHandles.length+1);
  for(const handle of memberHandles){const html=await readFile(join(output,handle+'.html'),'utf8');assert(html.includes('const realtimeOrigin="https://realtime.example";'));assert(html.includes('https://spacelive.vercel.app/'+handle));}
  assert((await readFile(join(output,'index.html'),'utf8')).includes('googletagmanager.com'));assert((await stat(join(output,'analytics.js'))).size>0);
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url)));assert.equal(config.cleanUrls,true);assert.deepEqual(config.rewrites,[{source:'/(.*)',destination:'/api/index'}]);
  assert.equal((await buildVercel({output,origin:''})).staticPages,0);
  await assert.rejects(readFile(join(output,'index.html')),error=>error.code==='ENOENT');await assert.rejects(readFile(join(output,'GANGZIIII.html')),error=>error.code==='ENOENT');assert((await stat(join(output,'analytics.js'))).size>0);
 }finally{await rm(output,{recursive:true,force:true});}
});

test('a migrated heartbeat exits before starting notifications or scheduling a successor',async()=>{
 let calls=0;const result=await runHeartbeat({environment:{COLLECTOR_SECRET:'test-key'},fetcher:async()=>{calls++;return Response.json({migrated:true});},watchNotifications:()=>{throw Error('must not start old push receiver');},makeScheduler:()=>()=>{throw Error('must not schedule');},logger:{log(){},error(){}}});
 assert.equal(result.migrated,true);assert.equal(calls,1);
});

test('cutover aborts an already-running notification receiver before stopping the heartbeat loop',async()=>{
 let now=0,calls=0,started=0,stopped=0,schedules=0;const intervals=[];
 const result=await runHeartbeat({environment:{COLLECTOR_SECRET:'test-key'},clock:()=>now,fetcher:async()=>Response.json(++calls===1?{liveCount:1,pollIntervalMs:250}:{migrated:true}),watchNotifications:({signal,onOwnership})=>{started++;onOwnership(true);return new Promise(resolve=>signal.addEventListener('abort',()=>{stopped++;resolve();},{once:true}));},makeScheduler:()=>async()=>{schedules++;return false;},sleep:async ms=>{intervals.push(ms);now+=ms;},logger:{log(){},error(){}}});
 assert.equal(result.migrated,true);assert.equal(started,1);assert.equal(stopped,1);assert.equal(schedules,1);assert.deepEqual(intervals,[250]);
});
