import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequestBudget} from '../cloudflare/request-budget.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('a new alarm is required before spending the next batch of external requests',async()=>{
  let calls=0,alarms=0;
  const budget=createRequestBudget({limit:3,onExhausted:()=>{alarms++},fetcher:async()=>{calls++;return Response.json({ok:true});}});
  const tasks=Array.from({length:7},()=>budget.fetch('https://example.com'));
  await turn();assert.equal(calls,3);assert.equal(alarms,1);assert.equal(budget.stats().queued,4);
  budget.reset();await turn();assert.equal(calls,6);assert.equal(alarms,2);
  budget.reset();await Promise.all(tasks);assert.equal(calls,7);
});
test('streaming bodies hold a connection slot until drained',async()=>{
  let calls=0,controller;
  const budget=createRequestBudget({concurrency:1,onExhausted:()=>{},fetcher:async()=>{calls++;return calls===1?new Response(new ReadableStream({start(c){controller=c}})):new Response('second');}});
  const first=budget.fetch('https://example.com/1'),second=budget.fetch('https://example.com/2');
  await turn();assert.equal(calls,1);controller.enqueue(new TextEncoder().encode('first'));controller.close();
  assert.equal(await(await first).text(),'first');assert.equal(await(await second).text(),'second');
});
test('aborted queued requests and stop cannot leak work into the next alarm',async()=>{
  const budget=createRequestBudget({limit:1,onExhausted:()=>{},fetcher:async()=>new Response('ok')});
  await budget.fetch('https://example.com');const abort=new AbortController();
  const queued=budget.fetch('https://example.com',{signal:abort.signal});abort.abort();await assert.rejects(queued);
  const stopped=budget.fetch('https://example.com');budget.close();await assert.rejects(stopped,/stopped/);
  assert.equal(budget.stats().queued,0);
});
test('redirect error mode is enforced without passing an unsupported mode to Workers',async()=>{
  let mode,calls=0;
  const budget=createRequestBudget({fetcher:async(_url,init)=>{mode=init.redirect;calls++;return calls===1?new Response(null,{status:302,headers:{location:'https://other.example/'}}):new Response('ok');}});
  await assert.rejects(budget.fetch('https://example.com',{redirect:'error'}),/redirect rejected/);
  assert.equal(mode,'manual');assert.equal(calls,1);assert.equal(budget.stats().active,0);
  assert.equal(await(await budget.fetch('https://example.com',{redirect:'error'})).text(),'ok');
});
