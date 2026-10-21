import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{parseGuestReplies,parseFxReplies} from '../worker/index.js';
const root='2112891916077687250';
const tweet=(id,parent,text)=>({__typename:'Tweet',rest_id:id,reply_to_results:{rest_id:parent},details:{full_text:text,created_at_ms:1700000000000},core:{user_results:{result:{core:{name:'팬',screen_name:'fan'}}}}});
const html=data=>'value:'+JSON.stringify(JSON.stringify({data:{threaded_conversation_with_injections_v2:{entries:data}}}));
test('guest extraction accepts only direct replies, removes duplicates and never descends into quoted posts',()=>{
 const a=tweet('10',root,'hi');a.quoted_status_result=tweet('11',root,'quoted');
 const r=parseGuestReplies(html([tweet(root,null,'parent'),a,a,tweet('12','other','unrelated')]),root);
 assert.deepEqual(r.messages.map(x=>x.id),['10']);assert.equal(r.limited,true);
});
test('untrusted hydration contents remain text, malformed JSON and login HTML fail clearly',()=>{
 const text='</script><script>globalThis.executed=true</script>';
 assert.equal(parseGuestReplies(html([tweet('10',root,text)]),root).messages[0].text,text);
 assert.throws(()=>parseGuestReplies('<h1>Log in</h1>',root),/미리보기/);
 assert.throws(()=>parseGuestReplies('value:"malformed"',root),/미리보기/);
});
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
