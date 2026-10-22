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
 vm.runInContext(script.slice(0,script.indexOf("try{$('showImages').checked=")),ctx);
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

test('timestamp layout changes keep following enabled and do not jump readers to the bottom',async()=>{
 const {ctx,elements}=await setup();const box={scrollHeight:1200,scrollTop:500,querySelectorAll:()=>[]};elements.set('messages',box);ctx.document.querySelectorAll=()=>[{hidden:true},{hidden:true}];
 vm.runInContext("$('timestamps').checked=true;auto=true;updateTimestampVisibility()",ctx);assert.equal(box.scrollTop,1200);assert.equal(vm.runInContext('auto',ctx),true);
 box.scrollTop=250;vm.runInContext("auto=false;$('timestamps').checked=false;updateTimestampVisibility()",ctx);assert.equal(box.scrollTop,250);assert.equal(vm.runInContext('auto',ctx),false);
});

test('paused chat shows the latest preview and resuming hides it and follows the bottom',async()=>{
 const {ctx,elements}=await setup();const box={scrollHeight:1800,clientHeight:500,scrollTop:300,querySelectorAll:()=>[]};elements.set('messages',box);
 vm.runInContext("latestChatPreview={name:'사용자',text:'새 메시지',color:'#d58cb2'};updateAutoScroll()",ctx);
 assert.equal(elements.get('resumeChat').hidden,false);assert.equal(elements.get('latestChatName').textContent,'사용자');assert.equal(elements.get('latestChatText').textContent,'새 메시지');assert.equal(box.scrollTop,300);
 vm.runInContext('resumeChatFollowing()',ctx);assert.equal(box.scrollTop,1800);assert.equal(vm.runInContext('auto',ctx),true);assert.equal(elements.get('resumeChat').hidden,true);
});

test('theme and image preferences persist and preserve the current following state',async()=>{
 const{ctx,elements}=await setup(),classes=new Set();ctx.matchMedia=()=>({matches:true});ctx.document.documentElement={dataset:{}};ctx.document.body.classList.toggle=(key,on)=>{if(on)classes.add(key);else classes.delete(key)};
 const box={querySelectorAll:()=>[],scrollHeight:1500,scrollTop:300};elements.set('messages',box);
 vm.runInContext("$('showImages').checked=false;auto=false;applyChatPreferences()",ctx);
 assert.equal(ctx.document.documentElement.dataset.theme,'light');assert(classes.has('hide-chat-images'));assert.equal(box.scrollTop,300);assert.equal(vm.runInContext("localStorage.getItem('chatShowImages')",ctx),'0');
 ctx.matchMedia=()=>({matches:false});vm.runInContext("$('showImages').checked=true;auto=true;applyChatPreferences()",ctx);
 assert.equal(ctx.document.documentElement.dataset.theme,'dark');assert(!classes.has('hide-chat-images'));assert.equal(box.scrollTop,1500);
});

test('avatars retain the last loaded photo, avoid same-URL reloads and ignore stale image completion',async()=>{
 const{ctx}=await setup(),requests=[];ctx.Image=class{set src(value){this.url=value;requests.push(this)}cloneNode(){return{src:this.url,replaceWith(){}}}};
 ctx.avatarTarget={children:[],replaceChildren(){this.children=[]},append(x){this.children.push(x)}};
 const a='https://pbs.twimg.com/profile_images/1/a.jpg',b='https://pbs.twimg.com/profile_images/2/b.jpg';ctx.photoA=a;ctx.photoB=b;
 vm.runInContext("avatar(avatarTarget,'강지',photoA,false,'GANGZIIII')",ctx);assert.equal(requests.length,1);assert.equal(ctx.avatarTarget.textContent,undefined);
 requests[0].onload();await Promise.resolve();assert.equal(ctx.avatarTarget._avatarUrl,a);
 vm.runInContext("avatar(avatarTarget,'강지',photoA,false,'GANGZIIII')",ctx);assert.equal(requests.length,1);
 vm.runInContext("avatar(avatarTarget,'강지',photoB,false,'GANGZIIII')",ctx);assert.equal(ctx.avatarTarget._avatarUrl,a);requests[1].onerror();await Promise.resolve();await Promise.resolve();assert.equal(ctx.avatarTarget._avatarUrl,a);
 vm.runInContext("avatar(avatarTarget,'강지',photoB,false,'GANGZIIII')",ctx);requests[2].onload();await Promise.resolve();assert.equal(ctx.avatarTarget._avatarUrl,b);assert.equal(vm.runInContext("JSON.parse(localStorage.getItem('chatAvatarUrls')).GANGZIIII",ctx),b);
 vm.runInContext("avatar(avatarTarget,'다른 멤버',null,false,'Other')",ctx);assert.equal(ctx.avatarTarget._avatarUrl,null);assert.equal(ctx.avatarTarget.children.length,0);
});
