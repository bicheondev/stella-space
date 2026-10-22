import {test} from 'node:test';
import assert from 'node:assert/strict';
import {successorScheduler} from '../scripts/collector-handoff.mjs';
test('only the owner dispatches one successor and an existing newer run prevents duplicates',async()=>{
 const calls=[];const schedule=successorScheduler({repository:'personal/test',token:'test-secret',runId:'100',fetcher:async(url,options)=>{calls.push({url,options});return options.method==='POST'?new Response(null,{status:204}):Response.json({workflow_runs:[]})}});
 assert.equal(await schedule({owner:false,elapsed:300000}),false);assert.equal(await schedule({owner:true,elapsed:230000}),false);assert.equal(calls.length,0);
 assert.equal(await schedule({owner:true,elapsed:240000}),true);assert.equal(await schedule({owner:true,elapsed:300000}),false);assert.equal(calls.length,2);assert.equal(JSON.parse(calls[1].options.body).ref,'main');
 let listed=0;const existing=successorScheduler({repository:'personal/test',token:'test-secret',runId:'100',fetcher:async()=>{listed++;return Response.json({workflow_runs:[{id:101,status:'queued'}]})}});assert(await existing({owner:true,elapsed:240000}));assert.equal(listed,1);
});
test('failed handoff waits before retry and reports only an HTTP status',async()=>{
 let now=1000,calls=0;const schedule=successorScheduler({repository:'personal/test',token:'test-secret',runId:'100',clock:()=>now,fetcher:async()=>{calls++;return new Response('private upstream details',{status:403})}});
 await assert.rejects(()=>schedule({owner:true,elapsed:240000}),e=>e.message==='다음 수집기 확인 실패 (403)');assert.equal(await schedule({owner:true,elapsed:250000}),false);assert.equal(calls,1);now+=30001;await assert.rejects(()=>schedule({owner:true,elapsed:270000}));assert.equal(calls,2);
});
