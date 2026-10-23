import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOverviewReader} from '../server/overview.js';
function db(){const queries=[];return{queries,prepare(sql){queries.push(sql);return{bind(){return{all:async()=>({results:sql.includes('COUNT(*)')?[{post_id:'123',messages:42}]:sql.includes('FROM broadcast_sessions')?[{handle:'test',post_id:'123',payload:'{"status":"offline"}'}]:[]})}}}}};}
test('concurrent console refreshes share work and reuse one count for archives and sessions',async()=>{
 let now=100000;const read=createOverviewReader({now:()=>now}),store=db();
 const results=await Promise.all(Array.from({length:10},()=>read(store)));assert.equal(store.queries.length,4);assert.equal(results[0].sessions[0].messages,42);assert.equal(results[0].archives[0].messages,42);
 now+=2000;await read(store);assert.equal(store.queries.length,7);assert.equal(store.queries.filter(q=>q.includes('COUNT(*)')).length,1);
 now+=10000;await read(store);assert.equal(store.queries.filter(q=>q.includes('COUNT(*)')).length,2);
 read.invalidate();await read(store);assert.equal(store.queries.filter(q=>q.includes('COUNT(*)')).length,3);
});
test('failed reads do not remain cached',async()=>{
 const read=createOverviewReader();let fail=true;const store=db(),prepare=store.prepare;store.prepare=sql=>{if(fail&&sql.includes('collector_entries'))throw Error('temporary');return prepare(sql)};
 await assert.rejects(read(store),/temporary/);fail=false;assert.equal((await read(store)).sessions[0].messages,42);
});
