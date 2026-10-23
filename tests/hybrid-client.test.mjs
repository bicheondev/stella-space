import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../worker/index.js';

const html=await(await worker.fetch(new Request('https://test/'))).text();
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const transportSource=script.slice(script.indexOf('function createRealtimeTransport('),script.indexOf('const realtime='));
const createTransport=vm.runInNewContext('('+transportSource+')',{URL,Math,JSON,Number,String,globalThis:{}});

function transportHarness(){
 const timers=new Map(),sockets=[],states=[],rooms=[],members=[];let serial=0,hidden=false;
 class Socket{
  constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
  send(message){this.sent.push(message==='ping'?message:JSON.parse(message));}
  open(){this.readyState=1;this.onopen();}
  receive(value){this.onmessage({data:typeof value==='string'?value:JSON.stringify(value)});}
  close(){this.readyState=3;this.onclose?.();}
 }
 const client=createTransport({origin:'https://realtime.example',WebSocketImpl:Socket,onMembers:value=>members.push(value),onRoom:(data,postId)=>rooms.push({data,postId}),onState:value=>states.push(value),setTimer:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),isHidden:()=>hidden,random:()=>1});
 const fireNext=()=>{const entry=[...timers.entries()][0];assert(entry,'expected a pending timer');timers.delete(entry[0]);entry[1].fn();return entry[1].ms;};
 return{client,timers,sockets,states,rooms,members,fireNext,setHidden:value=>hidden=value};
}

test('realtime connection uses CF directly and reconnects from the last accepted cursor',()=>{
 const h=transportHarness();h.client.setRoom('123',200);h.client.start();
 assert.equal(h.sockets[0].url,'wss://realtime.example/api/live');h.sockets[0].open();
 assert.deepEqual(h.sockets[0].sent,[{type:'subscribe',postId:'123',after:200}]);
 h.client.advance(207);h.client.advance(201);h.sockets[0].close();
 assert.equal(h.client.connected,false);assert.equal(h.fireNext(),1000);h.sockets[1].open();
 assert.deepEqual(h.sockets[1].sent,[{type:'subscribe',postId:'123',after:207}]);
 assert.deepEqual(h.states,[true,false,true]);assert.equal([...h.timers.values()][0].ms,25000);
});

test('room switches unsubscribe and discard late events from the former room or socket',()=>{
 const h=transportHarness();h.client.start();h.sockets[0].open();h.client.setRoom('123',100);
 h.client.setRoom(null);h.sockets[0].receive({type:'room',postId:'123',data:{messages:[{id:'old'}]}});
 h.client.setRoom('456',300);h.sockets[0].receive({type:'room',postId:'123',data:{messages:[{id:'old'}]}});
 h.sockets[0].receive({type:'room',postId:'456',data:{messages:[{id:'new'}],historyCursor:301}});
 assert.equal(h.rooms.length,1);assert.equal(h.rooms[0].postId,'456');
 assert(h.sockets[0].sent.some(value=>value.postId===null));
 h.sockets[0].close();h.fireNext();h.sockets[1].open();
 h.sockets[0].receive({type:'room',postId:'456',data:{messages:[{id:'late'}]}});assert.equal(h.rooms.length,1);
});

test('retry backs off to 15 seconds and hidden tabs do not reconnect until visible',()=>{
 const h=transportHarness();h.client.start();const delays=[];
 for(let i=0;i<7;i++){h.sockets.at(-1).close();delays.push(h.fireNext());}
 assert.deepEqual(delays,[1000,2000,4000,8000,15000,15000,15000]);
 h.setHidden(true);h.sockets.at(-1).close();assert.equal(h.timers.size,0);
 h.client.resume();assert.equal(h.sockets.length,8);h.setHidden(false);h.client.resume();assert.equal(h.sockets.length,9);
 h.sockets.at(-1).open();h.client.pause();assert.equal(h.client.connected,false);assert.equal(h.timers.size,0);
 h.client.resume();assert.equal(h.sockets.length,10);h.client.close();h.client.resume();assert.equal(h.sockets.length,10);
});

test('malformed events cannot alter room state and server errors start recovery',()=>{
 const h=transportHarness();h.client.setRoom('123',1);h.client.start();h.sockets[0].open();
 for(const value of ['{bad json',{type:'members',members:null},{type:'room',postId:'123',data:{messages:null}}])h.sockets[0].receive(value);
 assert.equal(h.rooms.length,0);assert.equal(h.members.length,0);
 h.sockets[0].receive({type:'members',members:[{handle:'ShirayukiHina_',status:'live'}]});assert.equal(h.members.length,1);
 h.sockets[0].receive({type:'error',error:'retry'});assert.equal(h.client.connected,false);assert.equal(h.timers.size,1);
});

