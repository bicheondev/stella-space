import {waitUntil} from '@vercel/functions';
import worker from '../worker/index.js';
import {database} from '../server/database.js';
export const config={maxDuration:60};
export default async function handler(req,res){
 const url=new URL(req.url,'https://stella-space-khaki.vercel.app');
 try{
  let result;
  if(url.pathname==='/api/heartbeat'){
   if(!process.env.COLLECTOR_SECRET||req.headers.authorization!=='Bearer '+process.env.COLLECTOR_SECRET.trim()){res.statusCode=401;res.end('Unauthorized');return;}
   const env={DB:database()},ctx={waitUntil};
   await worker.fetch(new Request('https://stella-space-khaki.vercel.app/api/members'),env,ctx);
   result=await worker.fetch(new Request('https://stella-space-khaki.vercel.app/api/collect-live'),env,ctx);
  }else result=await worker.fetch(new Request(url),url.pathname.startsWith('/api/')?{DB:database()}:{},{waitUntil});
  res.statusCode=result.status;for(const[k,v]of result.headers)res.setHeader(k,v);res.end(await result.text());
 }catch(e){res.statusCode=503;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({error:e.message}));}
}
