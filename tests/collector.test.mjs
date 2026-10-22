import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import worker,{sharedCollect,findSpacePost,replyInterval,reserveFxSlot,collectLiveRooms} from '../worker/index.js';
const migration=readFileSync(new URL('../drizzle/0000_windy_bushwacker.sql',import.meta.url),'utf8');
function binding(sqlite){
 return {
  prepare(sql){
   return {
    bind(...args){
     return {async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return{results:sqlite.prepare(sql).all(...args)};}};
    }
   };
  }
 };
}
function setup(){const file=join(mkdtempSync(join(tmpdir(),'stella-collector-')),'db.sqlite');const a=new DatabaseSync(file);a.exec(migration);const b=new DatabaseSync(file);return{a,b,dbA:binding(a),dbB:binding(b)};}
test('different workers contend for one database lease and issue only one external fetch',async()=>{
 const{a,b,dbA,dbB}=setup();let calls=0,release;const gate=new Promise(r=>release=r);const produce=async()=>{calls++;await gate;return{messages:[{id:'1',time:1}],source:'fxtwitter'};};
 const winner=sharedCollect(dbA,'replies:fxtwitter:1',1000,produce);await new Promise(r=>setImmediate(r));
 const others=await Promise.all(Array.from({length:50},(_,i)=>sharedCollect(i%2?dbA:dbB,'replies:fxtwitter:1',1000,produce)));
 assert.equal(calls,1);assert.ok(others.every(r=>r.collecting));release();await winner;
 assert.equal((await sharedCollect(dbB,'replies:fxtwitter:1',1000,produce)).messages.length,1);
 assert.equal(calls,1);assert.equal(a.prepare('SELECT fetch_count FROM collector_entries').get().fetch_count,1);a.close();b.close();
});
test('the shared one-second interval survives a different worker reading it; history is merged',async()=>{
 const{a,b,dbA,dbB}=setup();let now=1000,calls=0;const options={clock:()=>now,mergeMessages:true};
 const produce=async()=>({messages:[{id:String(++calls),time:now}]});
 await sharedCollect(dbA,'key',1000,produce,options);now=1999;await sharedCollect(dbB,'key',1000,produce,options);assert.equal(calls,1);
 now=2000;const value=await sharedCollect(dbB,'key',1000,produce,options);assert.equal(calls,2);assert.deepEqual(value.messages.map(m=>m.id),['1','2']);a.close();b.close();
});
test('an expired lease is recoverable and an old owner cannot overwrite a newer result',async()=>{
 const{a,b,dbA,dbB}=setup();let now=1000,release;const gate=new Promise(r=>release=r);const options={clock:()=>now,leaseMs:100};
 const old=sharedCollect(dbA,'key',1000,async()=>{await gate;return{version:'old'};},options);await new Promise(r=>setImmediate(r));
 now=1101;await sharedCollect(dbB,'key',1000,async()=>({version:'new'}),options);release();await old;
 assert.equal(JSON.parse(a.prepare('SELECT payload FROM collector_entries').get().payload).version,'new');a.close();b.close();
});
test('upstream failure keeps prior replies and applies shared retry backoff',async()=>{
 const{a,b,dbA,dbB}=setup();let now=1000,calls=0;const options={clock:()=>now};
 await sharedCollect(dbA,'key',1000,async()=>({messages:[{id:'1'}]}),options);now=2000;
 const failing=async()=>{calls++;throw Error('upstream 429');};const stale=await sharedCollect(dbB,'key',1000,failing,options);
 assert.equal(stale.stale,true);assert.equal(stale.messages[0].id,'1');now=3000;await sharedCollect(dbA,'key',1000,failing,options);assert.equal(calls,1);a.close();b.close();
});
test('missing shared storage fails closed instead of silently making per-worker calls',async()=>{
 let calls=0;await assert.rejects(sharedCollect(undefined,'key',1000,async()=>{calls++;}),/저장소/);assert.equal(calls,0);
});
test('member discovery takes the newest own Space post, ignoring reposts and handle case',()=>{
 const post=(id,handle,time,text)=>({id,author:{screen_name:handle},created_timestamp:time,text});
 const result=findSpacePost([post('other','someone',500,'https://x.com/i/spaces/1OtherRoom'),post('old','Shirayukihina_',100,'https://x.com/i/spaces/1OldRoom'),post('new','Shirayukihina_',200,'https://x.com/i/spaces/1NewRoom')],'ShirayukiHina_');
 assert.equal(result.post.id,'new');assert.equal(result.space,'1NewRoom');
});

