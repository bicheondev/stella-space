import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
const projectId='prj_TLbO1f29sNjvpfTNV478OLxPV15k',teamId='team_r1sGFkTKCUD5azzBTEhuqvPW';
const key=()=>createHash('sha256').update(process.env.OPERATIONS_SECRET||'').digest();
export function encryptToken(token){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);return Buffer.concat([iv,cipher.update(token,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');}
export function decryptToken(value){const b=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));decipher.setAuthTag(b.subarray(-16));return Buffer.concat([decipher.update(b.subarray(12,-16)),decipher.final()]).toString('utf8');}
export async function queryAnalytics(token,endpoint,params={},fetcher=fetch){
 const url=new URL('https://api.vercel.com/v1/query/web-analytics/visits/'+endpoint);url.search=new URLSearchParams({projectId,teamId,...params});
 const r=await fetcher(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw Error(r.status===401||r.status===403?'Vercel 통계 조회 권한을 확인해 주세요.':r.status===429?'Vercel 조회 제한으로 잠시 후 재시도합니다.':'Vercel 통계 응답 오류 ('+r.status+')');
 const body=await r.json();if(body.data==null)throw Error('통계 응답 형식을 확인하지 못했습니다.');return body.data;
}
export async function saveAnalyticsToken(db,token){
 if(typeof token!=='string'||token.length<16||token.length>1000)throw Error('유효한 Vercel 토큰을 입력해 주세요.');
 await queryAnalytics(token,'count');
 await db.prepare(`INSERT INTO operations_settings(key,value) VALUES('analytics_token',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value RETURNING key`).bind(encryptToken(token)).first();
 await db.prepare(`DELETE FROM operations_settings WHERE key='analytics_cache' RETURNING key`).bind().first();
}
export async function visitorAnalytics(db,{now=Date.now(),fetcher=fetch}={}){
 const saved=await db.prepare(`SELECT value FROM operations_settings WHERE key='analytics_token'`).bind().first();
 const token=process.env.ANALYTICS_READ_TOKEN?.trim()||(saved?decryptToken(saved.value):null);
 if(!token)return{source:'Vercel Web Analytics',status:'disconnected',message:'Vercel 읽기 토큰을 연결하면 공식 방문 통계를 표시합니다.'};
 let previous;try{const r=await db.prepare(`SELECT value FROM operations_settings WHERE key='analytics_cache'`).bind().first();previous=r?JSON.parse(r.value):null;}catch{}
 const offset=9*3600000,today=new Date(now+offset).toISOString().slice(0,10),midnight=Date.parse(today+'T00:00:00+09:00'),since=new Date(midnight+offset-6*86400000).toISOString().slice(0,10);
 if(previous?.version===3&&previous.until===today&&now-previous.checkedAt<120000)return previous;
 const range={since:new Date(midnight-6*86400000).toISOString(),until:new Date(now).toISOString(),limit:'30'};
 try{
  const [days,countries,referrers,pages]=await Promise.all([
   Promise.all(Array.from({length:7},async(_,i)=>{const start=midnight-(6-i)*86400000,end=Math.min(now,start+86400000-1),rows=await queryAnalytics(token,'aggregate',{by:'environment',since:new Date(start).toISOString(),until:new Date(end).toISOString(),limit:'30'},fetcher),row=rows.find(r=>r.environment==='production')||{};return{timestamp:new Date(start+offset).toISOString().slice(0,10)+'T00:00:00+09:00',visitors:Number(row.visitors||0),pageviews:Number(row.pageviews||0)};})),
   ...['country','referrerHostname','requestPath'].map(by=>queryAnalytics(token,'aggregate',{...range,by},fetcher))]);
  const {visitors,pageviews}=days[6],value={version:3,source:'Vercel Web Analytics',status:'connected',checkedAt:now,timezone:'Asia/Seoul',since,until:today,totals:{visitors,pageviews},daily:days,countries,referrers,pages};
  await db.prepare(`INSERT INTO operations_settings(key,value) VALUES('analytics_cache',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value RETURNING key`).bind(JSON.stringify(value)).first();return value;
 }catch(e){return {...(previous||{}),source:'Vercel Web Analytics',status:previous?'stale':'error',message:e.message};}
}
