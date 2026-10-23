import {createHash,timingSafeEqual} from 'node:crypto';
import {memberHandles} from '../worker/index.js';
import {memberUserIds} from '../worker/member-user-ids.js';
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
// Only the coordinator knows this credential. This route never opens Turso or
// accepts a destination URL, and never retries through another host on failure.
export function createFxRelay({environment=process.env,fetcher=fetch}={}){
 const pending=new Map();
 return async(req,url)=>{
  const secret=environment.CLOUDFLARE_COLLECTOR_SECRET?.trim();
  if(!secret||!equal(req.headers.authorization||'','Bearer '+secret))return new Response('Not found',{status:404});
  if((req.method||'GET')!=='GET')return new Response('Method not allowed',{status:405});
  const kind=url.searchParams.get('kind')||'replies',id=url.searchParams.get('id');let target;
  if(kind==='replies'&&/^\d{2,20}$/.test(id||''))target='https://api.fxtwitter.com/2/conversation/'+id+'?ranking_mode=recency';
  else if(kind==='profile'){
   const handle=memberHandles.find(h=>h.toLowerCase()===String(id).toLowerCase());
   if(handle)target='https://api.fxtwitter.com/2/profile/'+(memberUserIds[handle]&&url.searchParams.get('lookup')!=='handle'?'id:'+memberUserIds[handle]:handle)+'/statuses?count=5';
  }
  if(!target)return Response.json({error:'Invalid query'},{status:400});
  if(!pending.has(target)){
   if(pending.size>=20)return Response.json({error:'Busy'},{status:503,headers:{'Retry-After':'2'}});
   const task=(async()=>{
    const cpu=process.cpuUsage(),start=Date.now();
    try{
     const r=await fetcher(target,{redirect:'manual',headers:{'user-agent':'Spacelive/1.0 (+https://spacelive.vercel.app)'},signal:AbortSignal.timeout(10000)});
     const reader=r.body?.getReader(),chunks=[];let bytes=0;
     if(reader)for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2*1024*1024){await reader.cancel();throw Error('Response too large');}chunks.push(value);}
     const text=Buffer.concat(chunks).toString('utf8');
     const used=process.cpuUsage(cpu),headers={'Content-Type':r.headers.get('content-type')||'application/json','Cache-Control':'no-store','X-Spacelive-Execution':'vercel','X-Spacelive-Cpu-Ms':String((used.user+used.system)/1000),'X-Spacelive-Wall-Ms':String(Date.now()-start)};
     for(const name of ['retry-after','x-rate-limit-reset'])if(r.headers.has(name))headers[name]=r.headers.get(name);
     return {text,status:r.status,headers};
    }catch{return {text:JSON.stringify({code:502,error:'External query failed'}),status:502,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}};}
   })().finally(()=>pending.delete(target));pending.set(target,task);
  }
  const value=await pending.get(target);return new Response(value.text,{status:value.status,headers:value.headers});
 };
}
export const fxRelay=createFxRelay();