test('idle sockets use automatic ping replies and recover from a half-open connection without waiting for close',()=>{
 const h=transportHarness();h.client.setRoom('123',207);h.client.start();h.sockets[0].open();
 assert.equal(h.fireNext(),25000);assert.equal(h.sockets[0].sent.at(-1),'ping');assert.equal([...h.timers.values()][0].ms,10000);
 h.sockets[0].receive('pong');assert.equal([...h.timers.values()][0].ms,25000);
 h.sockets[0].close=()=>{h.sockets[0].readyState=2;};
 h.fireNext();assert.equal(h.fireNext(),10000);assert.equal(h.client.connected,false);assert.equal(h.states.at(-1),false);
 assert.equal(h.fireNext(),1000);h.sockets[1].open();assert.deepEqual(h.sockets[1].sent.at(-1),{type:'subscribe',postId:'123',after:207});
 h.setHidden(true);h.client.suspendChecks();assert.equal(h.timers.size,0);
 h.setHidden(false);h.client.resume();assert.equal(h.sockets[1].sent.at(-1),'ping');assert.equal([...h.timers.values()][0].ms,10000);
});

function chatHarness(){
 const elements=new Map(),timers=[],requests=[],rendered=[],notices=[];
 const element=()=>({textContent:'',title:'',children:[],style:{setProperty(){}},append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},setAttribute(){},querySelector(){return null;}});
 const context=vm.createContext({URL,Intl,Date,Set,location:{pathname:'/'},Image:class{},localStorage:{getItem(){},setItem(){}},history:{replaceState(){}},clearTimeout(){},setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},document:{hidden:false,getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element,body:{classList:{contains(){return false;}}}},window:{},fetch:async(url)=>{requests.push(url);return{ok:true,json:async()=>({messages:[],historyCursor:20,collecting:false})};},rendered,notices});
 vm.runInContext(script.slice(0,script.indexOf("try{$('showImages').checked=")).replace("const realtimeOrigin='';","const realtimeOrigin='https://realtime.example';"),context);
 vm.runInContext("render=()=>{};renderChatMessages=(messages)=>{for(const m of messages){if(!seen.has(m.id)){seen.add(m.id);rendered.push(m.id);}}};updateFollowNotice=()=>{};showBroadcastEnded=()=>notices.push('ended');room={id:'space',tweet:'123',state:'Running'};cursor=20;generation=1;latestHistoryReady=true;",context);
 return{context,elements,timers,requests,rendered,notices};
}

test('late HTTP snapshots cannot rewind the cursor or append stale messages after socket delivery',()=>{
 const h=chatHarness();h.context.payload={messages:[{id:'21'}],historyCursor:21,collecting:false};
 vm.runInContext('applyRoomData(payload,1)',h.context);
 h.context.payload={messages:[{id:'old'}],historyCursor:19,stopped:true};vm.runInContext('applyRoomData(payload,1)',h.context);
 assert.equal(vm.runInContext('cursor',h.context),21);assert.deepEqual(h.rendered,['21']);assert.equal(h.notices.length,0);
 h.context.payload={messages:[{id:'21'},{id:'22'}],historyCursor:22};vm.runInContext('applyRoomData(payload,1)',h.context);
 assert.deepEqual(h.rendered,['21','22']);
});

test('member end status waits for the final room cursor before showing the end notice',async()=>{
 const h=chatHarness();await vm.runInContext("applyMemberStates([{handle:'GANGZIIII',space:'space',state:'Ended',status:'offline'}])",h.context);
 assert.equal(h.notices.length,0);
 h.context.payload={messages:[{id:'21'}],historyCursor:21,stopped:true,hasMore:true};vm.runInContext('applyRoomData(payload,1)',h.context);assert.equal(h.notices.length,0);
 h.context.payload={messages:[{id:'22'}],historyCursor:22,stopped:true,hasMore:false};vm.runInContext('applyRoomData(payload,1)',h.context);
 assert.equal(h.notices.length,1);assert.deepEqual(h.rendered,['21','22']);assert.equal(vm.runInContext('roomCollectionStopped',h.context),true);
 h.context.payload={messages:[],historyCursor:22,collecting:true,spaceState:'Running'};vm.runInContext('applyRoomData(payload,1)',h.context);
 assert.equal(vm.runInContext('roomCollectionStopped',h.context),true);assert.equal(vm.runInContext('room.state',h.context),'Ended');
});

test('offline member snapshots are safe before a room is selected',async()=>{
 const h=chatHarness();vm.runInContext('room=null',h.context);
 await vm.runInContext("applyMemberStates([{handle:'GANGZIIII',state:'Ended',status:'offline'}])",h.context);
 assert.equal(vm.runInContext('room',h.context),null);
});

test('hybrid polling reads CF directly, never triggers collection, and pauses while hidden',async()=>{
 const h=chatHarness();await vm.runInContext('tick(1)',h.context);await vm.runInContext('collectAllLive()',h.context);
 assert.deepEqual(h.requests,['https://realtime.example/api/replies?id=123&after=20']);
 assert.equal(h.timers.at(-1).ms,5000);
 vm.runInContext('document.hidden=true',h.context);await vm.runInContext('tick(1)',h.context);assert.equal(h.requests.length,1);
});
