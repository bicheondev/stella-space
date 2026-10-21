import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sharedCollect,findSpacePost} from '../worker/index.js';
const migration=readFileSync(new URL('../drizzle/0000_windy_bushwacker.sql',import.meta.url),'utf8');
function binding(sqlite){
 return {
  prepare(sql){
   return {
    bind(...args){
     return {async first(){return sqlite.prepare(sql).get(...args)||null;}};
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
