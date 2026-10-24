import {test} from 'node:test';import assert from 'node:assert/strict';
import {usageDashboard,validateUsage} from '../server/usage.js';
const now=Date.parse('2026-10-24T00:10:00+09:00');
test('rolling limits have no invented reset and preserve unknown usage instead of zero',()=>{
 const d=usageDashboard({providers:{vercel:{checkedAt:new Date(now).toISOString(),metrics:{cpuSeconds:11520}}}},now),v=d.providers[0],cf=d.providers[1];assert.equal(v.resetsAt,null);assert.equal(v.metrics[0].leftPercent,19.999999999999996);assert.equal(v.metrics[1].used,null);assert.equal(cf.metrics[0].leftPercent,null);assert.equal(cf.resetsAt,'2026-10-24T00:00:00.000Z');
});
test('Cloudflare snapshots expire at UTC midnight without pretending that old usage reset to zero',()=>{
 const d=usageDashboard({providers:{cloudflare:{checkedAt:'2026-10-23T23:59:00Z',metrics:{durationGBs:12000}}}},Date.parse('2026-10-24T00:01:00Z'));assert.equal(d.providers[1].status,'expired');assert.equal(d.providers[1].metrics[2].used,null);assert.equal(d.providers[1].resetsAt,'2026-10-25T00:00:00.000Z');
});
test('Turso uses the official UTC calendar-month estimate unless a confirmed end is supplied',()=>{
 assert.equal(usageDashboard({providers:{}},now).providers[2].resetsAt,'2026-11-01T00:00:00.000Z');assert.equal(usageDashboard({providers:{}},now).providers[2].resetEstimated,true);
 const input=validateUsage({providers:{turso:{period:'monthly',checkedAt:new Date(now).toISOString(),resetsAt:'2026-11-01T00:00:00Z',metrics:{rowsRead:0}}}},now);const t=usageDashboard(input,now).providers[2];assert.equal(t.metrics[0].used,0);assert.equal(t.metrics[0].leftPercent,100);assert.equal(t.resetsAt,'2026-11-01T00:00:00.000Z');
});
test('snapshots reject forged periods, future times, invalid values and non-service targets',()=>{
 for(const providers of [{other:{}},{vercel:{period:'daily',checkedAt:new Date(now).toISOString(),metrics:{cpuSeconds:1}}},{cloudflare:{period:'daily',checkedAt:new Date(now+3600000).toISOString(),metrics:{rowsRead:1}}},{turso:{period:'monthly',checkedAt:new Date(now).toISOString(),metrics:{rowsRead:-1}}}])assert.throws(()=>validateUsage({providers},now));
});
test('saved usage merges providers, caches reads, and does not expose arbitrary source text',async()=>{
 const {readUsage,saveUsage}=await import('../server/usage.js');let stored=null,reads=0;
 const db={prepare:sql=>({bind:value=>({first:async()=>{
  if(sql.startsWith('SELECT')){reads++;return stored?{value:stored}:null;}
  stored=value;return{key:'usage_snapshot'};
 }})})};
 await readUsage(db,{now});await readUsage(db,{now:now+1000});assert.equal(reads,1);
 const result=await saveUsage(db,{providers:{vercel:{period:'rolling30',checkedAt:new Date(now).toISOString(),source:'<script>bad</script>',metrics:{cpuSeconds:12000}}}},{now});assert.equal(result.providers[0].metrics[0].used,12000);assert(!stored.includes('<script>'));assert.equal(result.providers[0].resetsAt,null);
 await saveUsage(db,{providers:{cloudflare:{period:'daily',checkedAt:new Date(now).toISOString(),metrics:{durationGBs:100}}}},{now});const both=await readUsage(db,{now});assert.equal(both.providers[0].metrics[0].used,12000);assert.equal(both.providers[1].metrics[2].used,100);
});
test('usage edits require the owner session and same-origin POST',async()=>{
 const {operations}=await import('../server/operations.js');const {adminSessionCookie}=await import('../server/admin-auth.js');process.env.ADMIN_SESSION_SECRET='usage-edit-test-secret';
 const url=new URL('https://spacelive.vercel.app/api/admin/usage');assert.equal((await operations({method:'GET',headers:{}},url,null)).status,404);const cookie=adminSessionCookie().split(';')[0];assert.equal((await operations({method:'POST',headers:{cookie,origin:'https://other.example'}},url,null)).status,403);assert.equal((await operations({method:'DELETE',headers:{cookie}},url,null)).status,405);
});

test('monthly resets handle month-end and year rollover',()=>{for(const [at,end]of [['2026-10-31T23:59:59Z','2026-11-01T00:00:00.000Z'],['2026-12-31T23:59:59Z','2027-01-01T00:00:00.000Z']])assert.equal(usageDashboard({providers:{}},Date.parse(at)).providers[2].resetsAt,end);});

test('monthly rollover expires reads and writes but retains storage',()=>{const t=usageDashboard({providers:{turso:{checkedAt:'2026-10-31T23:59:00Z',metrics:{rowsRead:100,storageBytes:200}}}},Date.parse('2026-11-01T00:01:00Z')).providers[2];assert.equal(t.metrics[0].used,null);assert.equal(t.metrics[2].used,200);});
