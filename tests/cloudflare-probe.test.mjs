import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const bundle=await build({entryPoints:['cloudflare/probe-worker.js'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'durable-object-stub',setup(build){build.onResolve({filter:/^cloudflare:workers$/},()=>({path:'durable-object',namespace:'test'}));build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }'}));}}]});
const {default:gateway,FreeTierProbe,PROBE_TARGET}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const secret='isolated-test-probe-secret',headers={Authorization:'Bearer '+secret};
const request=(path,method='GET',body)=>new Request('https://probe.example'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
function harness(existing){
 const values=new Map(existing?[['result',existing]]:[]),alarms=[],waits=[];
 const ctx={storage:{get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value)),setAlarm:async at=>alarms.push(at),deleteAlarm:async()=>alarms.push(null)},blockConcurrencyWhile:fn=>fn(),waitUntil:task=>waits.push(task)};
 return{object:new FreeTierProbe(ctx,{PROBE_SECRET:secret}),values,alarms,waits};
}
test('the probe is isolated, requires exact private bearer auth, and uses one object',async()=>{
 const calls=[],env={PROBE_SECRET:secret,PROBE:{getByName(name){calls.push(name);return{fetch:async()=>Response.json({ok:true})};}}};
 assert.equal((await gateway.fetch(new Request('https://probe.example/status'),env)).status,401);
 assert.equal((await gateway.fetch(new Request('https://probe.example/status',{headers:{Authorization:'Bearer '+secret+' '}}),env)).status,200); // Headers trim surrounding whitespace.
 calls.length=0;
 assert.equal((await gateway.fetch(new Request('https://probe.example/status',{headers:{Authorization:'bearer '+secret}}),env)).status,401);
 assert.equal((await gateway.fetch(request('/start'),env)).status,405);
 assert.equal((await gateway.fetch(request('/unknown'),env)).status,404);
 assert.equal(calls.length,0);assert.equal((await gateway.fetch(request('/status'),env)).status,200);assert.deepEqual(calls,['free-runtime-probe']);
 assert.equal(PROBE_TARGET,'https://example.com/');
});

test('negative probe records the request that exceeds a simulated 50-subrequest event budget',async()=>{
 const previous=globalThis.fetch,h=harness();let fetched=0;
 globalThis.fetch=async url=>{assert.equal(url,PROBE_TARGET);if(++fetched>50)throw Error('Too many subrequests');return new Response('probe');};
 try{
  assert.equal((await h.object.fetch(request('/start','POST',{mode:'negative'}))).status,202);await h.object.task;
  const result=await(await h.object.fetch(request('/status'))).json();assert.equal(result.status,'failed');assert.equal(result.completed,50);assert.equal(result.attempted,51);assert.match(result.error,/Too many subrequests/);assert.equal(result.alarms,0);assert.equal(result.contaminated,false);
 }finally{await h.object.stop();globalThis.fetch=previous;}
});

test('positive probe performs 160 requests through the same budget and four alarm replenishments',async()=>{
 const previous=globalThis.fetch,h=harness();let fetched=0,alarmIndex=0;
 globalThis.fetch=async url=>{assert.equal(url,PROBE_TARGET);fetched++;return new Response('probe');};
 try{
  await h.object.fetch(request('/start','POST',{mode:'positive'}));
  for(let step=0;h.object.state.status==='running'&&step<20;step++){
   await new Promise(resolve=>setImmediate(resolve));
   while(alarmIndex<h.alarms.length){const at=h.alarms[alarmIndex++];if(at!==null)await h.object.alarm();}
  }
  await h.object.task;assert.equal(fetched,160);assert.equal(h.object.state.status,'completed');assert.equal(h.object.state.alarms,4);assert.equal(h.object.state.alarmsRequested,4);assert.equal(h.object.state.incomingDuringRun,0);
  assert.equal(h.values.get('result').completed,160);assert.equal(h.alarms.at(-1),null);
 }finally{await h.object.stop();globalThis.fetch=previous;}
});

test('a status read during a soak marks it contaminated, while stop aborts timers and deletes the alarm',async()=>{
 const previous=globalThis.fetch,h=harness();globalThis.fetch=async()=>new Response('probe');
 try{
  const started=await(await h.object.fetch(request('/start','POST',{mode:'soak'}))).json();assert(started.readStatusAfter>=h.object.state.startedAt+1200000);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.object.state.completed,1);assert.equal(h.object.state.ticks,1);
  const status=await h.object.fetch(request('/status'));assert.equal(status.status,409);assert.equal((await status.json()).contaminated,true);
  await h.object.alarm();assert.equal(h.object.state.alarms,1);
  await h.object.fetch(request('/stop','POST'));assert.equal(h.object.state.status,'stopped');assert.equal(h.alarms.at(-1),null);
 }finally{await h.object.stop();globalThis.fetch=previous;}
});

test('an object restart during a probe is reported instead of silently claiming success',async()=>{
 const h=harness({status:'running',startedAt:Date.now()-1000,mode:'positive',completed:36,attempted:37});await h.object.ready;
 assert.equal(h.object.state.status,'interrupted');assert.match(h.object.state.error,/restarted/);assert.equal(h.alarms.at(-1),null);
 const response=await h.object.fetch(request('/status'));assert.equal(response.status,200);assert.equal((await response.json()).completed,36);
});
