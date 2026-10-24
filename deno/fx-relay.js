import {createHash,timingSafeEqual} from 'node:crypto';
import process from 'node:process';
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
// This service has no database, push subscription or Discord credentials.
export function createDenoFxRelay({secret,fetcher=fetch,now=Date.now}={}){
 const pending=new Map();
 return async request=>{
  const url=new URL(request.url),json=(value,status)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/health')return json({ok:true,service:'spacelive-fx-relay'},200);
  if(!secret||!equal(request.headers.get('authorization')||'','Bearer '+secret.trim()))return json({},404);
  const id=url.searchParams.get('id');
  if(request.method!=='GET'||url.pathname!=='/api/internal/fx-query'||!/^\d{2,20}$/.test(id||''))return json({error:'Invalid query'},400);
  if(!pending.has(id)){
   if(pending.size>=20)return new Response(null,{status:503,headers:{'Retry-After':'2','Cache-Control':'no-store'}});
   const task=(async()=>{
    const start=now(),cpu=process.cpuUsage();
    try{
     const upstream=await fetcher('https://api.fxtwitter.com/2/conversation/'+id+'?ranking_mode=recency',{
      redirect:'manual',headers:{'user-agent':'Spacelive/1.0 (+https://spacelive.vercel.app)'},signal:AbortSignal.timeout(10000)});
     if(upstream.status>=300&&upstream.status<400)return {body:new Uint8Array(),status:502,headers:{'Cache-Control':'no-store'}};
     const reader=upstream.body?.getReader(),chunks=[];let length=0;
     if(reader)for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2*1024*1024){await reader.cancel();throw Error('Response too large');}chunks.push(value);}
     const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
     // Preserve every upstream byte/field; compress the relay hop to reduce egress.
     const body=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
     const used=process.cpuUsage(cpu),headers={'Content-Type':upstream.headers.get('content-type')||'application/json','Content-Encoding':'gzip','Vary':'Accept-Encoding','Cache-Control':'no-store','X-Spacelive-Execution':'deno','X-Spacelive-Cpu-Ms':String((used.user+used.system)/1000),'X-Spacelive-Wall-Ms':String(now()-start),'X-Spacelive-Payload-Bytes':String(length),'X-Spacelive-Gzip-Bytes':String(body.length)};
     for(const name of ['retry-after','x-rate-limit-reset'])if(upstream.headers.has(name))headers[name]=upstream.headers.get(name);
     return {body,status:upstream.status,headers};
    }catch{return {body:JSON.stringify({code:502,error:'External query failed'}),status:502,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}};}
   })().finally(()=>pending.delete(id));pending.set(id,task);
  }
  const value=await pending.get(id);return new Response(value.body,{status:value.status,headers:value.headers});
 };
}
