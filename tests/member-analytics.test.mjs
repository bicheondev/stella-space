import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {googleAnalyticsTag} from '../server/google-analytics.js';
const source=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');
const helper=source.match(/function trackAnalyticsMember\(handle\)\{[^\n]+/)[0];
test('member names reach GA before history navigation without sending duplicate page views',()=>{
 const calls=[],window={gtag:(...args)=>calls.push(args)},groups=[['','',[['강지','GANGZIIII'],['시라유키 히나','ShirayukiHina_']]]];
 const track=runInNewContext(helper+';trackAnalyticsMember',{window,groups});
 track('shirayukihina_');assert.equal(window.spaceliveMemberName,'시라유키 히나');assert.deepEqual(calls[0],['set','content_group','시라유키 히나']);
 track('unknown_test');assert.equal(window.spaceliveMemberName,'외부 테스트');assert(calls.every(c=>c[0]==='set'));assert(googleAnalyticsTag.includes("content_group:window.spaceliveMemberName"));assert(source.includes("trackAnalyticsMember(handle);history.replaceState"));
 delete window.gtag;assert.doesNotThrow(()=>track('GANGZIIII'));assert.equal(window.spaceliveMemberName,'강지');
});
