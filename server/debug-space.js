import {createClient} from '@libsql/client';
import {readFileSync} from 'node:fs';
import worker from '../worker/index.js';

// Debug URLs must never share production sessions, archives, leases or provider budgets.
export async function createDebugDatabase(){
 const client=createClient({url:':memory:'});
 await client.executeMultiple(readFileSync(new URL('../drizzle/0000_windy_bushwacker.sql',import.meta.url),'utf8'));
 await client.executeMultiple(readFileSync(new URL('./session-schema.sql',import.meta.url),'utf8'));
 return{prepare(sql){return{bind(...args){return{async first(){return(await client.execute({sql,args})).rows[0]||null;},async all(){return{results:(await client.execute({sql,args})).rows};}};}};},close(){client.close();}};
}
export function createDebugSpaceService({makeDatabase=createDebugDatabase,fetchWorker=worker.fetch,now=Date.now}={}){
 let database,queue=Promise.resolve(),resetAt=0;
 return function debugSpace(request){
  const task=queue.catch(()=>{}).then(async()=>{
   const url=new URL(request.url),route=url.pathname.split('/').at(-1);
   if(!['resolve','replies','chat-history'].includes(route))return Response.json({error:'지원하지 않는 테스트 요청입니다.'},{status:404});
   if(request.method!=='GET')return new Response(null,{status:405,headers:{Allow:'GET'}});
   database||=makeDatabase();const db=await database;
   const size=await db.prepare('SELECT COUNT(*) AS count FROM collector_entries').bind().first();
   if(now()>=resetAt||Number(size?.count)>128){
    await db.prepare("DELETE FROM collector_entries WHERE key NOT LIKE 'budget:%' RETURNING key").bind().all();
    await db.prepare('DELETE FROM broadcast_messages RETURNING id').bind().all();resetAt=now()+30*60*1000;
   }
   const target=new URL('/api/'+route,'https://debug.invalid');target.search=url.search;
   // Every response is a snapshot. Browser-side IDs preserve continuity across cold starts.
   if(route==='replies'){target.searchParams.set('after','0');target.searchParams.set('latest','1');}
   const response=await fetchWorker(new Request(target),{DB:db,DEBUG_ONLY:true});
   const body=await response.json();
   if(response.ok&&route==='replies'){
    body.debugOnly=true;body.hasOlder=false;body.hasMore=false;body.pollIntervalMs=2000;
    await db.prepare('DELETE FROM broadcast_messages WHERE seq NOT IN (SELECT seq FROM broadcast_messages ORDER BY seq DESC LIMIT 5000) RETURNING id').bind().all();
   }
   if(!response.ok){
    const limited=/429|조회 제한|재시도 시각/.test(body.error||'');
    return Response.json({...body,code:limited?'PROVIDER_RATE_LIMIT':'DEBUG_LOOKUP_FAILED'},{status:limited?429:response.status,headers:{'Cache-Control':'no-store',...(limited?{'Retry-After':'30'}:{})}});
   }
   return Response.json(body,{headers:{'Cache-Control':'no-store'}});
  });
  queue=task;return task;
 };
}
export const debugSpace=createDebugSpaceService();
