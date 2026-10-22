import {waitUntil} from '@vercel/functions';
import {googleAnalyticsTag} from '../server/google-analytics.js';
import worker from '../worker/index.js';
import {operations} from '../server/operations.js';
import {database} from '../server/database.js';
export const config={maxDuration:60};
export default async function handler(req,res){
 const url=new URL(req.url,'https://stellive-space.vercel.app');
 try{
  let result=await operations(req,url,(url.pathname.startsWith('/api/')?database():null));
  if(result){res.statusCode=result.status;for(const[k,v]of result.headers)res.setHeader(k,v);res.end(await result.text());return;}
  if(url.pathname==='/api/heartbeat'){
   if(!process.env.COLLECTOR_SECRET||req.headers.authorization!=='Bearer '+process.env.COLLECTOR_SECRET.trim()){res.statusCode=401;res.end('Unauthorized');return;}
   const env={DB:database()},ctx={waitUntil};
   await worker.fetch(new Request('https://stellive-space.vercel.app/api/members'),env,ctx);
   result=await worker.fetch(new Request('https://stellive-space.vercel.app/api/collect-live'),env,ctx);
  }else result=await worker.fetch(new Request(url),url.pathname.startsWith('/api/')?{DB:database()}:{},{waitUntil});
  res.statusCode=result.status;for(const[k,v]of result.headers)res.setHeader(k,v);let body=await result.text();if(result.headers.get('content-type')?.includes('text/html'))body=body.replace('</html>',googleAnalyticsTag+'<script src="/analytics.js" defer></script></html>');res.end(body);
 }catch(e){res.statusCode=503;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({error:e.message}));}
}
