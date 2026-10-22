import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {database} from '../server/database.js';
import {sharedCollect,collectLiveRooms} from '../worker/index.js';
test('libSQL adapter preserves shared leases, JSON queries and readback',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'stella-libsql-'));process.env.TURSO_DATABASE_URL='file:'+join(folder,'test.db');
 try{const db=database();const first=await sharedCollect(db,'test',1000,async()=>({messages:[{id:'one'}]}));assert.equal(first.messages[0].id,'one');
 const cached=await sharedCollect(db,'test',1000,async()=>{throw Error('duplicate');});assert.equal(cached.messages[0].id,'one');
 const result=await collectLiveRooms(db);assert.equal(result.liveCount,0);assert.deepEqual(result.rooms,[]);
 }finally{delete process.env.TURSO_DATABASE_URL;rmSync(folder,{recursive:true,force:true});}
});
