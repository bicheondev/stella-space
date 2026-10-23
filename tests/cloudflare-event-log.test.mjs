import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEventLog} from '../cloudflare/event-log.js';
function store(){const rows=[];return{rows,transactionSync(fn){return fn()},sql:{exec(query,...args){if(query.startsWith('INSERT'))rows.push({id:rows.length+1,at:args[0],kind:args[1],payload:args[2]});if(query.startsWith('SELECT'))return rows.filter(r=>r.id>args[0]).slice(0,500);return[];}}};}
test('critical events persist before a restart; secrets and raw notification data never enter the trail',()=>{
 const storage=store(),log=createEventLog(storage,{now:()=>12345});
 log.record('push.received',{count:1,cookie:'SECRET',token:'SECRET',body:'SECRET',handle:'ShirayukiHina_'});
 assert.equal(storage.rows.length,1);assert.ok(!storage.rows[0].payload.includes('SECRET'));
 const restored=createEventLog(storage).read();assert.equal(restored.events[0].at,12345);assert.equal(restored.events[0].payload.handle,'ShirayukiHina_');
});
test('routine scan logs batch until flush and cursors page without returning older rows',()=>{
 const storage=store(),log=createEventLog(storage);
 log.record('inbox.scanned',{count:0});log.record('inbox.scanned',{count:2});assert.equal(storage.rows.length,0);
 log.flush();assert.equal(storage.rows.length,2);assert.deepEqual(log.read(1).events.map(e=>e.id),[2]);
});
