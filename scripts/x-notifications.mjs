// Event-driven account notifications, with a slow notification-inbox safety poll.
// Protocol references: DezXBT/x-notify-dc (ws.go, poller.go) and X web live_pipeline.
import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {xHeaders} from '../server/x-notifications.js';
import {memberHandles} from '../worker/index.js';
const allowed=new Set(memberHandles.map(h=>h.toLowerCase()));
export function notificationPosts(data){
 const objects=data?.globalObjects;if(!objects?.tweets||!objects?.users)throw Error('알림함 응답 형식 오류');
 return Object.entries(objects.tweets).flatMap(([id,t])=>{const u=objects.users[t.user_id_str];if(!u||!allowed.has(u.screen_name?.toLowerCase())||t.retweeted_status_id_str||t.retweeted_status)return[];
 let text=t.full_text||t.text;if(typeof text!=='string')return[];for(const link of t.entities?.urls||[])if(link.url&&link.expanded_url)text=text.split(link.url).join(link.expanded_url);
 return[{id:t.id_str||id,text,created_timestamp:(Date.parse(t.created_at)||0)/1000,author:{screen_name:u.screen_name}}];});
}
export function notificationFrame(frame){return typeof frame?.topic==='string'&&/^\/?notification[:/]/.test(frame.topic);}
export async function watchXNotifications({origin,secret,signal,fetcher=fetch,Socket=WebSocket}){
 const runId=randomUUID();const auth={Authorization:'Bearer '+secret};let session,mode='connecting',lastPushAt=null,lastScanAt=null,error=null,ws,streamAbort,scanPending=false,dirty=false,lastPublish=0;const seen=new Set();
 async function site(path,body){const r=await fetcher(origin+path,{method:body?'POST':'GET',headers:{...auth,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});if(!r.ok)throw Error('알림 연결 서버 응답 ('+r.status+')');return r.json();}
 async function publish(posts=[]){await site('/api/notification-event',{runId,mode,lastPushAt,lastScanAt,error,posts});lastPublish=Date.now();}
 async function scan(){if(scanPending){dirty=true;return;}scanPending=true;try{do{dirty=false;const r=await fetcher('https://api.x.com/2/notifications/device_follow.json?count=40&tweet_mode=extended',{headers:xHeaders(session),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});if(!r.ok)throw Error('X 알림함 조회 실패 ('+r.status+')');const data=await r.json();if(data.errors?.length)throw Error('X 알림함이 요청을 거절했습니다.');const posts=notificationPosts(data).filter(p=>!seen.has(p.id));await publish(posts);for(const p of posts)seen.add(p.id);if(seen.size>5000){const keep=[...seen].slice(-2000);seen.clear();for(const id of keep)seen.add(id);}lastScanAt=Date.now();}while(dirty&&!signal.aborted)}finally{scanPending=false;}}
 async function pushed(frame){if(!notificationFrame(frame))return;mode='push';lastPushAt=Date.now();error=null;try{await scan()}catch{error='새 알림의 게시물 내용을 확인하지 못했습니다.';}}
 async function websocket(){return new Promise((resolve,reject)=>{let ready=false;ws=new Socket('wss://x.com/i/api/1.1/live_pipeline/update_subscriptions',{headers:xHeaders(session),handshakeTimeout:12000,maxPayload:1024*1024});const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop)};const stop=()=>{finish();ws.terminate();resolve()};const timer=setTimeout(()=>{if(!ready){ws.terminate();reject(Error('X 알림 구독 응답 시간 초과'));}},15000);signal.addEventListener('abort',stop,{once:true});ws.on('open',()=>ws.send(JSON.stringify({subscribe:[{topic:'notification:'+session.userId,sub_topic:''}],unsubscribe:[]})));ws.on('message',bytes=>{let f;try{f=JSON.parse(bytes.toString())}catch{return;}if(notificationFrame(f)){ready=true;clearTimeout(timer);void pushed(f);}else if(f?.errors?.length){error='X 알림 구독이 거절됐습니다.';ws.terminate();}});ws.on('error',()=>{finish();reject(Error('X WebSocket 알림 연결 실패'))});ws.on('close',()=>{finish();if(!signal.aborted){mode='polling';resolve();}});});}
 async function httpStream(){
  streamAbort=new AbortController();let lastData=Date.now();const timer=setInterval(()=>{if(Date.now()-lastData>60000)streamAbort.abort()},5000);const url=new URL('https://api.x.com/live_pipeline/events');url.searchParams.set('topics','notification:'+session.userId);
  try{const r=await fetcher(url,{headers:xHeaders(session),redirect:'error',signal:AbortSignal.any([signal,streamAbort.signal])});if(!r.ok||!r.body)throw Error('X 푸시 스트림 연결 실패 ('+r.status+')');let buffer='';const decoder=new TextDecoder();for await(const bytes of r.body){lastData=Date.now();buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>1048576)throw Error('X 푸시 응답 크기 초과');let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos).trim();buffer=buffer.slice(pos+1);if(!line)continue;let f;try{f=JSON.parse(line)}catch{continue;}if(f.payload?.subscriptions?.errors?.length||f.errors?.length)throw Error('X 알림 토픽을 구독하지 못했습니다.');await pushed(f);}}}finally{clearInterval(timer);streamAbort.abort();if(!signal.aborted)mode='polling';}
 }
 try{session=(await site('/api/notification-config')).config;if(!session)return;await publish();
  const safety=(async()=>{while(!signal.aborted){try{await scan();if(Date.now()-lastPublish>15000)await publish()}catch{error='X 알림함 조회 실패 · 세션 또는 제공처 상태를 확인하세요.';try{await publish()}catch{}}try{await delay(20000,null,{signal})}catch{break}}})();
  while(!signal.aborted){try{await websocket()}catch{error='WebSocket 연결 불가 · HTTP 푸시 연결 확인 중';}if(signal.aborted)break;mode='polling';try{await httpStream()}catch{error='X 알림 푸시 연결 실패 · 알림함 보조 조회 중';mode='polling';}try{await publish();await delay(30000,null,{signal})}catch{if(signal.aborted)break}}
  await safety;
 }catch{if(!signal.aborted)console.error('X 봇 연결을 시작하지 못했습니다. 운영 페이지에서 연결 상태를 확인하세요.');}finally{ws?.terminate();streamAbort?.abort();session=null;}
}
