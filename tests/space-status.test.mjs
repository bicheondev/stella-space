import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decideSpaceStatus} from '../worker/index.js';
const prior={handle:'member',space:'old',state:'Running',postUrl:'https://x.com/member/status/111'};
test('a running Space remains live even after the share leaves the latest five posts',()=>{
 const result=decideSpaceStatus({prior,previous:{state:'Running'},feedFresh:true});assert.equal(result.status,'live');assert.equal(result.space,'old');
});
test('a source outage does not stop a Space verified independently',()=>{
 assert.equal(decideSpaceStatus({prior,previous:{state:'Running'},feedFresh:false}).status,'live');
});
test('failure to verify a known live Space is unknown, never a synthetic Ended state',()=>{
 const result=decideSpaceStatus({prior,feedFresh:true});assert.equal(result.status,'unknown');assert.equal(result.state,'Unknown');assert.equal(result.postUrl,prior.postUrl);
});
test('an explicit Ended result ends the retained Space even during a timeline outage',()=>{
 const result=decideSpaceStatus({prior,previous:{state:'Ended'},feedFresh:false});assert.equal(result.status,'offline');assert.equal(result.state,'Ended');
});
test('only a verified new live Space replaces the previous broadcast',()=>{
 const found={space:'new'};
 assert.equal(decideSpaceStatus({prior,found,candidate:{state:'Running'},previous:{state:'Running'},feedFresh:true}).space,'new');
 assert.equal(decideSpaceStatus({prior,found,candidate:{state:'NotStarted'},previous:{state:'Running'},feedFresh:true}).space,'old');
});
test('five-post offline heuristic applies only when no known running Space requires verification',()=>{
 assert.equal(decideSpaceStatus({feedFresh:true}).status,'offline');assert.equal(decideSpaceStatus({feedFresh:false}).status,'unknown');
});
