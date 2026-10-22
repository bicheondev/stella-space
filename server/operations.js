import {webPushControl,saveXSession,notificationStatus,notificationConfig,collectorAuthorized,receiveNotificationEvent} from './x-notifications.js';
import {gaAnalytics,saveGaConfig} from './ga-analytics.js';
import {readFileSync} from 'node:fs';
import {visitorAnalytics,saveAnalyticsToken} from './visitor-analytics.js';
const page=readFileSync(new URL('./operations.html',import.meta.url),'utf8');
import {createHmac,timingSafeEqual} from 'node:crypto';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const hash=v=>createHmac('sha256',process.env.OPERATIONS_SECRET||'disabled').update(v).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export function authorized(cookie=''){return !!process.env.OPERATIONS_SECRET&&equal(cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('ops='))?.slice(4)||'',hash('admin'));}
export async function operations(req,url,db){
 const secret=process.env.OPERATIONS_SECRET?.trim();
 if(secret&&url.pathname==='/ops-'+secret){return new Response(page,{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','Set-Cookie':`ops=${hash('admin')}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`}});}
 if(url.pathname==='/api/visit')return json({error:'Removed'},410);
 if(url.pathname==='/api/admin/errors'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  if(req.method!=='DELETE')return json({},405);
  if(req.headers.origin!==url.origin)return json({},403);
  let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body}catch{return json({error:'삭제 범위를 확인해 주세요.'},400)}
  const through=body?.through;if(!Number.isSafeInteger(through)||through<1)return json({error:'삭제 범위를 확인해 주세요.'},400);
  const rows=await db.prepare('DELETE FROM collector_errors WHERE id<=?1 RETURNING id').bind(through).all();return json({ok:true,deleted:rows.results.length,through});
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
 if(url.pathname==='/api/admin/overview'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  const queries={collectors:[`SELECT key,payload,next_poll_at,lease_until,last_started_at,fetch_count,failure_count,last_error FROM collector_entries WHERE key NOT LIKE 'budget:%'`],sessions:[`SELECT s.handle,s.post_id,s.space_id,s.started_at,s.payload,COUNT(m.id) messages FROM broadcast_sessions s LEFT JOIN broadcast_messages m ON m.post_id=s.post_id GROUP BY s.handle`],errors:[`SELECT * FROM collector_errors ORDER BY id DESC LIMIT 100`]};
  const out={now:Date.now(),timezone:'Asia/Seoul'};
  await Promise.all(Object.entries(queries).map(async([name,[sql,...args]])=>{out[name]=(await db.prepare(sql).bind(...args).all()).results.map(r=>{if(!r.payload)return r;let p={};try{p=JSON.parse(r.payload)}catch{}const {payload,...rest}=r;return {...rest,status:p.status,state:p.state,checkedAt:p.checkedAt,source:p.discoverySource||p.source,warning:p.discoveryWarning||p.warning,title:p.title,space:p.space,avatar:p.avatar,handle:p.handle||r.handle,messages:p.messages?.length??r.messages,rooms:p.rooms,collecting:p.collecting,stopped:p.stopped,pollIntervalMs:p.pollIntervalMs};});}));
  return json(out);
 }
 return null;
}
