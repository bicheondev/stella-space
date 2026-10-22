import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker,{parseFxReplies,memberFromPath,firstLiveMember,initialPage} from '../worker/index.js';
async function setup(){
 const html=await(await worker.fetch(new Request('https://test/'))).text();
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 new vm.Script(script);
 const elements=new Map(),element=()=>({textContent:'',value:'',className:'',hidden:false,children:[],style:{setProperty(){}},append(...x){this.children.push(...x);},replaceChildren(){this.children=[];},setAttribute(){},querySelector(){return null;}});
 const storage=new Map(),urls=[];const ctx=vm.createContext({URL,Intl,Date,Set,location:{pathname:'/'},Image:class{},localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)},history:{replaceState(_state,_title,url){urls.push(url);}},clearTimeout(){},setTimeout(){},document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element,body:{classList:{contains(){return false;}}}}});
 vm.runInContext(script.slice(0,script.indexOf("$('choose').onclick=")),ctx);
 vm.runInContext("render=()=>{};tick=async()=>{};",ctx);
 const refresh=script.slice(script.indexOf('async function refresh()'),script.lastIndexOf('refresh();setInterval'));
 vm.runInContext(refresh,ctx);
 return{ctx,elements,urls};
}
test('opening a Hina post synchronizes the selected member and header',async()=>{
 const{ctx,elements,urls}=await setup();ctx.response={id:'room',tweet:'123',handle:'ShirayukiHina_',state:'Running'};
 vm.runInContext('api=async()=>response',ctx);await vm.runInContext("connect('https://x.com/i/status/123')",ctx);
 assert.equal(urls.at(-1),'/ShirayukiHina_');assert.equal(vm.runInContext('selected',ctx),'ShirayukiHina_');assert.equal(elements.get('selectedName').textContent,'시라유키 히나');
});
test('a member refresh started before a selection change cannot connect the old room',async()=>{
 const{ctx}=await setup();let done;ctx.pending=new Promise(r=>done=r);vm.runInContext('api=()=>pending;connect=async()=>{throw Error("unexpected connect")}',ctx);
 const pending=vm.runInContext('refresh()',ctx);vm.runInContext("generation++;selected='ShirayukiHina_'",ctx);
 done([{handle:'ShirayukiHina_',status:'live',postUrl:'old',space:'old'}]);await pending;
 assert.equal(vm.runInContext('room',ctx),null);
});
test('photo attachments accept only X media URLs and keep thumbnail originals',()=>{
 const reply={id:'2',type:'status',replying_to:{status:'1'},text:'photo',media:{photos:[{url:'https://pbs.twimg.com/media/test.jpg?name=orig'},{url:'javascript:alert(1)'},{url:'https://evil.example/test.jpg'}]}};
 const result=parseFxReplies({code:200,replies:[reply]},'1');assert.deepEqual(result.messages[0].photos,[{url:'https://pbs.twimg.com/media/test.jpg?name=orig'}]);
});

test('member paths normalize handles and reject unrelated or malformed paths',()=>{
 const groups=[['group','name',[['히나','ShirayukiHina_']]]];
 assert.equal(memberFromPath('/shirayukihina_/',groups),'ShirayukiHina_');
 assert.equal(memberFromPath('/unknown',groups),null);assert.equal(memberFromPath('/%zz',groups),null);
});

test('root auto-selection follows dropdown order rather than response or saved-member order',()=>{
 const groups=[['one','one',[['유니','Yuni'],['후야','Huya']]],['two','two',[['히나','Hina']]]];
 assert.equal(firstLiveMember(groups,[{handle:'Hina',status:'live'},{handle:'Huya',status:'live'},{handle:'Yuni',status:'offline'}]),'Huya');
 assert.equal(firstLiveMember(groups,[{handle:'Yuni',status:'live',stale:true},{handle:'Hina',status:'live'}]),'Hina');
 assert.equal(firstLiveMember(groups,[{handle:'Yuni',status:'offline'}]),null);
});

