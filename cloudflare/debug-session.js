import worker from '../worker/index.js';
import {createCollector} from './collector.js';
const tables=['collector_entries','broadcast_sessions','broadcast_messages','collector_errors'];
const rename=sql=>sql.replace(/\b(collector_entries|broadcast_sessions|broadcast_messages|collector_errors)\b/g,name=>'debug_'+name);
// Shares the production scheduler and egress, never its archive or notifications.
export function createDebugSession({sql,fetcher,replyFetcher,production,notificationHealth,now=Date.now,resolveWorker=worker.fetch}){
 let db,collector,selected=null,expiresAt=0,serial=Promise.resolve();
 function ensure(){if(db)return;sql.exec(rename(`CREATE TABLE IF NOT EXISTS collector_entries(key TEXT PRIMARY KEY,payload TEXT,next_poll_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT NOT NULL DEFAULT '',last_started_at INTEGER NOT NULL DEFAULT 0,fetch_count INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0,last_error TEXT);CREATE TABLE IF NOT EXISTS broadcast_sessions(handle TEXT PRIMARY KEY,post_id TEXT,space_id TEXT,started_at INTEGER,payload TEXT);CREATE TABLE IF NOT EXISTS broadcast_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,post_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(post_id,id));CREATE TABLE IF NOT EXISTS collector_errors(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,key TEXT,error TEXT);`));sql.exec('CREATE INDEX IF NOT EXISTS debug_message_post_seq ON debug_broadcast_messages(post_id,seq)');db={maxBatchRows:30,prepare:query=>({bind:(...args)=>({first:async()=>[...sql.exec(rename(query),...args)][0]||null,all:async()=>({results:[...sql.exec(rename(query),...args)]})})})};}
 async function stop(){collector?.stop();await collector?.settled();collector=null;selected=null;expiresAt=0;if(db)for(const table of tables)sql.exec('DELETE FROM debug_'+table);}
 async function route(request){
  const url=new URL(request.url),action=url.pathname.split('/').at(-1);
  if(action==='stop'){await stop();return Response.json({ok:true});}
  if(!['resolve','replies','chat-history'].includes(action))return Response.json({error:'Not found'},{status:404});
  if(action==='resolve'){
   await stop();const input=url.searchParams.get('url');
   try{const resolved=await production.resolve(input);selected={...resolved,production:true};expiresAt=now()+900000;return Response.json({...resolved,execution:'production',debugOnly:false});}catch(e){if(e.code!=='UNTRACKED_SPACE')throw e;}
   ensure();const target=new URL('/api/resolve','https://debug.invalid');target.searchParams.set('url',input||'');
   const response=await resolveWorker(new Request(target),{DB:db,DEBUG_ONLY:true});if(!response.ok)return response;
   const resolved=await response.json();if(!resolved.tweet||!resolved.handle)return Response.json({error:'채팅 공유 게시물을 확인하지 못했습니다.'},{status:422});
   const state={handle:resolved.handle,space:resolved.id,postUrl:'https://x.com/'+resolved.handle+'/status/'+resolved.tweet,state:resolved.state,status:resolved.state==='Running'?'live':'offline',authoritative:true,avatar:resolved.avatar,title:resolved.title};
   await db.prepare('INSERT INTO broadcast_sessions(handle,post_id,space_id,started_at,payload) VALUES(?1,?2,?3,?4,?5)').bind(resolved.handle,resolved.tweet,resolved.id,Number(resolved.startedAt)||0,JSON.stringify(state)).first();
   collector=createCollector({db,fetcher,replyFetcher,now,handles:[resolved.handle],notificationHealth});await collector.initialize();selected={...resolved,production:false};expiresAt=now()+900000;collector.step();
   return Response.json({...resolved,execution:'production',debugOnly:true});
  }
  if(!selected||now()>=expiresAt)return Response.json({error:'테스트 연결이 만료되었습니다. URL을 다시 연결해 주세요.'},{status:410});
  if(url.searchParams.get('id')!==String(selected.tweet))return Response.json({error:'연결된 테스트 게시물이 아닙니다.'},{status:400});
  const source=selected.production?production:collector;
  const options=action==='chat-history'?{before:Number(url.searchParams.get('before'))||0}:{after:Number(url.searchParams.get('after'))||0,latest:url.searchParams.get('latest')==='1'};
  const body=await source.room(selected.tweet,options);if(!selected.production)sql.exec('DELETE FROM debug_broadcast_messages WHERE seq NOT IN (SELECT seq FROM debug_broadcast_messages ORDER BY seq DESC LIMIT 5000)');return Response.json({...body,execution:'production',debugOnly:!selected.production,pollIntervalMs:body.stopped?null:Math.max(1000,body.pollIntervalMs||1000)});
 }
 return{fetch(request){const task=serial.catch(()=>{}).then(()=>route(request));serial=task;return task;},step(){if(!selected)return 1000;if(now()>=expiresAt){void this.fetch(new Request('https://debug.invalid/stop'));return 1000;}return collector?.step()??1000;},stop,async settled(){await collector?.settled();}};
}
