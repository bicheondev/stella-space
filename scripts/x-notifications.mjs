// Event-driven account notifications, with a slow notification-inbox safety poll.
// Protocol references: DezXBT/x-notify-dc (ws.go, poller.go) and X web live_pipeline.
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {signedXHeaders} from '../server/x-notifications.js';
import {memberHandles} from '../worker/index.js';
const allowed=new Set(memberHandles.map(h=>h.toLowerCase()));
export function notificationPosts(data){
 const objects=data?.globalObjects;if(!objects||typeof objects!=='object'||Array.isArray(objects))throw Error('알림함 응답 형식 오류');
 return Object.entries(objects.tweets||{}).flatMap(([id,t])=>{const u=objects.users?.[t.user_id_str];if(!u||!allowed.has(u.screen_name?.toLowerCase())||t.retweeted_status_id_str||t.retweeted_status)return[];
 let text=t.full_text||t.text;if(typeof text!=='string')return[];for(const link of t.entities?.urls||[])if(link.url&&link.expanded_url)text=text.split(link.url).join(link.expanded_url);
 return[{id:t.id_str||id,text,created_timestamp:(Date.parse(t.created_at)||0)/1000,author:{screen_name:u.screen_name}}];});
}
export function notificationFrame(frame){return typeof frame?.topic==='string'&&/^\/?notification[:/]/.test(frame.topic);}
export async function syncFollowNotifications(session,{targets=memberHandles,fetcher=fetch,headersFor=signedXHeaders,now=Date.now()}={}){
 const previous=session.followSetup;if(previous?.retryAt>now)return previous;
 if(previous?.enabled?.length===targets.length&&targets.every(h=>previous.enabled.includes(h)))return previous;
 const enabled=[];let retryAt=0;
 async function request(path,body){const method=body?'POST':'GET',headers=await headersFor(session,method,path.split('?')[0]);const r=await fetcher('https://api.x.com'+path,{method,headers:{...headers,...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},...(body?{body:new URLSearchParams(body)}:{}),redirect:'error',signal:AbortSignal.timeout(12000)});let data;try{data=await r.json()}catch{}if(!r.ok||data?.errors?.length){const e=Error('X 팔로우·알림 설정 대기');const after=Number(r.headers.get('retry-after')),reset=Number(r.headers.get('x-rate-limit-reset'))*1000;e.retryAt=Math.max(now+300000,after?now+after*1000:0,reset||0);throw e;}return data;}
 for(const handle of targets){try{const status=await request('/1.1/friendships/show.json?target_screen_name='+handle);const source=status?.relationship?.source;if(!source)throw Error('팔로우 상태 확인 실패');if(!source.following)await request('/1.1/friendships/create.json',{screen_name:handle});if(!source.notifications_enabled)await request('/1.1/friendships/update.json',{screen_name:handle,device:'true',all_replies:'false'});const verified=source.following&&source.notifications_enabled?source:(await request('/1.1/friendships/show.json?target_screen_name='+handle))?.relationship?.source;if(verified?.following&&verified?.notifications_enabled)enabled.push(handle);}catch(e){retryAt=e.retryAt||now+300000;break;}}
 return{enabled,pending:targets.filter(h=>!enabled.includes(h)),retryAt,checkedAt:now};
}
export async function watchXNotifications({origin,secret,signal,fetcher=fetch}){
 const runId=randomUUID();const auth={Authorization:'Bearer '+secret};let session,mode='connecting',lastPushAt=null,lastScanAt=null,error=null,streamAbort,scanPending=false,dirty=false,lastPublish=0,nextScanAt=0,subscriptionRejected=false,followSetup=null;const seen=new Set();
 async function site(path,body){const r=await fetcher(origin+path,{method:body?'POST':'GET',headers:{...auth,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});if(!r.ok)throw Error('알림 연결 서버 응답 ('+r.status+')');return r.json();}
 async function publish(posts=[]){await site('/api/notification-event',{runId,mode,lastPushAt,lastScanAt,error,posts,followSetup});lastPublish=Date.now();}
 async function scan(){if(Date.now()<nextScanAt)return;if(scanPending){dirty=true;return;}scanPending=true;try{do{dirty=false;const r=await fetcher('https://api.x.com/2/notifications/device_follow.json?count=40&tweet_mode=extended',{headers:await signedXHeaders(session,'GET','/2/notifications/device_follow.json'),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});if(!r.ok){if(r.status===429){const after=Number(r.headers.get('retry-after')),reset=Number(r.headers.get('x-rate-limit-reset'))*1000;nextScanAt=Math.max(Date.now()+30000,after?Date.now()+after*1000:0,reset||0);}throw Error('X 알림함 조회 실패 ('+r.status+')');}const data=await r.json();if(data.errors?.length)throw Error('X 알림함이 요청을 거절했습니다.');const posts=notificationPosts(data).filter(p=>!seen.has(p.id));lastScanAt=Date.now();await publish(posts);for(const p of posts)seen.add(p.id);if(seen.size>5000){const keep=[...seen].slice(-2000);seen.clear();for(const id of keep)seen.add(id);}lastScanAt=Date.now();}while(dirty&&!signal.aborted)}finally{scanPending=false;}}
 async function pushed(frame){if(!notificationFrame(frame))return;mode='push';lastPushAt=Date.now();error=null;try{await scan()}catch{error='새 알림의 게시물 내용을 확인하지 못했습니다.';}}

 async function httpStream(){
  streamAbort=new AbortController();let lastData=Date.now();const timer=setInterval(()=>{if(Date.now()-lastData>60000)streamAbort.abort()},5000);const url=new URL('https://api.x.com/live_pipeline/events');url.searchParams.set('topics','notification:'+session.userId);
  try{const r=await fetcher(url,{headers:await signedXHeaders(session,'GET','/live_pipeline/events'),redirect:'error',signal:AbortSignal.any([signal,streamAbort.signal])});if(!r.ok||!r.body)throw Error('X 푸시 스트림 연결 실패 ('+r.status+')');let buffer='';const decoder=new TextDecoder();for await(const bytes of r.body){lastData=Date.now();buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>1048576)throw Error('X 푸시 응답 크기 초과');let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos).trim();buffer=buffer.slice(pos+1);if(!line)continue;let f;try{f=JSON.parse(line)}catch{continue;}if(f.payload?.subscriptions?.errors?.length||f.errors?.length){subscriptionRejected=true;throw Error('X가 알림 푸시 구독을 허용하지 않습니다.');}await pushed(f);}}}finally{clearInterval(timer);streamAbort.abort();if(!signal.aborted)mode='polling';}
 }
 try{session=(await site('/api/notification-config')).config;if(!session)return;followSetup=await syncFollowNotifications(session);await publish();
  const safety=(async()=>{while(!signal.aborted){try{await scan();if(Date.now()-lastPublish>15000)await publish()}catch(e){error=/\([345]\d{2}\)/.test(e.message)?e.message:'X 알림함 조회 실패 · 세션 또는 제공처 상태를 확인하세요.';try{await publish()}catch{}}try{await delay(5000,null,{signal})}catch{break}}})();
  while(!signal.aborted){mode='polling';if(!subscriptionRejected){try{await httpStream()}catch{error=subscriptionRejected?'X가 알림 푸시 구독을 허용하지 않아 알림함을 일괄 조회하고 있어요.':'X 푸시 연결 실패 · 알림함 일괄 조회 중';mode='polling';}}try{await publish();await delay(30000,null,{signal})}catch{if(signal.aborted)break}}
  await safety;
 }catch{if(!signal.aborted)console.error('X 봇 연결을 시작하지 못했습니다. 운영 페이지에서 연결 상태를 확인하세요.');}finally{streamAbort?.abort();session=null;}
}
