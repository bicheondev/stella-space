import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createDenoFxRelay} from '../deno/fx-relay.js';
const req=(path='/api/internal/fx-query?id=123',secret='test')=>new Request('https://relay.test'+path,{headers:{authorization:'Bearer '+secret}});
test('Deno relay preserves all payload fields with gzip and fixes upstream destination',async()=>{
 const original=JSON.stringify({code:200,replies:[{id:'456',text:'한글 日本語',extra:{unknown:true}}],cursor:{bottom:'next'}});let calls=0;
 const relay=createDenoFxRelay({secret:'test',fetcher:async(url,init)=>{calls++;assert.equal(url,'https://api.fxtwitter.com/2/conversation/123?ranking_mode=recency');assert.equal(init.redirect,'manual');return new Response(original,{headers:{'content-type':'application/json'}});}});
 assert.equal((await relay(req('/health',''))).status,200);
 assert.equal((await relay(req(undefined,'bad'))).status,404);
 assert.equal((await relay(req('/api/internal/fx-query?id=https://evil.test'))).status,400);
 assert.equal(calls,0);
 const r=await relay(req());assert.equal(r.status,200);assert.equal(r.headers.get('content-encoding'),'gzip');assert.equal(gunzipSync(Buffer.from(await r.arrayBuffer())).toString(),original);assert.equal(calls,1);
});
test('Deno relay propagates rate limits without retrying and coalesces concurrent requests',async()=>{
 let calls=0,release;const wait=new Promise(r=>release=r);
 const relay=createDenoFxRelay({secret:'test',fetcher:async()=>{calls++;await wait;return Response.json({code:429},{status:429,headers:{'Retry-After':'60'}});}});
 const a=relay(req()),b=relay(req());release();const responses=await Promise.all([a,b]);assert.equal(calls,1);for(const r of responses){assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');}
});
test('Deno relay fails closed on upstream redirects and oversized responses',async()=>{
 let relay=createDenoFxRelay({secret:'test',fetcher:async()=>new Response(null,{status:302,headers:{Location:'https://evil.test'}})});assert.equal((await relay(req())).status,502);
 relay=createDenoFxRelay({secret:'test',fetcher:async()=>new Response('x'.repeat(2*1024*1024+1))});assert.equal((await relay(req())).status,502);
});
