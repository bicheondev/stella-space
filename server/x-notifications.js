import {ClientTransaction,fetchXDocument} from 'x-client-transaction-id';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {encryptToken,decryptToken} from './visitor-analytics.js';
import {memberHandles,ingestNotificationPosts} from '../worker/index.js';
export const X_BEARER='AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
export function xHeaders(session){return{authorization:'Bearer '+X_BEARER,cookie:`auth_token=${session.auth_token}; ct0=${session.ct0}`,'x-csrf-token':session.ct0,'x-twitter-auth-type':'OAuth2Session','x-twitter-active-user':'yes','user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36','x-twitter-client-language':'en',accept:'*/*','content-type':'application/json',origin:'https://x.com',referer:'https://x.com/'};}
let transactionPromise,transactionAt=0;
export async function signedXHeaders(session,method,path){
 if(!transactionPromise||Date.now()-transactionAt>3600000){transactionAt=Date.now();transactionPromise=(async()=>ClientTransaction.create(await fetchXDocument()))().catch(()=>{transactionPromise=null;throw Error('X 웹 요청 서명을 준비하지 못했습니다.');});}
 const transaction=await transactionPromise;return{...xHeaders(session),'x-client-transaction-id':await transaction.generateTransactionId(method,path)};
}
export function validateXSession(body){for(const key of ['auth_token','ct0'])if(typeof body?.[key]!=='string'||! /^[a-zA-Z0-9%_-]{16,1024}$/.test(body[key]))throw Error('X 로그인 세션 형식을 확인해 주세요.');return{auth_token:body.auth_token,ct0:body.ct0};}
export async function saveXSession(db,body,{fetcher=fetch,headerBuilder=fetcher===fetch?signedXHeaders:async session=>xHeaders(session)}={}){
 const session=validateXSession(body);const r=await fetcher('https://api.x.com/1.1/account/verify_credentials.json?skip_status=true&include_email=false',{headers:await headerBuilder(session,'GET','/1.1/account/verify_credentials.json'),redirect:'error',signal:AbortSignal.timeout(15000)});
 let user;
 if(r.status===404){const fallback=await fetcher('https://api.x.com/1.1/account/settings.json',{headers:await headerBuilder(session,'GET','/1.1/account/settings.json'),redirect:'error',signal:AbortSignal.timeout(15000)});if(!fallback.ok)throw Error('X 봇 인증 확인 실패 ('+fallback.status+')');const settings=await fallback.json();user={id_str:/^\d{1,25}$/.test(body.userId||'')?body.userId:'',screen_name:settings.screen_name};}
 else{if(!r.ok)throw Error('X 봇 인증 확인 실패 ('+r.status+')');user=await r.json();}
 if(!/^\d+$/.test(user.id_str||'')||!/^\w{1,15}$/.test(user.screen_name||''))throw Error('X 봇 계정을 확인하지 못했습니다.');
 if(body.expectedHandle&&user.screen_name.toLowerCase()!==body.expectedHandle.toLowerCase())throw Error('지정한 봇 계정과 로그인 계정이 다릅니다.');
 const value={...session,userId:user.id_str,handle:user.screen_name,connectedAt:Date.now()};
 await db.prepare(`INSERT INTO operations_settings(key,value) VALUES('x_notification_config',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value RETURNING key`).bind(encryptToken(JSON.stringify(value))).first();await db.prepare("DELETE FROM operations_settings WHERE key='x_follow_setup' RETURNING key").bind().first();return{handle:value.handle};
}
export async function notificationConfig(db){const row=await db.prepare(`SELECT value FROM operations_settings WHERE key='x_notification_config'`).bind().first();if(!row)return null;const follow=await db.prepare("SELECT value FROM operations_settings WHERE key='x_follow_setup'").bind().first();return{...JSON.parse(decryptToken(row.value)),followSetup:follow?JSON.parse(follow.value):null};}
export async function notificationStatus(db){const config=await notificationConfig(db),rows=await db.prepare(`SELECT payload FROM collector_entries WHERE key='x-notifications' OR key LIKE 'x-notifications:%' ORDER BY json_extract(payload,'$.checkedAtMs') DESC LIMIT 20`).bind().all();const states=rows.results.map(r=>{try{return JSON.parse(r.payload)}catch{return{}}});const healthy=s=>['push','polling'].includes(s.mode)&&Date.now()-Number(s.lastScanAt||0)<45000;const state=states.find(healthy)||states[0]||{};return{configured:!!config,handle:config?.handle||null,...state,followSetup:config?.followSetup||state.followSetup||null,healthy:healthy(state)};}

export function collectorAuthorized(header=''){const secret=process.env.COLLECTOR_SECRET?.trim();if(!secret)return false;const h=v=>createHmac('sha256',secret).update(v).digest();return timingSafeEqual(h(header),h('Bearer '+secret));}
export async function receiveNotificationEvent(db,body){
 const mode=['push','polling','connecting','error','stopped'].includes(body?.mode)?body.mode:'error';
 const count=await ingestNotificationPosts(db,Array.isArray(body?.posts)?body.posts.slice(0,100):[]);
 const value={mode,checkedAtMs:Date.now(),checkedAt:new Date().toISOString(),lastPushAt:typeof body.lastPushAt==='number'?body.lastPushAt:null,lastScanAt:typeof body.lastScanAt==='number'?body.lastScanAt:null,postsReceived:count,error:typeof body.error==='string'?body.error.slice(0,120):null,source:'x-notifications'};
 if(body?.followSetup){const f=body.followSetup;value.followSetup={enabled:memberHandles.filter(h=>f.enabled?.includes(h)),pending:memberHandles.filter(h=>!f.enabled?.includes(h)),retryAt:Number.isFinite(f.retryAt)?f.retryAt:0,checkedAt:Number.isFinite(f.checkedAt)?Math.min(f.checkedAt,Date.now()):Date.now()};await db.prepare("INSERT INTO operations_settings(key,value) VALUES('x_follow_setup',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(excluded.value,'$.checkedAt')>=json_extract(operations_settings.value,'$.checkedAt') RETURNING key").bind(JSON.stringify(value.followSetup)).first();}
 const key=/^[a-f0-9-]{36}$/.test(body?.runId||'')?'x-notifications:'+body.runId:'x-notifications';
 await db.prepare(`INSERT INTO collector_entries(key,payload,next_poll_at) VALUES(?1,?2,0) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,last_error=excluded.last_error RETURNING key`).bind(key,JSON.stringify(value)).first();
 await db.prepare(`DELETE FROM collector_entries WHERE key LIKE 'x-notifications:%' AND json_extract(payload,'$.checkedAtMs')<?1 RETURNING key`).bind(Date.now()-86400000).all();return{ok:true,accepted:count};
}
