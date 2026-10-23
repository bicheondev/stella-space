import {waitUntil} from '@vercel/functions';
import {googleAnalyticsTag} from '../server/google-analytics.js';
import worker from '../worker/index.js';
import {operations} from '../server/operations.js';
import {database} from '../server/database.js';
export const config={maxDuration:60};
const publicRealtimeRoutes=new Set(['/api/members','/api/member','/api/resolve','/api/replies','/api/chat-history']);
export function normalizeRealtimeOrigin(value=''){
 if(!String(value).trim())return '';
 let url;try{url=new URL(String(value).trim());}catch{throw Error('SPACELIVE_REALTIME_ORIGIN must be an HTTPS origin');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('SPACELIVE_REALTIME_ORIGIN must be an HTTPS origin');
 return url.origin;
}
export function publicPage(html,origin=''){
 const normalized=normalizeRealtimeOrigin(origin);
 return html.replace("const realtimeOrigin='';",()=> 'const realtimeOrigin='+JSON.stringify(normalized).replace(/</g,'\\u003c')+';').replace('</html>',googleAnalyticsTag+'<script src="/analytics.js" defer></script></html>');
}
async function sendResponse(res,response){res.statusCode=response.status;for(const[k,v]of response.headers)if(k!=='set-cookie')res.setHeader(k,v);const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);res.end(await response.text());}
export function createHandler({getDatabase=database,handleOperations=operations,fetchWorker=worker.fetch,environment=process.env,background=waitUntil}={}){
 return async function handler(req,res){
  const url=new URL(req.url,'https://spacelive.vercel.app');
  try{
   const origin=normalizeRealtimeOrigin(environment.SPACELIVE_REALTIME_ORIGIN),method=req.method||'GET';
   // Redirect before opening the database: older tabs must not run another collector.
   if(origin&&publicRealtimeRoutes.has(url.pathname)){
    if(method!=='GET'&&method!=='HEAD')return sendResponse(res,new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}}));
    return sendResponse(res,new Response(null,{status:307,headers:{Location:new URL(url.pathname+url.search,origin).href,'Cache-Control':'no-store'}}));
   }
   if(url.pathname==='/api/heartbeat'&&(!environment.COLLECTOR_SECRET||req.headers.authorization!=='Bearer '+environment.COLLECTOR_SECRET.trim()))return sendResponse(res,new Response('Unauthorized',{status:401}));
   if(origin&&(url.pathname==='/api/collect-live'||url.pathname==='/api/heartbeat'))return sendResponse(res,Response.json({migrated:true,liveCount:0,rooms:[],pollIntervalMs:60000},{headers:{'Cache-Control':'no-store'}}));
   const operation=await handleOperations(req,url,url.pathname.startsWith('/api/')?getDatabase():null);
   if(operation)return sendResponse(res,operation);
   let result;
   if(url.pathname==='/api/heartbeat'){
    const env={DB:getDatabase()},ctx={waitUntil:background};
    await fetchWorker(new Request('https://spacelive.vercel.app/api/members'),env,ctx);
    result=await fetchWorker(new Request('https://spacelive.vercel.app/api/collect-live'),env,ctx);
   }else result=await fetchWorker(new Request(url),{DB:getDatabase()},{waitUntil:background});
   if(result.headers.get('content-type')?.includes('text/html'))result=new Response(publicPage(await result.text(),origin),{status:result.status,headers:result.headers});
   return sendResponse(res,result);
  }catch(e){res.statusCode=503;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({error:e.message}));}
 };
}
export default createHandler();
