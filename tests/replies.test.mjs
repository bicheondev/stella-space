import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{parseFxReplies,currentParticipants} from '../worker/index.js';
const root='2112891916077687250';
test('Fx response codes are checked even when HTTP response is 200',()=>{
 assert.throws(()=>parseFxReplies({code:404,replies:null},root),/404/);
});
test('Fx extraction excludes root, nested replies and unrelated posts',()=>{
 const reply={id:'10',type:'status',replying_to:{status:root},text:'hello',author:{name:'팬'},created_timestamp:1700000000};
 const r=parseFxReplies({code:200,replies:[reply,reply,{...reply,id:'11',replying_to:{status:'other'}},{...reply,id:root,replying_to:null}],status:{replies:100},cursor:{bottom:'next'}},root);
 assert.equal(r.messages.length,1);assert.equal(r.messages[0].time,1700000000000);assert.equal(r.total,100);assert.equal(r.cursor,'next');
});
test('reply API validates input before making any network request',async()=>{
 const r=await worker.fetch(new Request('http://localhost/api/replies?id=not-a-tweet&source=fxtwitter'));assert.equal(r.status,502);assert.match((await r.json()).error,/ID/);
});

test('API work stays attached to the Worker lifetime after a client disconnect',async()=>{
 const retained=[];
 const result=await worker.fetch(new Request('http://localhost/api/replies?id=invalid'),{}, {waitUntil:p=>retained.push(p)});
 assert.equal(result.status,502);assert.equal(retained.length,1);await retained[0];
});

test('current audience uses participant total only while running, never lifetime listeners',()=>{
 assert.equal(currentParticipants({metadata:{state:'Running',total_live_listeners:999},participants:{total:123}}),123);
 assert.equal(currentParticipants({metadata:{state:'Running'},participants:{total:0}}),0);
 assert.equal(currentParticipants({metadata:{state:'Ended',total_live_listeners:999},participants:{total:0}}),null);
 assert.equal(currentParticipants({metadata:{state:'Running',total_live_listeners:999}}),null);
});
