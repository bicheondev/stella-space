import {readUsage,saveUsage} from './usage.js';
import {readOverview} from './overview.js';
import {receiveFeedback,feedbackAdmin} from './feedback.js';
import {webPushControl,saveXSession,notificationStatus,notificationConfig,collectorAuthorized,receiveNotificationEvent} from './x-notifications.js';
import {gaAnalytics,saveGaConfig} from './ga-analytics.js';
import {readFileSync} from 'node:fs';
import {initialPage,memberHandles} from '../worker/index.js';
import {debugChatScript} from './debug-chat.js';
import {debugSpace} from './debug-space.js';
const debugPage=readFileSync(new URL('./debug.html',import.meta.url),'utf8');
import {visitorAnalytics,saveAnalyticsToken} from './visitor-analytics.js';
const page=readFileSync(new URL('./operations.html',import.meta.url),'utf8');
import{adminAuth,authorized,privateHeaders}from'./admin-auth.js';
export{authorized}from'./admin-auth.js';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export async function operations(req,url,db){
 const auth=await adminAuth(req,url);if(auth)return auth;
 if(url.pathname==='/ops/debug')return new Response(debugPage,{headers:{...privateHeaders,'Content-Type':'text/html;charset=utf-8'}});
 if(url.pathname.startsWith('/api/admin/debug-space/')){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  if(url.pathname.startsWith('/api/admin/debug-space/production/')||url.pathname.startsWith('/api/admin/debug-space/cloudflare/')){
   const route=url.pathname.split('/').at(-1);if(!['resolve','replies','chat-history','stop'].includes(route))return json({},404);
   if((req.method||'GET')!==(route==='stop'?'POST':'GET'))return json({},405);
   if(route==='stop'&&req.headers.origin!==url.origin)return json({},403);
   const secret=process.env.CLOUDFLARE_COLLECTOR_SECRET||process.env.COLLECTOR_SECRET;const origin=process.env.SPACELIVE_REALTIME_ORIGIN;
   if(!secret||!origin)return json({error:'Cloudflare 테스트 연결 설정이 없습니다.'},503);
   const target=new URL('/control/debug/'+route,origin);target.search=url.search;const result=await fetch(target,{method:route==='stop'?'POST':'GET',headers:{Authorization:'Bearer '+secret.trim()},redirect:'error',signal:AbortSignal.timeout(20000)});
   return new Response(await result.text(),{status:result.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...(result.headers.get('retry-after')?{'Retry-After':result.headers.get('retry-after')}:{})}});
  }
  return debugSpace(new Request(url,{method:req.method||'GET'}));
 }
 if(url.pathname==='/api/admin/debug-chat'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  if(req.method!=='GET')return json({},405);
  return new Response((await initialPage(db,'/GANGZIIII')).replace("const realtimeOrigin='';",()=> 'let realtimeOrigin='+JSON.stringify(process.env.SPACELIVE_REALTIME_ORIGIN||'').replace(/</g,'\\u003c')+';').replace('</html>','<script>'+debugChatScript+'</script></html>'),{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'}});
 }
 if(url.pathname==='/ops')return new Response(page.replace('__DEBUG_PATH__','/ops/debug'),{headers:{...privateHeaders,'Content-Type':'text/html;charset=utf-8'}});
 if(url.pathname==='/api/feedback')return receiveFeedback(req,url,db);
 if(url.pathname==='/api/admin/feedback'||url.pathname==='/api/admin/feedback/retry'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  return feedbackAdmin(req,url,db);
 }
 if(url.pathname==='/api/visit')return json({error:'Removed'},410);
 if(url.pathname==='/api/admin/test-chats'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  if(req.method!=='DELETE')return json({},405);
  if(req.headers.origin!==url.origin)return json({},403);
  const rows=(await db.prepare("SELECT payload FROM collector_entries WHERE key LIKE 'resolve:post:%' OR key LIKE 'resolve:space:%'").bind().all()).results;
  const protectedIds=new Set((await db.prepare('SELECT post_id FROM broadcast_sessions').bind().all()).results.map(r=>r.post_id));
  const ids=new Set();for(const row of rows){let p;try{p=JSON.parse(row.payload)}catch{continue}if(p?.handle&&/^\d{2,20}$/.test(p.tweet||'')&&!memberHandles.some(h=>h.toLowerCase()===p.handle.toLowerCase())&&!protectedIds.has(p.tweet))ids.add(p.tweet);}
  let deleted=0;for(const id of ids){deleted+=(await db.prepare('DELETE FROM broadcast_messages WHERE post_id=?1 RETURNING id').bind(id).all()).results.length;await db.prepare('DELETE FROM collector_entries WHERE key=?1 RETURNING key').bind('replies:fxtwitter:'+id).all();}
  readOverview.invalidate();return json({ok:true,deleted,rooms:ids.size});
 }
 if(url.pathname==='/api/admin/errors'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  if(req.method!=='DELETE')return json({},405);
  if(req.headers.origin!==url.origin)return json({},403);
  let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body}catch{return json({error:'삭제 범위를 확인해 주세요.'},400)}
  const through=body?.through;if(!Number.isSafeInteger(through)||through<1)return json({error:'삭제 범위를 확인해 주세요.'},400);
  const rows=await db.prepare('DELETE FROM collector_errors WHERE id<=?1 RETURNING id').bind(through).all();readOverview.invalidate();return json({ok:true,deleted:rows.results.length,through});
 }
 if(url.pathname==='/api/admin/x-notifications'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  if(req.method==='POST'){if(req.headers.origin!==url.origin)return json({},403);try{return json(await saveXSession(db,typeof req.body==='string'?JSON.parse(req.body):req.body))}catch(e){return json({error:e.message},400)}}
  if(req.method!=='GET')return json({},405);return json(await notificationStatus(db));
 }
 if(url.pathname==='/api/notification-push'||url.pathname==='/api/notification-config'||url.pathname==='/api/notification-event'){
  if(!collectorAuthorized(req.headers.authorization))return json({error:'Not found'},404);
  if(url.pathname==='/api/notification-push'){if(req.method!=='POST')return json({},405);try{return json(await webPushControl(db,typeof req.body==='string'?JSON.parse(req.body):req.body))}catch{return json({error:'Push state update failed'},400)}}
  if(url.pathname==='/api/notification-config'){if(req.method!=='GET')return json({},405);return json({config:await notificationConfig(db)});}
  if(req.method!=='POST')return json({},405);
  try{return json(await receiveNotificationEvent(db,typeof req.body==='string'?JSON.parse(req.body):req.body))}catch{return json({error:'알림 처리 실패'},400)}
 }
 if(url.pathname==='/api/admin/analytics/connect'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  if(req.method!=='POST')return json({},405);
  if(req.headers.origin!==url.origin)return json({},403);
  if(!['vercel','ga'].includes(url.searchParams.get('provider')||'vercel'))return json({error:'지원하지 않는 통계 제공자입니다.'},400);
  try{let body=req.body;if(typeof body==='string')body=JSON.parse(body);if(url.searchParams.get('provider')==='ga')await saveGaConfig(db,body?.propertyId,body?.credentials);else await saveAnalyticsToken(db,body?.token?.trim());return json({ok:true});}catch(e){return json({error:e.message},400);}
 }
 if(url.pathname==='/api/admin/analytics'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  const provider=url.searchParams.get('provider')||'vercel';if(!['vercel','ga'].includes(provider))return json({error:'지원하지 않는 통계 제공자입니다.'},400);
  return json(await (provider==='ga'?gaAnalytics(db):visitorAnalytics(db)));
 }
 if(url.pathname==='/api/admin/usage'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  if(req.method==='GET')return json(await readUsage(db));
  if(req.method!=='POST')return json({},405);
  if(req.headers.origin!==url.origin)return json({},403);
  try{return json(await saveUsage(db,typeof req.body==='string'?JSON.parse(req.body):req.body));}catch(e){return json({error:e.message},400);}
 }
 if(url.pathname==='/api/admin/overview'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  return json(await readOverview(db));
 }
 return null;
}