test('Space discovery excludes a Space older than the latest five own posts',()=>{
 const posts=Array.from({length:6},(_,i)=>({id:String(i),author:{screen_name:'member'},created_timestamp:100-i,text:i===5?'https://x.com/i/spaces/1OlderSpace':'ordinary post'}));
 assert.equal(findSpacePost(posts,'member'),null);
 posts[4].text='https://x.com/i/spaces/1RecentSpace';
 assert.equal(findSpacePost(posts,'member').post.id,'4');
});

test('adaptive interval reserves profile traffic and grows with live rooms',()=>{
 assert.equal(replyInterval(0),84);assert.equal(replyInterval(1),84);assert.equal(replyInterval(4),334);assert.equal(replyInterval(14),1167);
 for(let n=1;n<=15;n++)assert.ok(n*60000/replyInterval(n)+180<=900);
});
test('shared Fx slots stagger workers, bound the queue, and recover after idle',async()=>{
 const{a,b,dbA,dbB}=setup();
 const delays=await Promise.all(Array.from({length:20},(_,i)=>reserveFxSlot(i%2?dbA:dbB,1000)));
 assert.equal(new Set(delays).size,20);assert.deepEqual([...delays].sort((x,y)=>x-y),Array.from({length:20},(_,i)=>i*67));
 for(let i=20;i<30;i++)await reserveFxSlot(dbA,1000);
 await assert.rejects(reserveFxSlot(dbB,1000),/예산/);
 assert.equal(await reserveFxSlot(dbB,10000),0);a.close();b.close();
});

test('ended rooms return stored chat without acquiring a reply lease or fetching Fx',async()=>{
 const{a,b,dbA}=setup();
 const put=(key,payload)=>a.prepare('INSERT INTO collector_entries (key,payload,next_poll_at) VALUES (?,?,?)').run(key,JSON.stringify(payload),Date.now()+60000);
 put('resolve:post:123',{id:'1EndedSpace'});put('space:1EndedSpace',{state:'Ended'});put('replies:fxtwitter:123',{messages:[{id:'reply'}]});
 const response=await worker.fetch(new Request('https://test/api/replies?id=123'),{DB:dbA});const data=await response.json();
 assert.equal(data.stopped,true);assert.equal(data.messages[0].id,'reply');assert.equal(a.prepare("SELECT fetch_count FROM collector_entries WHERE key='replies:fxtwitter:123'").get().fetch_count,0);
 a.close();b.close();
});

test('reply cadence starts at request time without adding response time',async()=>{
 const{a,b,dbA}=setup();let now=1000;
 await sharedCollect(dbA,'cadence',100,async()=>{now=1500;return{messages:[]};},{clock:()=>now,startCadence:true});
 assert.equal(a.prepare("SELECT next_poll_at FROM collector_entries WHERE key='cadence'").get().next_poll_at,1100);
 a.close();b.close();
});

test('one visitor collects every live room once across workers and isolates failures',async()=>{
 const{a,b,dbA,dbB}=setup(),now=Date.now();
 const put=(key,payload)=>a.prepare('INSERT INTO collector_entries (key,payload,last_started_at,next_poll_at) VALUES (?,?,?,?)').run(key,JSON.stringify(payload),now,now+60000);
 for(const[handle,id,state]of [['one','111','Running'],['two','222','Running'],['ended','333','Ended']]){
  put('member:v2:'+handle,{handle,status:'live',space:'room'+id,postUrl:'https://x.com/i/status/'+id});put('space:room'+id,{state});
 }
 put('member:v2:offline',{handle:'offline',status:'offline',space:'room444',postUrl:'https://x.com/i/status/444'});
 const original=globalThis.fetch,calls=[];let release;const gate=new Promise(r=>release=r);
 globalThis.fetch=async url=>{calls.push(String(url));await gate;if(String(url).includes('/222?'))throw Error('room two unavailable');return Response.json({code:200,replies:[{id:'reply',type:'status',replying_to:{status:'111'},text:'new reply'}]});};
 try{
  const winner=collectLiveRooms(dbA);await new Promise(r=>setTimeout(r,100));
  const second=await collectLiveRooms(dbB);assert.equal(second.collecting,true);
  release();const result=await winner;assert.equal(result.rooms.length,3);assert.equal(result.rooms.find(r=>r.handle==='ended').stopped,true);assert.match(result.rooms.find(r=>r.handle==='two').error,/unavailable/);
  assert.equal(calls.length,2);assert.ok(calls.every(url=>!url.includes('333')&&!url.includes('444')));
  const stored=JSON.parse(a.prepare("SELECT payload FROM collector_entries WHERE key='replies:fxtwitter:111'").get().payload);assert.equal(stored.messages[0].id,'reply');
 }finally{release();globalThis.fetch=original;a.close();b.close();}
});
