import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const source=await build({entryPoints:['cloudflare/worker.js'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'worker-dependencies',setup(build){
  build.onResolve({filter:/^(cloudflare:workers|\.\/database\.js|\.\/collector\.js|\.\/notifications\.js|\.\/hub\.js|\.\.\/server\/broadcast-webhook\.js)$/},args=>({path:args.path,namespace:'mock'}));
  build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:{
    'cloudflare:workers':'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}',
    './database.js':'export const createDatabase=()=>({prepare(){return{bind(){return{first:async()=>null}}}}});',
    './collector.js':`export const createCollector=()=>({initialize:async()=>{},step(){globalThis.__steps++;return 1000},stop(){},settled:async()=>{},snapshot:()=>[{handle:'GANGZIIII',status:'offline'}],room:async(id,opts)=>({postId:id,...opts,messages:[]}),resolve:async()=>({tweet:'123'})});`,
    './notifications.js':'export const createNotificationReceiver=()=>({step:async()=>{},stop:async()=>{},status:()=>({})});',
    './hub.js':'export const createHub=()=>({broadcastMembers(){},publishRoom(){},accept(){},handle(){},remove(){}});',
    '../server/broadcast-webhook.js':'export const broadcastWebhook=async()=>{};export const enqueuePostNotifications=async()=>0;',
  }[path]}));
}}]});
const {default:gateway,SpaceliveCoordinator}=await import('data:text/javascript;base64,'+Buffer.from(source.outputFiles[0].text).toString('base64'));

function gatewayEnv(){
  const calls=[];
  return {calls,COLLECTOR_SECRET:'test-only-control-secret',PUBLIC_ORIGIN:'https://spacelive.vercel.app',COORDINATOR:{getByName(name){calls.push(name);return{fetch:async()=>Response.json({ok:true})}}}};
}
test('unknown endpoints, wrong origins and unauthenticated controls never reach the coordinator',async()=>{
  const env=gatewayEnv();
  for (const [path,init,status] of [
    ['/other',{},404],['/control/start',{method:'POST'},401],
    ['/api/members',{headers:{Origin:'https://other.example'}},403],
    ['/api/live',{headers:{Upgrade:'websocket'}},400],
    ['/api/members',{method:'POST'},405],
  ]) assert.equal((await gateway.fetch(new Request('https://realtime.example'+path,init),env)).status,status);
  assert.equal(env.calls.length,0);
});
test('public REST uses the singleton and exact allowed CORS origin',async()=>{
  const env=gatewayEnv(),response=await gateway.fetch(new Request('https://realtime.example/api/members'),env);
  assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),env.PUBLIC_ORIGIN);
  assert.deepEqual(env.calls,['spacelive']);
});
test('control mutation requires a valid bearer and POST',async()=>{
  const env=gatewayEnv(),headers={Authorization:'Bearer '+env.COLLECTOR_SECRET};
  assert.equal((await gateway.fetch(new Request('https://realtime.example/control/start',{headers}),env)).status,405);
  assert.equal((await gateway.fetch(new Request('https://realtime.example/control/start',{method:'POST',headers}),env)).status,200);
  assert.equal(env.calls.length,1);
});

test('staged deployment reads history without collecting; activation and stop persist and recover',async()=>{
  globalThis.__steps=0;
  globalThis.WebSocketRequestResponsePair=class {};
  const values=new Map(),alarms=[];let ready;
  const ctx={storage:{get:async key=>values.get(key),getAlarm:async()=>null,put:async(key,value)=>values.set(key,value),setAlarm:async at=>alarms.push(at),deleteAlarm:async()=>alarms.push(null)},getWebSockets:()=>[],setWebSocketAutoResponse(){},blockConcurrencyWhile(fn){ready=fn()},waitUntil(p){p.catch(()=>{})}};
  const object=new SpaceliveCoordinator(ctx,{});await ready;
  const response=await object.fetch(new Request('https://realtime.example/api/replies?id=123&latest=1'));
  assert.equal(response.status,200);assert.equal(globalThis.__steps,0);assert.equal(values.get('enabled'),undefined);
  try{
    await object.start();assert.equal(values.get('enabled'),true);assert.ok(globalThis.__steps>0);assert.ok(alarms.at(-1)>Date.now());
    assert.equal(object.status().enabled,true);
    const steps=globalThis.__steps;
    for(let index=0;index<100;index++)await object.fetch(new Request('https://realtime.example/api/members'));
    assert.equal(globalThis.__steps,steps,'viewer traffic must not schedule collection');
  }finally{await object.stop();}
  assert.equal(values.get('enabled'),false);assert.equal(alarms.at(-1),null);
  const before=globalThis.__steps;await object.alarm();assert.equal(globalThis.__steps,before);
});

test('private external debugging uses a different object and never opens the production coordinator',async()=>{
 const env=gatewayEnv(),debugCalls=[];env.DEBUGGER={getByName(name){debugCalls.push(name);return{fetch:async request=>Response.json({path:new URL(request.url).pathname,execution:'cloudflare'})}}};
 const url='https://realtime.example/control/debug/resolve?url=test';
 assert.equal((await gateway.fetch(new Request(url),env)).status,401);
 const response=await gateway.fetch(new Request(url,{headers:{Authorization:'Bearer '+env.COLLECTOR_SECRET}}),env);
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{path:'/api/resolve',execution:'cloudflare'});assert.deepEqual(debugCalls,['external-debug-v2']);assert.deepEqual(env.calls,[]);
});
