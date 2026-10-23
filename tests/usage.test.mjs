import {test} from 'node:test';import assert from 'node:assert/strict';
import {usageDashboard,validateUsage} from '../server/usage.js';
const now=Date.parse('2026-10-24T00:10:00+09:00');
test('rolling limits have no invented reset and preserve unknown usage instead of zero',()=>{
 const d=usageDashboard({providers:{vercel:{checkedAt:new Date(now).toISOString(),metrics:{cpuSeconds:11520}}}},now),v=d.providers[0],cf=d.providers[1];assert.equal(v.resetsAt,null);assert.equal(v.metrics[0].leftPercent,19.999999999999996);assert.equal(v.metrics[1].used,null);assert.equal(cf.metrics[0].leftPercent,null);assert.equal(cf.resetsAt,'2026-10-24T00:00:00.000Z');
});
test('Cloudflare snapshots expire at UTC midnight without pretending that old usage reset to zero',()=>{
 const d=usageDashboard({providers:{cloudflare:{checkedAt:'2026-10-23T23:59:00Z',metrics:{durationGBs:12000}}}},Date.parse('2026-10-24T00:01:00Z'));assert.equal(d.providers[1].status,'expired');assert.equal(d.providers[1].metrics[2].used,null);assert.equal(d.providers[1].resetsAt,'2026-10-25T00:00:00.000Z');
});
test('Turso reset countdown is absent until a real period end is supplied',()=>{
 assert.equal(usageDashboard({providers:{}},now).providers[2].resetsAt,null);
 const input=validateUsage({providers:{turso:{period:'monthly',checkedAt:new Date(now).toISOString(),resetsAt:'2026-11-01T00:00:00Z',metrics:{rowsRead:0}}}},now);const t=usageDashboard(input,now).providers[2];assert.equal(t.metrics[0].used,0);assert.equal(t.metrics[0].leftPercent,100);assert.equal(t.resetsAt,'2026-11-01T00:00:00.000Z');
});
test('snapshots reject forged periods, future times, invalid values and non-service targets',()=>{
 for(const providers of [{other:{}},{vercel:{period:'daily',checkedAt:new Date(now).toISOString(),metrics:{cpuSeconds:1}}},{cloudflare:{period:'daily',checkedAt:new Date(now+3600000).toISOString(),metrics:{rowsRead:1}}},{turso:{period:'monthly',checkedAt:new Date(now).toISOString(),metrics:{rowsRead:-1}}}])assert.throws(()=>validateUsage({providers},now));
});
