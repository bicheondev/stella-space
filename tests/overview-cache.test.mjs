import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOverviewReader} from '../server/overview.js';
function db(){const queries=[];return{queries,prepare(sql){queries.push(sql);return{bind(){return{all:async()=>({results:sql.includes('FROM broadcast_sessions')?[{handle:'test',post_id:'123',payload:'{"status":"offline"}'}]:[]})}}}}};}
test('console shares status reads and never reads or counts chat rows',async()=>{
 let now=100000;const read=createOverviewReader({now:()=>now}),store=db();
 const results=await Promise.all(Array.from({length:10},()=>read(store)));assert.equal(store.queries.length,3);assert(!('messages' in results[0].sessions[0]));assert(!('archives' in results[0]));
 now+=2000;await read(store);assert.equal(store.queries.length,3);
 now+=10000;await read(store);assert.equal(store.queries.length,6);
 read.invalidate();await read(store);assert.equal(store.queries.length,9);
 assert(!store.queries.some(q=>/broadcast_messages|COUNT\s*\(/i.test(q)));
});
test('failed reads do not remain cached',async()=>{
 const read=createOverviewReader();let fail=true;const store=db(),prepare=store.prepare;store.prepare=sql=>{if(fail&&sql.includes('collector_entries'))throw Error('temporary');return prepare(sql)};
 await assert.rejects(read(store),/temporary/);fail=false;assert.equal((await read(store)).sessions[0].handle,'test');
});
