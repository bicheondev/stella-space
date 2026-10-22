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
 if(url.pathname==='/api/admin/analytics/connect'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  if(req.method!=='POST')return json({},405);
  if(req.headers.origin!==url.origin)return json({},403);
  try{let body=req.body;if(typeof body==='string')body=JSON.parse(body);await saveAnalyticsToken(db,body?.token?.trim());return json({ok:true});}catch(e){return json({error:e.message},400);}
 }
 if(url.pathname==='/api/admin/analytics'){
  if(!authorized(req.headers.cookie))return json({error:'Not found'},404);
  return json(await visitorAnalytics(db));
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
