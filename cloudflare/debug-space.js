import {DurableObject} from 'cloudflare:workers';
import worker from '../worker/index.js';

// Separate object, schema and lifetime: no production collector, push receiver or Turso access.
export class SpaceliveDebug extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.db={maxBatchRows:30,prepare:sql=>({bind:(...args)=>({first:async()=>[...ctx.storage.sql.exec(sql,...args)][0]||null,all:async()=>({results:[...ctx.storage.sql.exec(sql,...args)]})})})};
 ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS collector_entries(key TEXT PRIMARY KEY,payload TEXT,next_poll_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT NOT NULL DEFAULT '',last_started_at INTEGER NOT NULL DEFAULT 0,fetch_count INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0,last_error TEXT);
 CREATE TABLE IF NOT EXISTS broadcast_sessions(handle TEXT PRIMARY KEY,post_id TEXT,space_id TEXT,started_at INTEGER,payload TEXT);
 CREATE TABLE IF NOT EXISTS broadcast_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,post_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(post_id,id));
 CREATE INDEX IF NOT EXISTS debug_messages_post_seq ON broadcast_messages(post_id,seq);
 CREATE TABLE IF NOT EXISTS collector_errors(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,key TEXT,error TEXT);`);
 }
 async fetch(request){
  const url=new URL(request.url);if(!['/api/resolve','/api/replies','/api/chat-history'].includes(url.pathname))return new Response('Not found',{status:404});
  await this.ctx.storage.setAlarm(Date.now()+15*60*1000);
  if(url.pathname==='/api/replies'){url.searchParams.set('after','0');url.searchParams.set('latest','1');}
  const response=await worker.fetch(new Request(url),{DB:this.db,DEBUG_ONLY:true});const body=await response.json();
  this.ctx.storage.sql.exec('DELETE FROM broadcast_messages WHERE seq NOT IN (SELECT seq FROM broadcast_messages ORDER BY seq DESC LIMIT 5000)');
  const limited=!response.ok&&/429|조회 제한|재시도 시각/.test(body.error||'');
  return Response.json({...body,debugOnly:true,execution:'cloudflare',hasOlder:false,hasMore:false,pollIntervalMs:2000},{status:limited?429:response.status,headers:{'Cache-Control':'no-store',...(limited?{'Retry-After':'30'}:{})}});
 }
 async alarm(){for(const table of ['broadcast_messages','broadcast_sessions','collector_entries','collector_errors'])this.ctx.storage.sql.exec('DELETE FROM '+table);}
}