test('root chooses Gangzi when everyone is offline, regardless of the saved member',async()=>{
 const{ctx}=await setup();ctx.response=[{handle:'GANGZIIII',status:'offline'},{handle:'ShirayukiHina_',status:'offline'}];
 vm.runInContext("rootPending=true;const saved='ShirayukiHina_';api=async()=>response;select=async(name,handle)=>{chosen=handle;rootPending=false}",ctx);
 await vm.runInContext('refresh()',ctx);assert.equal(ctx.chosen,'GANGZIIII');
});

test('reading older chat disables following until the viewport returns to the bottom',async()=>{
 const{ctx,elements}=await setup();vm.runInContext("$('messages')",ctx);const box=elements.get('messages');
 Object.assign(box,{scrollHeight:2000,clientHeight:500,scrollTop:1000});vm.runInContext('updateAutoScroll()',ctx);assert.equal(vm.runInContext('auto',ctx),false);
 box.scrollTop=1500;vm.runInContext('updateAutoScroll()',ctx);assert.equal(vm.runInContext('auto',ctx),true);
});

test('initial HTML renders recent shared member status without waiting for external discovery and escapes embedded data',async()=>{
 const row={handle:'ShirayukiHina_',status:'live',checkedAt:new Date().toISOString(),postUrl:'</script><script>alert(1)</script>',error:'internal details'};
 const db={prepare(){return{bind(){return{async all(){return{results:[{payload:JSON.stringify(row)}]}}}}}}};
 const page=await initialPage(db,'/ShirayukiHina_');assert(page.includes('class="status live" id="selectedStatus">방송 중</span>'));assert(!page.includes('internal details'));assert(!page.includes(row.postUrl));new vm.Script(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
 row.checkedAt=new Date(Date.now()-120000).toISOString();const stale=await initialPage(db,'/ShirayukiHina_');assert(stale.includes('class="status unknown" id="selectedStatus">확인 중</span>'));
 row.status='offline';row.checkedAt=new Date().toISOString();assert((await initialPage(db,'/ShirayukiHina_')).includes('class="status offline" id="selectedStatus">오프라인</span>'));
});

test('an unregistered Space creator replaces the previous selection and live avatar state',async()=>{
 const {ctx,elements}=await setup();ctx.response={id:'externalroom',tweet:null,handle:'Sikha__Patel',state:'Running',avatar:'https://pbs.twimg.com/profile_images/test.jpg',currentParticipants:88};
 vm.runInContext('api=async()=>response',ctx);await vm.runInContext("connect('https://x.com/i/spaces/externalroom')",ctx);
 assert.equal(vm.runInContext('selected',ctx),'Sikha__Patel');assert.equal(vm.runInContext('statuses[selected].status',ctx),'live');assert.equal(vm.runInContext('statuses[selected].avatar',ctx),ctx.response.avatar);assert.equal(elements.get('selectedName').textContent,'Sikha__Patel');assert.match(elements.get('connection').textContent,/공유 게시물 미발견/);
});

test('chat arrival animates upward movement, respects disabled motion and preserves reader position',async()=>{
 const {ctx,elements}=await setup();const calls=[];ctx.oldMessage={getBoundingClientRect:()=>({top:80}),getAnimations:()=>[],animate:(frames,opts)=>calls.push({frames,opts})};ctx.newMessage={animate:(frames,opts)=>calls.push({frames,opts})};
 const box=elements.get('messages')||{};elements.set('messages',box);box.scrollHeight=900;box.scrollTop=100;
 vm.runInContext("animateChatArrival(new Map([[oldMessage,100]]),[newMessage])",ctx);assert.equal(box.scrollTop,900);assert.equal(calls.length,2);assert.equal(calls[0].frames[0].transform,'translateY(20px)');
 vm.runInContext("$('disableAnimation').checked=true;animateChatArrival(new Map([[oldMessage,100]]),[newMessage])",ctx);assert.equal(calls.length,2);
 box.scrollTop=100;vm.runInContext("auto=false;$('disableAnimation').checked=false;animateChatArrival(new Map([[oldMessage,100]]),[newMessage])",ctx);assert.equal(box.scrollTop,100);assert.equal(calls.length,2);
 ctx.matchMedia=()=>({matches:true});vm.runInContext('auto=true;animateChatArrival(new Map([[oldMessage,100]]),[newMessage])',ctx);assert.equal(calls.length,2);
});
