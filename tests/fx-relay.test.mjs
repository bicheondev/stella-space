import {test} from 'node:test';import assert from 'node:assert/strict';
import {createFxRelay} from '../server/fx-relay.js';import {createVercelReplies} from '../cloudflare/vercel-replies.js';
const environment={CLOUDFLARE_COLLECTOR_SECRET:'test-secret'},req={method:'GET',headers:{authorization:'Bearer test-secret'}};
test('private relay rejects anonymous requests and cannot fetch arbitrary URLs or profiles',async()=>{
 let calls=0;const relay=createFxRelay({environment,fetcher:()=>{calls++;throw Error();}});
 assert.equal((await relay({headers:{}},new URL('https://site/api?id=123'))).status,404);
 for(const query of ['id=https://example.com','kind=profile&id=outsider','kind=other&id=123'])assert.equal((await relay(req,new URL('https://site/api?'+query))).status,400);
 assert.equal(calls,0);
});
test('relay uses fixed identity lookup and preserves errors and Retry-After without retry',async()=>{
 const urls=[];const relay=createFxRelay({environment,fetcher:async url=>{urls.push(url);return Response.json({code:429},{status:429,headers:{'Retry-After':'120'}});}});
 const r=await relay(req,new URL('https://site/api?kind=profile&id=ShirayukiHina_'));
 assert.match(urls[0],/\/profile\/id:1664220975502876672\/statuses/);assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'120');assert.equal(urls.length,1);
});
test('same in-flight query is coalesced and returned independently to callers',async()=>{
 let release,calls=0;const wait=new Promise(r=>release=r);const relay=createFxRelay({environment,fetcher:async()=>{calls++;await wait;return Response.json({code:200,replies:[]});}});
 const a=relay(req,new URL('https://site/api?id=123')),b=relay(req,new URL('https://site/api?id=123'));release();const result=await Promise.all([a,b]);assert.equal(calls,1);for(const r of result)assert.equal((await r.json()).code,200);
});
test('coordinator reserves monthly relay allocation durably and does not reset it on restart',async()=>{
 const values=new Map(),storage={async get(k){return values.get(k);},async put(k,v){values.set(k,v);}};let calls=0;
 const config={origin:'https://spacelive.vercel.app',secret:'test-secret',storage,monthlyLimit:2,fetcher:async(url,init)=>{assert.equal(new URL(url).hostname,'spacelive.vercel.app');assert.equal(init.headers.authorization,'Bearer test-secret');calls++;return Response.json({code:200});}};
 const relay=createVercelReplies(config);await relay.fetch('https://api.fxtwitter.com/2/conversation/123');assert.equal(calls,1);
 const reboot=createVercelReplies(config);await assert.rejects(reboot.fetch('https://api.fxtwitter.com/2/conversation/123'),/30일 안전 한도/);assert.equal(calls,1);
 await assert.rejects(relay.fetch('https://api.fxtwitter.com/2/profile/foo'),/Invalid reply relay target/);
});
test('rolling safety allocation does not reset at a month boundary',async()=>{
 let clock=Date.parse('2026-10-31T23:59:00Z');const values=new Map(),storage={async get(k){return values.get(k)},async put(k,v){values.set(k,v)}};
 const relay=createVercelReplies({origin:'https://spacelive.vercel.app',secret:'s',storage,monthlyLimit:2,now:()=>clock,fetcher:async()=>Response.json({})});
 await relay.fetch('https://api.fxtwitter.com/2/conversation/123');clock+=120000;
 await assert.rejects(relay.fetch('https://api.fxtwitter.com/2/conversation/123'),/30일 안전 한도/);clock+=31*86400000;await relay.fetch('https://api.fxtwitter.com/2/conversation/123');
});
