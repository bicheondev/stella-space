import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LeasedAutopushClient,PUSH_KEEPALIVE_MS} from '../scripts/autopush-client.mjs';

function fixture(t,options={}){
 const sockets=[],timers=new Map();let clock=0,id=0;
 class Socket{
  constructor(url){assert.equal(url,'wss://push.services.mozilla.com/');this.readyState=0;this.sent=[];sockets.push(this);}
  send(value){this.sent.push(JSON.parse(value));}
  open(){this.readyState=1;this.onopen?.();}
  message(value){this.onmessage?.({data:JSON.stringify(value)});}
  remoteClose(){this.readyState=3;this.onclose?.({code:1001,wasClean:true,reason:'private-server-content'});}
  close(){this.readyState=3;this.onclose?.({code:1000,wasClean:true,reason:''});}
 }
 const originalSocket=globalThis.WebSocket;globalThis.WebSocket=Socket;t.after(()=>{globalThis.WebSocket=originalSocket;});
 const client=new LeasedAutopushClient({uaid:'existing-user',channelId:'existing-channel',vapidKey:'key',remoteBroadcasts:{broadcast:'version'},onNotification:()=>{},...options},{now:()=>clock,setInterval:(fn,ms)=>{assert.equal(ms,65000);timers.set(++id,fn);return id;},clearInterval:key=>timers.delete(key)});
 async function connect(){const pending=client.connect(),socket=sockets.at(-1);socket.open();socket.message({messageType:'hello',uaid:'existing-user',broadcasts:{broadcast:'new-version'}});socket.message({messageType:'register',status:200,pushEndpoint:'https://updates.push.services.mozilla.com/test'});await pending;return socket;}
 return {client,sockets,timers,connect,advance:ms=>{clock+=ms;for(const fn of [...timers.values()])fn();}};
}

test('real xnotif handshake and notification ack are unchanged; keepalive is an empty object, not a notification',async t=>{
 let delivered=0;const f=fixture(t,{onNotification:()=>delivered++});const socket=await f.connect();
 assert.deepEqual(socket.sent[0],{messageType:'hello',use_webpush:true,uaid:'existing-user',broadcasts:{broadcast:'version'}});
 assert.deepEqual(socket.sent[1],{messageType:'register',channelID:'existing-channel',key:'key'});
 assert.equal(f.client.getUaid(),'existing-user');assert.deepEqual(f.client.getRemoteBroadcasts(),{broadcast:'new-version'});
 assert.ok(PUSH_KEEPALIVE_MS>=60000);f.advance(65000);assert.deepEqual(socket.sent.at(-1),{});
 socket.message({});assert.equal(delivered,0);
 socket.message({messageType:'notification',channelID:'existing-channel',version:'1'});assert.equal(delivered,1);
 assert.deepEqual(socket.sent.at(-1),{messageType:'ack',updates:[{channelID:'existing-channel',version:'1',code:100}]});
 f.client.close();assert.equal(f.timers.size,0);
});

test('remote closure stops pings, exposes safe close metadata, and never opens an unleased retry',async t=>{
 let disconnected=0;const f=fixture(t,{onDisconnected:()=>disconnected++});const socket=await f.connect();
 f.advance(126000);socket.remoteClose();assert.equal(f.timers.size,0);assert.equal(disconnected,1);assert.equal(f.sockets.length,1);
 assert.deepEqual(f.client.diagnostics(),{code:1001,wasClean:true,durationMs:126000});
 assert.ok(!JSON.stringify(f.client.diagnostics()).includes('private-server-content'));
});

test('intentional ownership shutdown cancels keepalive and does not report a reconnect',async t=>{
 let disconnected=0;const f=fixture(t,{onDisconnected:()=>disconnected++});const socket=await f.connect();f.client.close();
 const sent=socket.sent.length;f.advance(65000);assert.equal(socket.sent.length,sent);assert.equal(disconnected,0);assert.equal(f.timers.size,0);
});

test('failed subscription never starts a keepalive',async t=>{
 const f=fixture(t),pending=f.client.connect(),socket=f.sockets[0];socket.open();socket.message({messageType:'hello',uaid:'existing-user'});socket.message({messageType:'register',status:500});
 await assert.rejects(pending,/Register failed/);assert.equal(f.timers.size,0);f.client.close();
});
