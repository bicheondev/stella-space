import {test} from 'node:test';import assert from 'node:assert/strict';
import {postCreatedAt,observePostTiming,kstTimestamp,timingLines} from '../worker/post-timing.js';
const postedAt=Date.parse('2026-10-23T14:50:12.345Z'),id=String((BigInt(postedAt)-1288834974657n)<<22n);
test('post creation uses Snowflake milliseconds and keeps both times through KST date boundaries',()=>{
 const p={id,created_timestamp:Math.floor(postedAt/1000)};assert.equal(postCreatedAt(p),postedAt);
 const timing=observePostTiming(p,{source:'push-inbox',observedAt:postedAt+1234,pushReceivedAt:postedAt+100});
 assert.equal(timing.durationMs,1234);assert.equal(timing.pushDetectedAt,postedAt+1234);assert.equal(timing.pushReceivedAt,postedAt+100);
 assert.equal(timing.postedAtKst,'2026-10-23 23:50:12 KST');assert.equal(timing.detectedAtKst,'2026-10-23 23:50:13 KST');assert.equal(kstTimestamp(Date.parse('2026-10-23T15:00:00Z')),'2026-10-24 00:00:00 KST');
});
test('fallback observations never claim push detection or reuse unrelated push receipt times',()=>{
 const t=observePostTiming({id},{source:'fallback-inbox',observedAt:postedAt+5000,pushReceivedAt:postedAt+1});assert.equal(t.pushDetectedAt,null);assert.equal(t.pushReceivedAt,null);assert.match(timingLines(t),/정기 알림함 감지/);assert.doesNotMatch(timingLines(t),/푸시 경로 감지/);assert.match(timingLines({postedAt}),/푸시 경로 감지: 확인되지 않음/);
});
