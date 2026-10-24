import{broadcastWebhook}from'../server/broadcast-webhook.js';
const members=[['','',[['강지','GANGZIIII']]],['에버리스','EVERYS',[['아야츠노 유니','AyatsunoYuni'],['사키하네 후야','SakihaneHuya']]],['유니버스','UNIVERSE',[['네네코 마시로','NenekoMashiro'],['아라하시 타비','ArahashiTabi'],['시라유키 히나','ShirayukiHina_'],['아카네 리제','AkaneLize']]],['클리셰','CLICHÉ',[['아오쿠모 린','AokumoRin'],['텐코 시부키','TenkoShibuki'],['하나코 나나','HanakoNana_'],['유즈하 리코','YuzuhaRiko']]],['어비스','ABYSS',[['시즈키 토아','ShizukiToa_'],['코가네 랑','CoganeRang'],['하나요 히요리','HanayoHiyori'],['토키노 메리','TokinoMary']]]];
export const memberNames=Object.fromEntries(members.flatMap(g=>g[2]).map(([name,handle])=>[handle.toLowerCase(),name]));
export const memberHandles=members.flatMap(g=>g[2]).map(m=>m[1]);
const bearer='AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
let guest,guestAt=0,guestPending;
async function json(url,init={}){const r=await fetch(url,{...init,headers:{'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',...init.headers},redirect:'manual',signal:AbortSignal.timeout(10000)});if(!r.ok){const e=Error('외부 조회 오류 ('+r.status+') · '+new URL(url).pathname);e.status=r.status;const after=r.headers.get('retry-after'),seconds=Number(after),reset=Number(r.headers.get('x-rate-limit-reset'))*1000;e.retryAt=Math.max(Number.isFinite(seconds)&&after?Date.now()+seconds*1000:Date.parse(after)||0,reset||0);throw e;}const d=await r.json();if(Number(d.code)===429){const e=Error('외부 조회 제한 (429) · '+new URL(url).pathname);e.status=429;const after=r.headers.get('retry-after'),seconds=Number(after),reset=Number(r.headers.get('x-rate-limit-reset'))*1000;e.retryAt=Math.max(Number.isFinite(seconds)&&after?Date.now()+seconds*1000:Date.parse(after)||0,reset||0);throw e;}if(d.errors?.length)throw Error(d.errors[0].message);return d;}
// 10% headroom below the provider's published 1,000 requests/minute.
const FX_TARGET_RPM=900,PROFILE_RPM=members.flatMap(g=>g[2]).length*60/5,FX_SLOT_MS=Math.ceil(60000/FX_TARGET_RPM);
export function replyInterval(roomCount){return Math.ceil(60000*Math.max(1,roomCount)/(FX_TARGET_RPM-PROFILE_RPM));}
export async function reserveFxSlot(db,now=Date.now()){
  const row=await db.prepare(`INSERT INTO collector_entries (key,next_poll_at) VALUES ('budget:fx',?1+?2)
    ON CONFLICT(key) DO UPDATE SET next_poll_at=MAX(collector_entries.next_poll_at,?1)+?2
    WHERE collector_entries.next_poll_at<=?1+2000 RETURNING next_poll_at`).bind(now,FX_SLOT_MS).first();
  if(!row)throw Error('공유 호출 예산 대기 중');
  return Math.max(0,row.next_poll_at-FX_SLOT_MS-now);
}
function deferred(message,retryAt){return Object.assign(Error(message),{deferred:true,retryAt});}
export async function providerReady(db,source){const row=await db.prepare('SELECT next_poll_at FROM collector_entries WHERE key=?1').bind('budget:pause:'+source).first();if(row?.next_poll_at>Date.now())throw deferred('제공처 재시도 시각 대기 중',row.next_poll_at);}
async function providerFailure(db,source,error){if(error.status!==429&&!/\(429\)/.test(error.message))return;const until=Math.max(error.retryAt||0,Date.now()+(source==='carry'?300000:30000));error.retryAt=until;await db.prepare(`INSERT INTO collector_entries(key,next_poll_at) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET next_poll_at=MAX(collector_entries.next_poll_at,excluded.next_poll_at) RETURNING key`).bind('budget:pause:'+source,until).first();}
async function fxJson(db,url){await providerReady(db,'fx');const delay=await reserveFxSlot(db);if(delay)await new Promise(r=>setTimeout(r,delay));await providerReady(db,'fx');try{return await json(url)}catch(e){await providerFailure(db,'fx',e);throw e;}}
async function replySchedule(db,id){
 const now=Date.now();
 const live=await db.prepare(`SELECT COUNT(*) AS count FROM collector_entries WHERE key LIKE 'member:v2:%' AND payload IS NOT NULL AND json_extract(payload,'$.status')='live' AND last_started_at>=?1`).bind(now-30000).first();
 const active=await db.prepare(`SELECT COUNT(*) AS count FROM collector_entries WHERE key LIKE 'replies:fxtwitter:%' AND (last_started_at>=?1 OR key=?2)`).bind(now-30000,'replies:fxtwitter:'+id).first();
 const liveCount=Number(live?.count||0),activeRoomCount=Math.max(1,Number(active?.count||0));
 return {pollIntervalMs:replyInterval(Math.max(liveCount,activeRoomCount)),liveCount,activeRoomCount};
}
async function headers(){if(!guest||Date.now()-guestAt>600000){if(!guestPending)guestPending=(async()=>{guest=(await json('https://api.x.com/1.1/guest/activate.json',{method:'POST',headers:{authorization:'Bearer '+bearer}})).guest_token;guestAt=Date.now();})().finally(()=>{guestPending=null;});await guestPending;}return{authorization:'Bearer '+bearer,'x-guest-token':guest,'content-type':'application/json'};}
async function gql(op,id,variables){const u=new URL('https://x.com/i/api/graphql/'+id+'/'+op);u.searchParams.set('variables',JSON.stringify(variables));return json(u,{headers:await headers()});}
export function currentParticipants(space){
  const count=space?.participants?.total;
  return space?.metadata?.state==='Running'&&Number.isSafeInteger(count)&&count>=0?count:null;
}
async function metadata(id){const d=await gql('AudioSpaceById','fYAuJHiY3TmYdBmrRtIKhA',{id,isMetatagsQuery:false,withReplays:true,withListeners:true});const space=d.data?.audioSpace,m=space?.metadata;if(!m)throw Error('Space 정보를 확인할 수 없습니다.');return {...m,currentParticipants:currentParticipants(space)};}
async function spaceMetadata(id,db){return sharedCollect(db,'space:'+id,m=>m.state==='Running'?5000:60000,()=>metadata(id));}
function find(value,test){if(!value||typeof value!=='object')return null;if(test(value))return value;for(const v of Object.values(value)){const r=find(v,test);if(r)return r;}return null;}
export function firstLiveMember(groups,statuses){
  return groups.flatMap(g=>g[2]).find(m=>statuses.some(s=>s.handle.toLowerCase()===m[1].toLowerCase()&&s.status==='live'&&!s.stale))?.[1]||null;
}
export function memberFromPath(path,groups){
  let handle;try{handle=decodeURIComponent(path.replace(/^\/+|\/+$/g,''));}catch{return null;}
  return groups.flatMap(g=>g[2]).find(m=>m[1].toLowerCase()===handle.toLowerCase())?.[1]||null;
}
export function findSpacePost(posts,handle){
  return [...posts].filter(p=>p.author?.screen_name?.toLowerCase()===handle.toLowerCase()).sort((a,b)=>(b.created_timestamp||0)-(a.created_timestamp||0)).slice(0,5).map(post=>{
    const match=(post.text+' '+JSON.stringify(post.raw_text?.facets||[])).match(/https:\/\/(?:x|twitter)\.com\/i\/spaces\/([A-Za-z0-9]+)/);
    return match?{post,space:match[1]}:null;
  }).find(Boolean)||null;
}
export async function rememberBroadcast(db,value,startedAt){
 const postId=value.postUrl?.match(/\/status\/(\d{2,20})/)?.[1];
 if(!postId||!value.space||!['Running','Ended'].includes(value.state))return await retainedBroadcast(db,value.handle)||value;
 const previous=await retainedBroadcast(db,value.handle);
 await db.prepare(`INSERT INTO broadcast_sessions (handle,post_id,space_id,started_at,payload) VALUES (?1,?2,?3,?4,?5)
 ON CONFLICT(handle) DO UPDATE SET post_id=excluded.post_id,space_id=excluded.space_id,started_at=excluded.started_at,payload=excluded.payload
 WHERE excluded.started_at>=broadcast_sessions.started_at`).bind(value.handle,postId,value.space,startedAt||0,JSON.stringify(value)).first();
 const current=await retainedBroadcast(db,value.handle)||value;try{await broadcastWebhook(db,previous,current,memberNames[value.handle.toLowerCase()]||value.handle)}catch{}return current;
}
async function retainedBroadcast(db,handle){const row=await db.prepare('SELECT payload FROM broadcast_sessions WHERE handle=?1').bind(handle).first();return row?JSON.parse(row.payload):null;}
export async function archiveMessages(db,postId,messages){
 const batchSize=Math.min(40,db.maxBatchRows||40);
 for(let i=0;i<messages.length;i+=batchSize){const part=messages.slice(i,i+batchSize),args=[];const placeholders=part.map((m,j)=>{args.push(postId,m.id,JSON.stringify(m));return '('+[1,2,3].map(n=>'?'+(j*3+n)).join(',')+')';});if(part.length)await db.prepare('INSERT INTO broadcast_messages (post_id,id,payload) VALUES '+placeholders.join(',')+' ON CONFLICT(post_id,id) DO NOTHING').bind(...args).first();}
}
export async function broadcastHistory(db,postId,after=0){
 const rows=await db.prepare('SELECT seq,payload FROM broadcast_messages WHERE post_id=?1 AND seq>?2 ORDER BY seq ASC LIMIT 501').bind(postId,after).all();
 const page=rows.results.slice(0,500);return{messages:page.map(row=>JSON.parse(row.payload)),historyCursor:page.at(-1)?.seq||after,hasMore:rows.results.length>500};
}
export async function recentBroadcastHistory(db,postId,before=0){
 const rows=(await db.prepare('SELECT seq,payload FROM broadcast_messages WHERE post_id=?1 AND (?2=0 OR seq<?2) ORDER BY seq DESC LIMIT 201').bind(postId,before).all()).results;
 const page=rows.slice(0,200).reverse();return{messages:page.map(r=>JSON.parse(r.payload)),historyCursor:page.at(-1)?.seq||0,olderCursor:page[0]?.seq||0,hasOlder:rows.length>200,hasMore:false};
}
async function reserveCarrySlot(db){
 const now=Date.now(),slot=5000;
 const row=await db.prepare(`INSERT INTO collector_entries (key,next_poll_at) VALUES ('budget:carry',?1+?2)
 ON CONFLICT(key) DO UPDATE SET next_poll_at=MAX(collector_entries.next_poll_at,?1)+?2
 WHERE collector_entries.next_poll_at<=?1+2000 RETURNING next_poll_at`).bind(now,slot).first();
 if(!row)throw deferred('보조 게시물 조회 대기 중',now+5000);
 const delay=row.next_poll_at-slot-now;if(delay>0)await new Promise(r=>setTimeout(r,delay));
}
async function timelineSource(db,handle,source,minimumIntervalMs=0){
 return sharedCollect(db,'timeline:'+source+':'+handle,Math.max(minimumIntervalMs,source==='fx'?30000:60000),async()=>{
  const url=source==='fx'?'https://api.fxtwitter.com/2/profile/':'https://api.carryfeed.com/api/profile/';
  if(source==='carry'){await providerReady(db,'carry');await reserveCarrySlot(db);await providerReady(db,'carry');}
  let d;try{d=await(source==='fx'?fxJson(db,url+handle+'/statuses?count=5'):json(url+handle+'/statuses?count=5'));}catch(e){if(source==='carry')await providerFailure(db,'carry',e);throw e;}
  if(d.code!==200||!Array.isArray(d.results))throw Error('멤버 게시물 응답을 읽을 수 없습니다.');
  return{posts:d.results,source};
 },{minimumIntervalMs,failureBackoff:failures=>Math.max(minimumIntervalMs,Math.min(300000,30000*2**Math.min(failures-1,4)))});
}
export async function ingestNotificationPosts(db,posts){
 let accepted=0;
 for(const post of posts){const handle=memberHandles.find(h=>h.toLowerCase()===post?.author?.screen_name?.toLowerCase());if(!handle||!/^\d{2,20}$/.test(post.id||'')||typeof post.text!=='string'||post.text.length>30000)continue;
 const clean={id:post.id,text:post.text,created_timestamp:Number(post.created_timestamp)||0,author:{screen_name:handle},raw_text:{facets:[]}};
 const key='notification-posts:'+handle,row=await db.prepare('SELECT payload FROM collector_entries WHERE key=?1').bind(key).first();let prior=[];try{prior=JSON.parse(row?.payload||'{}').posts||[]}catch{}
 const merged=[...new Map([...prior,clean].map(p=>[p.id,p])).values()].sort((a,b)=>{const x=BigInt(a.id),y=BigInt(b.id);return x>y?-1:x<y?1:0}).slice(0,5);
 await db.prepare(`INSERT INTO collector_entries(key,payload,next_poll_at) VALUES(?1,?2,0) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload RETURNING key`).bind(key,JSON.stringify({posts:merged,checkedAt:new Date().toISOString()})).first();
 await db.prepare(`UPDATE collector_entries SET next_poll_at=0 WHERE key=?1 RETURNING key`).bind('member:v2:'+handle).first();accepted++;
 }
 return accepted;
}
async function discoverTimeline(db,handle){
 let prior,errors=[];
 const state=await db.prepare("SELECT payload FROM collector_entries WHERE (key='x-notifications' OR key LIKE 'x-notifications:%') AND json_extract(payload,'$.mode') IN ('push','polling') AND (json_extract(payload,'$.lastScanAt')>?1 OR (json_extract(payload,'$.pushConnected')=1 AND json_extract(payload,'$.checkedAtMs')>?2)) ORDER BY CASE WHEN json_extract(payload,'$.mode')='push' AND json_extract(payload,'$.pushConnected')=1 AND json_extract(payload,'$.checkedAtMs')>?2 THEN 0 ELSE 1 END,json_extract(payload,'$.checkedAtMs') DESC LIMIT 1").bind(Date.now()-45000,Date.now()-30000).first();let watcher={};try{watcher=JSON.parse(state?.payload||'{}')}catch{}
 const pushed=await db.prepare('SELECT payload FROM collector_entries WHERE key=?1').bind('notification-posts:'+handle).first();let notificationPosts=[];try{notificationPosts=JSON.parse(pushed?.payload||'{}').posts||[]}catch{}
 const cached=await db.prepare("SELECT payload FROM collector_entries WHERE key IN (?1,?2) AND payload IS NOT NULL ORDER BY json_extract(payload,'$.checkedAt') DESC LIMIT 1").bind('timeline:fx:'+handle,'timeline:carry:'+handle).first();let timeline;try{timeline=JSON.parse(cached?.payload||'null')}catch{}
 const pushHealthy=watcher.mode==='push'&&watcher.pushConnected===true&&Date.now()-Number(watcher.checkedAtMs||0)<30000;
 const inboxHealthy=['push','polling'].includes(watcher.mode)&&Date.now()-Number(watcher.lastScanAt||0)<45000;
 const auditMs=pushHealthy?300000+memberHandles.indexOf(handle)*2000:inboxHealthy?60000:30000;
 if(timeline&&Date.now()-Date.parse(timeline.checkedAt)<auditMs)return{posts:[...notificationPosts,...timeline.posts],source:pushHealthy||inboxHealthy?'x-notifications':timeline.source,fresh:true};
 for(const source of ['fx','carry']){
  try{const feed=await timelineSource(db,handle,source,pushHealthy?auditMs:0);if(feed.posts){if(!feed.stale)return{...feed,posts:[...notificationPosts,...feed.posts],fresh:true};prior||=feed;}errors.push(feed.warning||'게시물 조회 대기 중');}catch(e){errors.push(e.message);}
 }
 return{posts:[...notificationPosts,...(prior?.posts||[])],source:notificationPosts.length?'x-notifications':prior?.source,fresh:false,warning:errors.join(' · ')};
}
export function decideSpaceStatus({prior,found,candidate,previous,feedFresh}){
 if(found&&candidate?.state==='Running')return{...found,state:'Running',status:'live',startedAt:candidate.started_at??null,currentParticipants:candidate.currentParticipants??null,title:candidate.title||found.title,authoritative:true};
 if(prior&&previous?.state==='Running')return{...prior,state:'Running',status:'live',startedAt:previous.started_at??prior.startedAt??null,currentParticipants:previous.currentParticipants??null,authoritative:true};
 if(prior&&previous?.state==='Ended'){const currentKnown=prior.state!=='Ended'||feedFresh;return{...prior,state:'Ended',status:currentKnown?'offline':'unknown',currentParticipants:null,authoritative:!!currentKnown};}
 if(found&&candidate?.state==='Ended')return{...found,state:'Ended',status:'offline',currentParticipants:null,authoritative:true};
 // A missing link or a failed request is never evidence that a known live Space ended.
 if(prior?.state==='Running')return{...prior,state:'Unknown',status:'unknown',lastKnownState:'Running',currentParticipants:null};
 if(prior?.state==='Ended')return{...prior,status:feedFresh&&!found?'offline':'unknown',state:'Ended',currentParticipants:null};
 if(!found&&feedFresh)return{status:'offline'};
 return{...found,state:found?'Unknown':undefined,status:'unknown'};
}
async function profile(handle,db){
 const member=members.flatMap(g=>g[2]).find(m=>m[1].toLowerCase()===handle.toLowerCase());
 if(!member)throw Error('등록되지 않은 멤버입니다.');handle=member[1];
 const value=await sharedCollect(db,'member:v2:'+handle,5000,async()=>{
  const prior=await retainedBroadcast(db,handle);
  const check=async id=>{if(!id)return null;try{const m=await spaceMetadata(id,db);return m.stale||!m.state?null:m;}catch{return null;}};
  const [feed,previous]=await Promise.all([discoverTimeline(db,handle),check(prior?.space)]);
  const own=feed.posts.find(p=>p.author?.screen_name?.toLowerCase()===handle.toLowerCase());
  const avatar=own?.author?.avatar_url||prior?.avatar;
  const link=findSpacePost(feed.posts,handle);
  const candidate=link?.space===prior?.space?previous:await check(link?.space);
  const found=link?{handle,avatar,space:link.space,title:candidate?.title||member[0]+'의 스페이스',postUrl:'https://x.com/'+handle+'/status/'+link.post.id}:null;
  const state=decideSpaceStatus({prior,found,candidate,previous,feedFresh:feed.fresh});
  const result={...state,handle,avatar,discoverySource:feed.source||null,discoveryWarning:feed.warning||null,stateCheckedAt:state.authoritative?new Date().toISOString():null};
  if(result.authoritative){const started=link&&result.space===link.space?Number(link.post.created_timestamp)*1000:0;await rememberBroadcast(db,result,started||await retainedStartedAt(db,handle));}
  return result;
 },{leaseMs:45000});
 return{handle,status:'unknown',...value};
}
async function retainedStartedAt(db,handle){return(await db.prepare('SELECT started_at FROM broadcast_sessions WHERE handle=?1').bind(handle).first())?.started_at||0;}
async function resolve(input,db){
  let id=input,tweetId=null;
  if(/^https?:/.test(input)){
    const u=new URL(input);
    if(!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname))throw Error('X URL을 입력해 주세요.');
    tweetId=u.pathname.match(/\/status\/(\d{2,20})(?:\/|$)/)?.[1]||null;
    if(!tweetId)id=u.pathname.match(/\/i\/spaces\/([A-Za-z0-9]+)/)?.[1];
  }
  if(!tweetId&&!/^[A-Za-z0-9]{8,30}$/.test(id||''))throw Error('Space 또는 Space 공유 게시물 URL을 입력해 주세요.');
  return sharedCollect(db,'resolve:'+(tweetId?'post:'+tweetId:'space:'+id),15000,async()=>{
    let tweet;
    if(tweetId){const saved=await db.prepare('SELECT payload FROM broadcast_sessions WHERE post_id=?1').bind(tweetId).first();if(saved){const session=JSON.parse(saved.payload);let m;try{m=await spaceMetadata(session.space,db);}catch{}return{id:session.space,tweet:tweetId,handle:session.handle,title:session.title,avatar:session.avatar,state:m?.state||session.state,startedAt:m?.started_at??null,currentParticipants:m?.currentParticipants??null};}}
    if(tweetId){
      tweet=await json('https://cdn.syndication.twimg.com/tweet-result?id='+tweetId+'&lang=ko&token=0');
      const link=tweet.entities?.urls?.find(x=>/\/i\/spaces\//.test(x.expanded_url));
      id=link?.expanded_url?.match(/\/i\/spaces\/([A-Za-z0-9]+)/)?.[1]||tweet.card?.binding_values?.id?.string_value;
      if(!id)throw Error('게시물에서 Space 링크를 찾지 못했습니다.');
    }
    let m;
    try{m=await spaceMetadata(id,db);}catch(e){if(!tweet)throw e;}
    const creator=m?.creator_results?.result?.legacy?.screen_name||tweet?.user?.screen_name;
    let discoveryWarning=null;
    if(!tweetId&&creator){
      for(const source of ['fx','carry']){try{const feed=await timelineSource(db,creator,source);const match=(feed.posts||[]).map(post=>findSpacePost([post],creator)).find(link=>link?.space===id);if(match){tweetId=match.post.id;break;}}catch(e){discoveryWarning=e.message;}}
    }
    return{id,title:m?.title||(tweet?.user?.name||'선택한 멤버')+'의 스페이스',state:m?.state||'Unknown',handle:(()=>{const h=m?.creator_results?.result?.legacy?.screen_name||tweet?.user?.screen_name;return members.flatMap(g=>g[2]).find(x=>x[1].toLowerCase()===h?.toLowerCase())?.[1]||h;})(),avatar:m?.creator_results?.result?.legacy?.profile_image_url_https||tweet?.user?.profile_image_url_https,startedAt:m?.started_at??null,currentParticipants:m?.currentParticipants??null,tweet:tweetId,replies:tweet?.conversation_count,discoveryWarning:tweetId?null:discoveryWarning};
  });
}
// All execution regions coordinate through one D1 row per collection key.
// A lease owner alone may fetch or commit. A crashed owner is recoverable after expiry.
export async function sharedCollect(db,key,ttl,produce,options={}){
  if(!db?.prepare)throw Error('공유 수집 저장소가 연결되지 않았습니다.');
  const clock=options.clock||Date.now,now=clock(),leaseMs=options.leaseMs||25000;
  const read=()=>db.prepare('SELECT * FROM collector_entries WHERE key = ?1').bind(key).first();
  let row=await read();
  const output=(r,collecting=false)=>r?.payload?{...JSON.parse(r.payload),shared:true,collecting,stale:!!r.last_error,warning:r.last_error||null}:{shared:true,collecting:true,messages:[],source:key.startsWith('replies:')?key.split(':')[1]:undefined,checkedAt:null};
  if(row&&options.minimumIntervalMs&&row.last_started_at+options.minimumIntervalMs>now){if(!row.payload&&row.last_error)throw Error(row.last_error);return output(row,row.lease_until>now);}
  if(row&&row.next_poll_at>now){if(!row.payload&&row.last_error)throw Error(row.last_error);return output(row,row.lease_until>now);}
  if(row?.lease_until>now)return output(row,true);
  const token=crypto.randomUUID();
  const acquired=await db.prepare(`INSERT INTO collector_entries (key, lease_until, lease_token, last_started_at, fetch_count)
    VALUES (?1, ?2, ?3, ?4, 1)
    ON CONFLICT(key) DO UPDATE SET lease_until=excluded.lease_until,lease_token=excluded.lease_token,last_started_at=excluded.last_started_at,fetch_count=collector_entries.fetch_count+1
    WHERE collector_entries.next_poll_at <= ?4 AND collector_entries.lease_until <= ?4 AND collector_entries.last_started_at <= ?5
    RETURNING *`).bind(key,now+leaseMs,token,now,now-(options.minimumIntervalMs||0)).first();
  if(!acquired)return output(await read(),true);
  try{
    let value=await produce();
    if(options.mergeMessages&&acquired.payload){
      const prior=JSON.parse(acquired.payload),byId=new Map();
      for(const m of [...(prior.messages||[]),...(value.messages||[])])byId.set(m.id,m);
      const messages=[...byId.values()].sort((a,b)=>a.time-b.time).slice(-500);
      let size=2,start=messages.length;while(start>0){const length=JSON.stringify(messages[start-1]).length+1;if(size+length>900000)break;size+=length;start--;}if(start)messages.splice(0,start);
      value={...value,messages};
    }
    const checkedAt=new Date(clock()).toISOString();value={...value,checkedAt};
    const committed=await db.prepare(`UPDATE collector_entries SET payload=?1,next_poll_at=?2,lease_until=0,lease_token='',last_error=NULL,failure_count=0 WHERE key=?3 AND lease_token=?4 RETURNING *`).bind(JSON.stringify(value),(options.startCadence?acquired.last_started_at:clock())+(typeof ttl==='function'?ttl(value):ttl),key,token).first();
    return output(committed||await read(),!committed);
  }catch(e){
    if(e.deferred||/공유 호출 예산 대기 중/.test(e.message)){
      const waiting=await db.prepare(`UPDATE collector_entries SET next_poll_at=?1,lease_until=0,lease_token='' WHERE key=?2 AND lease_token=?3 RETURNING *`).bind(Math.max(clock()+1000,e.retryAt||clock()+3000),key,token).first();
      if(waiting?.payload)return{...output(waiting),waiting:true,waitingReason:e.message};throw e;
    }
    const failures=(acquired.failure_count||0)+1;const backoff=Math.max((e.retryAt||0)-clock(),options.failureBackoff?options.failureBackoff(failures):/429/.test(e.message)?30000:Math.max(typeof ttl==='function'?15000:ttl,3000));
    const failed=await db.prepare(`UPDATE collector_entries SET next_poll_at=?1,lease_until=0,lease_token='',last_error=?2,failure_count=failure_count+1 WHERE key=?3 AND lease_token=?4 RETURNING *`).bind(clock()+backoff,e.message,key,token).first();
    if(failed)try{await db.prepare(`INSERT INTO collector_errors(at,key,error) VALUES(?1,?2,?3) RETURNING id`).bind(clock(),key,String(e.message).slice(0,1000)).first();await db.prepare(`DELETE FROM collector_errors WHERE id NOT IN (SELECT id FROM collector_errors ORDER BY id DESC LIMIT 500) RETURNING id`).bind().all();}catch{}
    if(failed?.payload)return output(failed);
    if(!failed){const current=await read();if(current?.payload)return output(current,current.lease_until>clock());}
    throw e;
  }
}
export function stripLeadingMentions(text) {
  return text.replace(/^(?:\s*@[A-Za-z0-9_]{1,15}(?=\s|$)\s*)+/, '');
}
export function parseFxReplies(data,rootId){
  if(data.code!==200||!Array.isArray(data.replies))throw Error('답글 조회 제한 ('+(data.code||'응답 오류')+')');
  const byId=new Map();
  for(const item of data.replies){
    if(item.type!=='status'||item.replying_to?.status!==rootId||typeof item.text!=='string')continue;
    byId.set(item.id,{id:item.id,name:item.author?.name||item.author?.screen_name||'청취자',handle:item.author?.screen_name||'',text:item.text,photos:(item.media?.photos||[]).map(p=>{try{const u=new URL(p.url);return u.protocol==='https:'&&u.hostname==='pbs.twimg.com'&&u.pathname.startsWith('/media/')?{url:u.href}:null;}catch{return null;}}).filter(Boolean).slice(0,4),time:Number(item.created_timestamp)*1000||Date.parse(item.created_at)||0,url:'https://x.com/i/status/'+item.id});
  }
  return{messages:[...byId.values()].sort((a,b)=>a.time-b.time),total:data.status?.replies??null,cursor:data.cursor?.bottom||null,limited:true,source:'fxtwitter'};
}
async function seedBroadcastHistory(db,id){
 const exists=await db.prepare('SELECT seq FROM broadcast_messages WHERE post_id=?1 LIMIT 1').bind(id).first();
 if(!exists){const prior=await db.prepare('SELECT payload FROM collector_entries WHERE key=?1').bind('replies:fxtwitter:'+id).first();if(prior?.payload)await archiveMessages(db,id,JSON.parse(prior.payload).messages||[]);}
}
async function replies(id,db,knownSpaceId=null,after=0,latest=false,debugRead=false){
  if(!/^\d{2,20}$/.test(id))throw Error('공유 게시물 ID를 입력해 주세요.');
  await seedBroadcastHistory(db,id);
  const resolved=await db.prepare('SELECT payload FROM collector_entries WHERE key=?1 OR (key LIKE \'resolve:space:%\' AND json_extract(payload,\'$.tweet\')=?2) LIMIT 1').bind('resolve:post:'+id,id).first();
  const spaceId=knownSpaceId||(resolved?.payload?JSON.parse(resolved.payload).id:null);
  const space=spaceId?await spaceMetadata(spaceId,db):null;
  if(space?.state==='Ended'&&!debugRead){
    const cached=await db.prepare('SELECT payload FROM collector_entries WHERE key=?1').bind('replies:fxtwitter:'+id).first();
    const prior=cached?.payload?JSON.parse(cached.payload):{messages:[],source:'fxtwitter',limited:true};return {...prior,...await (latest?recentBroadcastHistory(db,id):broadcastHistory(db,id,after)),shared:true,collecting:false,stopped:true,pollIntervalMs:null};
  }
  const schedule=await replySchedule(db,id);
  const result=await sharedCollect(db,'replies:fxtwitter:'+id,schedule.pollIntervalMs,async()=>{const result=parseFxReplies(await fxJson(db,'https://api.fxtwitter.com/2/conversation/'+id+'?ranking_mode=recency'),id);await archiveMessages(db,id,result.messages);return result;},{mergeMessages:true,startCadence:true});
  return {...result,...schedule,...await (latest?recentBroadcastHistory(db,id):broadcastHistory(db,id,after)),...(debugRead&&space?.state==='Ended'?{stopped:true}: {})};
}
export async function collectLiveRooms(db){
  const rows=await db.prepare(`SELECT payload FROM collector_entries WHERE key LIKE 'member:v2:%' AND payload IS NOT NULL AND last_error IS NULL AND last_started_at>=?1 AND json_extract(payload,'$.status')='live'`).bind(Date.now()-30000).all();
  const rooms=[],ids=new Set();
  for(const row of rows.results||[]){const member=JSON.parse(row.payload),id=member.postUrl?.match(/\/status\/(\d{2,20})/)?.[1];if(!id||!member.space||ids.has(id))continue;ids.add(id);rooms.push({...member,postId:id});}
  const interval=rooms.length?replyInterval(rooms.length):2000;
  const batch=await sharedCollect(db,'live-batch',interval,async()=>{
    const results=await Promise.all(rooms.map(async member=>{try{const value=await replies(member.postId,db,member.space);return{handle:member.handle,postId:member.postId,checkedAt:value.checkedAt||null,stopped:!!value.stopped,collecting:!!value.collecting,stale:!!value.stale};}catch(e){return{handle:member.handle,postId:member.postId,error:e.message};}}));
    return{rooms:results};
  },{startCadence:true});
  return {...batch,pollIntervalMs:interval,liveCount:rooms.length};
}
export default{async fetch(request,env={},ctx){
  const u=new URL(request.url);
  if(u.pathname.startsWith('/api/')){const task=(async()=>{try{
    let d;
    if(u.pathname==='/api/members')d=await Promise.all(members.flatMap(g=>g[2]).map(async m=>{try{return await profile(m[1],env.DB);}catch(e){return{handle:m[1],status:'unknown',error:e.message};}}));
    else if(u.pathname==='/api/collect-live')d=await collectLiveRooms(env.DB);
    else if(u.pathname==='/api/member')d=await profile(u.searchParams.get('handle')||'',env.DB);
    else if(u.pathname==='/api/chat-history'){const id=u.searchParams.get('id')||'',before=Number(u.searchParams.get('before'));if(!/^\d{2,20}$/.test(id)||!Number.isSafeInteger(before)||before<1)throw Error('기록 조회 범위를 확인해 주세요.');d=await recentBroadcastHistory(env.DB,id,before);}
    else if(u.pathname==='/api/replies')d=await replies(u.searchParams.get('id')||'',env.DB,null,Math.max(0,Number(u.searchParams.get('after'))||0),u.searchParams.get('latest')==='1',env.DEBUG_ONLY===true);
    else if(u.pathname==='/api/resolve')d=await resolve(u.searchParams.get('url')||'',env.DB);
    else return new Response('Not found',{status:404});
    return Response.json(d,{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({error:e.message},{status:502,headers:{'Cache-Control':'no-store'}});}})();ctx?.waitUntil(task.then(()=>{}));return task;}
  const page=await initialPage(env.DB,u.pathname);
  return new Response(page,{headers:{'content-type':'text/html;charset=utf-8','Cache-Control':'no-store'}});
}};
export async function initialPage(db,path){
 let states=[];
 try{const rows=await db.prepare("SELECT payload FROM collector_entries WHERE key LIKE 'member:v2:%' AND payload IS NOT NULL").bind().all();
  for(const row of rows.results){try{const p=JSON.parse(row.payload);if(!memberHandles.includes(p.handle))continue;const fresh=Date.now()-Date.parse(p.checkedAt)<60000;states.push({handle:p.handle,status:fresh&&['live','offline'].includes(p.status)?p.status:'unknown',state:p.state,checkedAt:p.checkedAt,postUrl:p.postUrl,space:p.space,avatar:p.avatar,startedAt:p.startedAt,currentParticipants:p.currentParticipants});}catch{}}
 }catch{}
 const handle=memberFromPath(path,members)||'GANGZIIII',status=states.find(s=>s.handle===handle)?.status||'unknown';
 return html.replaceAll('__PUBLIC_URL__','https://spacelive.vercel.app'+(memberFromPath(path,members)?'/'+handle:'/')).replace('const initialMemberStates=[];',()=> 'const initialMemberStates='+JSON.stringify(states).replace(/</g,'\\u003c')+';').replace('class="status unknown" id="selectedStatus">확인 중</span>','class="status '+status+'" id="selectedStatus">'+(status==='live'?'방송 중':status==='offline'?'오프라인':'확인 중')+'</span>');
}
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>스페라이브</title><meta name="description" content="스텔라이브 멤버들의 X Space 답글을 한곳에서 편하게 보는 비공식 팬 서비스."><link rel="canonical" href="__PUBLIC_URL__"><meta property="og:type" content="website"><meta property="og:locale" content="ko_KR"><meta property="og:site_name" content="스페라이브"><meta property="og:title" content="스페라이브"><meta property="og:description" content="스텔라이브 멤버들의 X Space 답글을 한곳에서 편하게 보는 비공식 팬 서비스."><meta property="og:url" content="__PUBLIC_URL__"><meta property="og:image" content="https://spacelive.vercel.app/brand/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="보라색 배경의 SPACELIVE 로고"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="스페라이브"><meta name="twitter:description" content="스텔라이브 멤버들의 X Space 답글을 한곳에서 편하게 보는 비공식 팬 서비스."><meta name="twitter:image" content="https://spacelive.vercel.app/brand/x-card.png"><meta name="twitter:image:alt" content="SPACELIVE 로고"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-96.png" type="image/png" sizes="96x96"><link rel="shortcut icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="/site.webmanifest"><meta name="apple-mobile-web-app-title" content="스페라이브"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin><link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"><link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-jp-dynamic-subset.min.css"><style>
:root{color-scheme:dark;--bg:#000000;--text:#e7e9ea;--muted:#ffffff99;--border:#ffffff26;--purple:#1d9bf0;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard Variable",Pretendard,"Pretendard JP Variable","Pretendard JP",Roboto,"Noto Sans KR","Segoe UI","Malgun Gothic","Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol",sans-serif;font-feature-settings:"ss05";font-size:14px;line-height:1.4}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text)}button,input,select{font:inherit;font-feature-settings:inherit}button,a{-webkit-tap-highlight-color:transparent}button{color:inherit;cursor:pointer}button:focus-visible,a:focus-visible,select:focus-visible{outline:2px solid #1d9bf0;outline-offset:2px}button:hover{background:#ffffff14}button:disabled{cursor:default;opacity:.6}[hidden]{display:none!important}main,.chatwindow{width:100%;height:100dvh}.chatwindow{display:flex;flex-direction:column;background:#000000;position:relative}.selector{flex-shrink:0;padding:0 8px;border-bottom:1px solid var(--border);position:relative;z-index:4;background:#000000}.choose{width:100%;border:1px solid #ffffff26;background:transparent;display:flex;align-items:center;padding:8px;gap:10px;text-align:left;min-height:62px;border-radius:14px;margin:8px 0}.avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;background:#403448;display:inline-grid;place-items:center;flex-shrink:0;font-size:12px}.avatar{position:relative;margin:4px;overflow:visible}.avatar-photo{display:block;width:100%;height:100%;border-radius:50%;object-fit:cover}.avatar-fallback{display:grid;place-items:center}.avatar-live{box-shadow:0 0 0 2px #000,0 0 0 4px #7856ff}.space-badge{position:absolute;right:-5px;bottom:-5px;width:17px;height:17px;display:grid;place-items:center;border-radius:50%;background:#7856ff;box-shadow:0 0 0 2px #000}.space-badge svg{width:13px;height:13px}.member .space-badge{width:14px;height:14px;right:-4px;bottom:-4px}.member .space-badge svg{width:11px;height:11px}.identity{flex:1;min-width:0}.identity strong{display:block;font-size:14px;font-weight:700;line-height:18px}.identity small{display:block;color:#ffffff99;font-size:12px;line-height:15px}.status{font-size:10px;color:#8b98a5;white-space:nowrap;padding:4px 8px;border-radius:999px;background:#16181c}.status.live{color:#fff;background:#7856ff}.chevron{width:16px;height:16px;color:#ffffff99}.windowtop{min-height:64px;position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);background:#000000}.audience{display:flex;align-items:center;justify-content:flex-start;gap:5px;font-size:11px;font-weight:500;color:#b6bdc2;line-height:14px;font-variant-numeric:tabular-nums}.audience svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.6}.audience #audienceElapsed{margin-left:7px}.windowtop h1{font-size:15px;font-weight:700;line-height:20px;text-align:left;margin:0}.iconbtn{width:30px;height:30px;padding:5px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;background:transparent;border:0;border-radius:4px;color:#e7e9ea;text-decoration:none}.iconbtn svg{width:20px;height:20px;fill:currentColor}.connect{display:flex;gap:8px;padding:0 0 8px}.connect input{min-width:0;width:100%;background:#000000;color:#e7e9ea;border:1px solid #67676b;border-radius:4px;padding:8px;font-size:12px;outline:none}.connect input:focus{border:2px solid #1d9bf0;padding:7px}.primary{border:0;background:#eff3f4;color:#0f1419;border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600}.primary:hover{background:#d7dbdc}.dropdown{position:absolute;top:calc(100% + 4px);left:8px;right:8px;background:#16181c;border:1px solid #353539;border-radius:16px;max-height:min(560px,calc(100dvh - 120px));overflow:auto;z-index:8;box-shadow:0 4px 16px #0009;padding:6px}.group{font-size:11px;color:#ffffff99;padding:12px 8px 6px;font-weight:600}.member{border:0;background:transparent;width:100%;display:flex;align-items:center;gap:8px;padding:7px 8px;text-align:left;border-radius:4px}.member:hover,.member.active{background:#ffffff14}.member .avatar{width:28px;height:28px}.member strong{font-size:12px}.member small{font-size:10px}.settings{position:absolute;top:142px;bottom:auto;right:8px;z-index:6;width:300px;max-width:calc(100% - 16px);padding:16px;background:#16181c;border-radius:16px;box-shadow:0 0 15px #ffffff12;display:flex;flex-direction:column;gap:16px}.settings h2{font-size:14px;font-weight:600;margin:0 0 2px;padding-bottom:12px;border-bottom:1px solid var(--border)}.settings label{display:flex;align-items:center;justify-content:space-between;font-size:13px;gap:12px}.settings input{accent-color:#1d9bf0}.settings select{max-width:170px;background:#000000;color:#e7e9ea;border:1px solid #67676b;border-radius:4px;padding:5px;font-size:12px}.settings p{margin:0;color:#ffffff99;font-size:11px;line-height:1.6}.stream{padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0;background:#16181c}.streamtop{display:flex;gap:8px;align-items:center;font-size:11px;color:#ffffff99}.pill{font-size:10px;font-weight:600;color:#ffffff99}.stream h2{font-size:13px;font-weight:600;margin:5px 0}.stream small{font-size:11px;color:#ffffff99}.messages{flex:1;min-height:0;overflow:auto;overflow-anchor:none;overflow-wrap:anywhere;padding:8px 12px 10px;scrollbar-width:thin;scrollbar-color:#69696c transparent}.message{font-size:14px;line-height:20px;padding:4px 6px;min-height:28px;word-break:break-word}.message-media{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}.message-media img{display:block;max-width:120px;max-height:90px;object-fit:contain;border-radius:6px}@media(hover:hover){.message:hover{background:rgba(255,255,255,.07);border-radius:10px}}.message b{font-weight:500;margin-right:8px;color:var(--nick-color,#1d9bf0)}.message time{font-size:12px;color:#ffffff99;margin-right:8px;white-space:nowrap}.notice{padding:4px 6px;color:#ffffff99;font-size:13px;line-height:20px}.error{color:#ff8280}.tools{min-height:40px;height:40px;flex-shrink:0;display:flex;align-items:center;gap:4px;padding:4px 8px;background:#000000}.tools #connection{font-size:11px;color:#ffffff99;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}.toolbar-actions{margin-left:auto;display:flex;align-items:center;gap:2px}.welcome{padding:4px 16px;color:#ffffff99;font-size:13px;line-height:20px}.welcome p{margin:0}@media(max-width:360px){.status{font-size:10px}.tools #connection{font-size:10px}}
.zoom-controls{display:flex;align-items:center;gap:4px}.zoom-controls .iconbtn{width:24px;height:24px;font-size:18px;color:#ffffff99}.zoom-controls #zoomout,.zoom-controls #zoomin{background:transparent;border-radius:50%}.zoom-controls #zoomout:hover,.zoom-controls #zoomin:hover{background:#181818}.zoom-controls #zoomlevel{font-size:12px;color:#b4b8bf;min-width:32px;text-align:center}.audience{display:flex;align-items:center;justify-content:flex-start;gap:5px;font-size:11px;font-weight:500;color:#b6bdc2;line-height:14px;font-variant-numeric:tabular-nums}.audience svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.6}.audience #audienceElapsed{margin-left:7px}.windowtop h1{position:static;text-align:left;white-space:nowrap;pointer-events:none}.zoom-controls{grid-column:2}.windowtop #gear{grid-column:3;color:#b6bdc2}.chat-heading{min-width:0;display:flex;flex-direction:column;gap:3px}.chat-heading h1{margin:0}.settings{border:1px solid #ffffff26}.choose .identity small{color:#ffffff99}.x-mark{display:flex;align-items:center;justify-content:center;color:#e7e9ea}.x-mark svg{width:18px;height:18px}.windowtop{padding:0 12px}.choose{padding:10px 8px}.tools{border-top:1px solid #16181c}.iconbtn{border-radius:50%}.choose .identity small{margin-top:2px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.settings h2{font-size:16px}.settings label{color:#e7e9ea}@media(max-width:360px){.windowtop{padding:0 10px;gap:5px}.audience{display:flex;align-items:center;justify-content:flex-start;gap:5px;font-size:11px;font-weight:500;color:#b6bdc2;line-height:14px;font-variant-numeric:tabular-nums}.audience svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.6}.audience #audienceElapsed{margin-left:7px}.windowtop h1{font-size:14px}.zoom-controls{gap:2px}.status{padding:4px 6px}.tools .iconbtn{width:26px;height:28px}}.status{display:inline-flex;align-items:center;gap:5px}.status::before{content:"●";font-size:9px}.status.unknown::before{content:"";display:block;width:11px;height:11px;flex-shrink:0;background:conic-gradient(from 0deg,#8b98a520,#8b98a5);mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%280%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%2830%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%2860%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%2890%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%28120%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%28150%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%28180%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%28210%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%28240%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%28270%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%28300%2012%2012%29%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%221%22%20width%3D%222%22%20height%3D%225%22%20rx%3D%221%22%20transform%3D%22rotate%28330%2012%2012%29%22%2F%3E%3C%2Fsvg%3E") center/contain no-repeat;animation:status-spin 1s steps(12) infinite}@keyframes status-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.status.unknown::before{animation:none}}#popup{display:none}@media (hover:hover) and (pointer:fine){#popup{display:inline-flex}}body.popup #popup{display:none}
 .resume-chat{position:absolute;z-index:3;bottom:52px;left:14px;right:14px;display:flex;align-items:center;gap:12px;min-height:32px;padding:6px 10px;border:0;border-radius:10px;background:#202327;color:#e7e9ea;box-shadow:0 3px 14px #0006;text-align:left;cursor:pointer;font:inherit}.resume-chat[hidden]{display:none}.resume-chat:hover{background:#2b2f33}.resume-chat span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.resume-chat b{color:var(--nick-color);font-weight:700;margin-right:8px}.resume-chat svg{width:20px;height:20px;flex-shrink:0;fill:none;stroke:#8b98a5;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

html[data-theme="light"]{color-scheme:light;--bg:#fff;--text:#0f1419;--muted:#536471;--border:#0f141926}
html[data-theme="light"] body,html[data-theme="light"] .chatwindow,html[data-theme="light"] .selector,html[data-theme="light"] .windowtop,html[data-theme="light"] .tools{background:#fff;color:#0f1419}
html[data-theme="light"] .choose{border-color:#0f141926}html[data-theme="light"] button:hover{background:#0f14190a}
html[data-theme="light"] .dropdown,html[data-theme="light"] .settings,html[data-theme="light"] .stream{background:#f7f9f9;border-color:#cfd9de;color:#0f1419;box-shadow:0 4px 16px #0f141914}
html[data-theme="light"] .identity small,html[data-theme="light"] .chevron,html[data-theme="light"] .group,html[data-theme="light"] .audience,html[data-theme="light"] .zoom-controls #zoomlevel,html[data-theme="light"] .zoom-controls .iconbtn,html[data-theme="light"] .windowtop #gear,html[data-theme="light"] .message time,html[data-theme="light"] .notice,html[data-theme="light"] .welcome,html[data-theme="light"] .stream small,html[data-theme="light"] .streamtop,html[data-theme="light"] .tools #connection{color:#536471}
html[data-theme="light"] .settings label{color:#0f1419}html[data-theme="light"] .iconbtn{color:#0f1419}html[data-theme="light"] .status:not(.live){background:#eff3f4;color:#536471}
html[data-theme="light"] .member:hover,html[data-theme="light"] .member.active,html[data-theme="light"] .message:hover{background:#0f14190a}
html[data-theme="light"] .resume-chat{background:#eff3f4;color:#0f1419;box-shadow:0 3px 14px #0f14191a}html[data-theme="light"] .resume-chat:hover{background:#e6e9eb}
html[data-theme="light"] .message b,html[data-theme="light"] .resume-chat b{color:var(--nick-color-light,#536471)}
html[data-theme="light"] .avatar-live{box-shadow:0 0 0 2px #fff,0 0 0 4px #7856ff}html[data-theme="light"] .space-badge{box-shadow:0 0 0 2px #fff}
body.hide-chat-images .message-media{display:none!important}

/* Footer labels remain available without relying on the browser title tooltip. */
.tools .iconbtn[aria-label]{position:relative;overflow:visible}
.tools .iconbtn[aria-label]::after{content:attr(aria-label);position:absolute;right:0;bottom:calc(100% + 8px);z-index:12;max-width:calc(100vw - 24px);width:max-content;padding:3px 6px;border:0;border-radius:2px;background:rgba(73,91,105,.95);color:#fff;box-shadow:none;font-size:11px;font-weight:400;line-height:16px;white-space:nowrap;pointer-events:none;opacity:0;visibility:hidden;transform:translateY(3px);transition:opacity .12s ease,transform .12s ease,visibility 0s .12s}
.tools>.iconbtn[aria-label]::after{left:0;right:auto}
.tools .iconbtn[aria-label]:hover::after,.tools .iconbtn[aria-label]:focus-visible::after{opacity:1;visibility:visible;transform:translateY(0);transition-delay:.25s}
@media(prefers-reduced-motion:reduce){.tools .iconbtn[aria-label]::after{transform:none;transition:none}}
/* Compact chat surfaces, using X web colors and control shapes. */
:root{--muted:#71767b;--border:#2f3336;--surface:#000;--hover:rgba(231,233,234,.08);--menu-shadow:0 0 15px rgba(255,255,255,.16),0 0 3px 1px rgba(255,255,255,.08)}
html[data-theme="light"]{--muted:#536471;--border:#eff3f4;--surface:#fff;--hover:rgba(15,20,25,.04);--menu-shadow:0 0 15px rgba(101,119,134,.2),0 0 3px 1px rgba(101,119,134,.15)}
.selector{padding:0 8px;border-bottom-color:var(--border)}
.choose{min-height:60px;padding:8px 10px;gap:10px;border-radius:16px;transition:background-color .15s ease}
.choose .avatar{margin:2px}.identity strong{font-size:14px;line-height:20px}.choose .identity small{font-size:12px;line-height:16px;margin-top:0}
.windowtop{min-height:48px;padding:6px 12px;gap:6px;flex-shrink:0;background:var(--bg);border-bottom-color:var(--border)}
.windowtop h1{font-size:14px;line-height:18px;letter-spacing:-.2px}.chat-heading{gap:2px}.audience{font-size:11px;line-height:14px}
.zoom-controls .iconbtn{width:26px;height:26px}.zoom-controls #zoomlevel{font-size:11px;min-width:30px}.windowtop #gear{width:28px;height:28px}
.iconbtn{border-radius:999px;transition:background-color .15s ease,color .15s ease}
.iconbtn:hover,.zoom-controls #zoomout:hover,.zoom-controls #zoomin:hover,html[data-theme="light"] .iconbtn:hover{background:rgba(29,155,240,.1);color:#1d9bf0}
.choose .identity small,.identity small,.chevron,.group,.audience,.zoom-controls .iconbtn,.zoom-controls #zoomlevel,.windowtop #gear,.message time,.notice,.welcome,.streamtop,.stream small,.pill{color:var(--muted)}
.dropdown,html[data-theme="light"] .dropdown{padding:4px 0;background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--menu-shadow)}
.group{padding:14px 16px 6px;font-size:11px;letter-spacing:.4px;font-weight:700}.member{padding:10px 14px;border-radius:0;min-height:54px}.member strong{font-size:13px}.member small{font-size:11px}.member:hover,.member.active,html[data-theme="light"] .member:hover,html[data-theme="light"] .member.active{background:var(--hover)}
.settings,html[data-theme="light"] .settings{top:124px;padding:0;gap:0;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:16px;box-shadow:var(--menu-shadow);overflow:hidden}
.settings h2{font-size:14px;font-weight:700;padding:14px 16px 10px;margin:0;border-bottom:1px solid var(--border)}
.settings label,html[data-theme="light"] .settings label{padding:12px 16px;min-height:46px;font-size:13px;color:var(--text);cursor:pointer}.settings label:hover{background:var(--hover)}.settings select{background:var(--surface);color:var(--text);border-color:var(--border)}.settings input{width:17px;height:17px;margin:0;flex-shrink:0;accent-color:#1d9bf0}
.messages{padding:8px 10px 10px;scrollbar-color:var(--muted) transparent}.welcome{padding:6px 6px;font-size:12px;color:var(--muted)}.notice{font-size:12px;color:var(--muted)}.message{border-radius:8px}.message b{font-weight:600}.message-media img{border:1px solid var(--border);border-radius:12px}
.tools,html[data-theme="light"] .tools{border-top:1px solid var(--border);min-height:38px;height:38px;padding:3px 8px}.tools .iconbtn{width:28px;height:28px;color:var(--muted)}
.stream,html[data-theme="light"] .stream{background:var(--surface);border-bottom-color:var(--border);padding:10px 16px}.stream h2{font-size:14px;line-height:20px;margin:5px 0 0}
.resume-chat,html[data-theme="light"] .resume-chat{bottom:48px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text);box-shadow:var(--menu-shadow)}
html[data-theme="light"] .choose{border-color:#cfd9de}
@media(max-width:360px){.windowtop{padding:6px 10px;gap:4px}.zoom-controls{gap:1px}.windowtop h1{font-size:14px}}
@media(prefers-reduced-motion:reduce){.iconbtn,.choose{transition:none}}

#feedbackDialog{width:360px;max-width:calc(100vw - 32px);margin:auto;padding:20px;border:1px solid var(--border);border-radius:16px;background:var(--surface,var(--bg));color:var(--text);box-shadow:var(--menu-shadow)}
#feedbackDialog::backdrop{background:rgba(91,112,131,.4)}.feedback-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.feedback-head h2{font-size:17px;line-height:24px;margin:0;font-weight:700}#feedbackClose{font-size:25px}#feedbackDialog p{font-size:13px;color:var(--muted);margin:12px 0}
#broadcastToasts{position:fixed;z-index:30;bottom:76px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;width:max-content;max-width:calc(100% - 28px);pointer-events:none;user-select:none}#broadcastToasts *{pointer-events:none!important}.broadcast-toast{animation:broadcast-toast-fade 3s both;display:flex;align-items:center;gap:6px;padding:7px 12px;font-weight:400;border:0;border-radius:8px;color:#c9cdd1;background:rgba(32,35,39,.9);backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:none;font-size:12px;line-height:18px}.broadcast-toast .avatar{width:18px;height:18px;margin:0;background:transparent;flex-shrink:0}html[data-theme="light"] .broadcast-toast{background:rgba(32,35,39,.9);color:#c9cdd1}

#ratingDialog{width:400px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);overflow:auto;margin:auto;padding:32px;border:0;border-radius:16px;background:var(--rating-paper);color:var(--text);box-shadow:none;text-align:center;--rating-ink:#fff;--rating-paper:#131313;--rating-tertiary:#606060;--rating-outline:#383838}html[data-theme="light"] #ratingDialog{--rating-ink:#000;--rating-paper:#fff;--rating-tertiary:#a0a0a0;--rating-outline:#d7dbdc}#ratingDialog::backdrop{background:rgba(0,0,0,.15);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}#ratingAvatar{display:inline-grid;width:40px;height:40px;margin:0 0 24px}.rating-title{margin:0;color:var(--rating-ink);font-size:22px;line-height:30px;font-weight:700;word-break:keep-all}.rating-question{color:var(--rating-tertiary);font-size:14px;line-height:21px;margin:12px 0 16px}.rating-stars{display:flex;justify-content:center;gap:2px;margin:0;padding:0;border:0}.rating-stars label{display:grid;place-items:center;width:44px;height:44px;cursor:pointer;position:relative}.rating-stars input{position:absolute;opacity:0;width:1px;height:1px}.rating-stars span{font-size:32px;line-height:1;color:var(--rating-ink)}.rating-stars label:has(input:focus-visible){outline:2px solid #1d9bf0;outline-offset:1px;border-radius:6px}#ratingStatus{font-size:12px;line-height:18px;color:var(--muted);margin:12px 0}#ratingStatus:empty{display:none}.rating-actions{display:flex;flex-direction:column;gap:10px;margin-top:24px}.rating-actions button{width:100%;min-height:44px;padding:10px 20px;border-radius:999px;font-size:15px;line-height:22px;font-weight:700}.rating-confirm{border:1px solid var(--rating-ink);background:var(--rating-ink);color:var(--rating-paper)}.rating-confirm:hover{background:var(--rating-ink);filter:brightness(.9)}.rating-skip{border:1px solid var(--rating-outline);background:var(--rating-paper);color:var(--rating-ink)}.rating-skip:hover{background:var(--hover)}@media(max-width:380px){#ratingDialog{padding:28px 24px}.rating-title{font-size:20px;line-height:28px}}#ratingDialog[open]{animation:rating-dialog-enter 240ms cubic-bezier(.16,1,.3,1) both}#ratingDialog[open]::backdrop{animation:rating-backdrop-enter 240ms ease-out both}@keyframes rating-dialog-enter{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}@keyframes rating-backdrop-enter{from{opacity:0}to{opacity:1}}@media(prefers-reduced-motion:reduce){#ratingDialog[open],#ratingDialog[open]::backdrop{animation:none}}#ratingDialog.motion-disabled[open],#ratingDialog.motion-disabled[open]::backdrop{animation:none}

@keyframes broadcast-toast-fade{0%{opacity:0}7%,87%{opacity:1}100%{opacity:0}}@media(prefers-reduced-motion:reduce){.broadcast-toast{animation:none}}
#feedbackText{font:inherit;color:var(--text);background:transparent;width:100%;min-height:130px;max-height:40dvh;resize:vertical;border:1px solid var(--border);border-radius:8px;padding:12px;line-height:1.6}#feedbackText:focus{outline:2px solid #1d9bf0;outline-offset:-1px}.feedback-bottom{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}.feedback-urgent{display:flex;align-items:center;gap:6px;font-size:13px;white-space:nowrap}.feedback-urgent input{accent-color:#1d9bf0}#feedbackStatus{flex:1;font-size:12px;line-height:18px;color:var(--muted)}#feedbackSend{background:#1d9bf0;color:#fff;min-width:64px;padding:8px 16px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
</style><main><section class="chatwindow" aria-label="스페이스 채팅">
<div class="selector"><button class="choose" id="choose" aria-expanded="false" aria-controls="dropdown"><span id="selectedAvatar" class="avatar"></span><span class="identity"><strong id="selectedName">강지</strong><small id="selectedHandle">@GANGZIIII</small></span><span class="status unknown" id="selectedStatus">확인 중</span><svg class="chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="m5 7 5 5 5-5 1.4 1.4L10 14.8 3.6 8.4z"/></svg></button><div id="dropdown" class="dropdown" hidden></div></div>
<div class="windowtop"><div class="chat-heading"><h1>스페이스 채팅</h1><span id="audience" class="audience" hidden><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6" r="3.5"/><path d="M2 18v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/></svg><span id="audienceCount"></span><span id="audienceElapsed" hidden></span></span></div><div class="zoom-controls"><button class="iconbtn" id="zoomout" aria-label="채팅 글자 축소" title="채팅 글자 축소">−</button><span id="zoomlevel">100%</span><button class="iconbtn" id="zoomin" aria-label="채팅 글자 확대" title="채팅 글자 확대">+</button></div><button class="iconbtn" id="gear" title="채팅 설정" aria-label="채팅 설정" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="4" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="10" cy="16" r="1.4"/></svg></button></div>
<div class="stream" id="stream" hidden><div class="streamtop"><span class="pill" id="state">SPACE</span><span id="streamHandle">@HanayoHiyori</span><span id="listeners" hidden style="margin-left:auto"></span></div><h2 id="title">스페이스를 확인하고 있어요</h2><small id="streamInfo" hidden>공유 게시물 답글 · 자동 주기로 확인</small></div>
<div class="messages" id="messages" role="log" aria-live="polite" aria-label="채팅 메시지"><div class="welcome">채팅방에 오신 것을 환영합니다! 스페라이브는 아직 베타 버전이에요. 채팅 오류나 피드백이 있으면 좌측 하단에 있는 피드백 버튼을 눌러주세요.</div></div>
<div class="settings" id="settings" hidden><h2>채팅 설정</h2><label>테마<select id="chatTheme"><option value="system">시스템 설정</option><option value="light">라이트</option><option value="dark">다크</option></select></label><label>이미지 표시<input type="checkbox" id="showImages" checked></label><label>시간 표시<input type="checkbox" id="timestamps" checked></label><label>애니메이션 끄기<input type="checkbox" id="disableAnimation"></label></div>
<button id="resumeChat" class="resume-chat" hidden aria-label="최신 채팅으로 이동하고 자동 스크롤 켜기"><span id="latestChatPreview"><b id="latestChatName"></b><span id="latestChatText">최신 채팅으로 이동</span></span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7 5 5 5-5"/></svg></button>
<div class="tools"><button class="iconbtn" id="feedbackOpen" aria-label="개발자에게 피드백 보내기" aria-haspopup="dialog"><svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H8l-5 2v-7a8.5 8.5 0 0 1 8.5-12H13"/><path d="m15 5 3 3M11 12l1-4 6-6 3 3-6 6-4 1Z"/></svg></button><span id="connection" hidden>○ 연결 대기</span><div class="toolbar-actions"><a class="iconbtn" id="external" href="https://x.com/HanayoHiyori" target="_blank" rel="noopener" title="X에서 열기" aria-label="X에서 열기"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 2h7v7h-2V5.4l-7.3 7.3-1.4-1.4L14.6 4H11V2ZM3 4h5v2H4v10h10v-4h2v5l-1 1H3l-1-1V5l1-1Z"/></svg></a><button class="iconbtn" id="popup" title="팝업으로 열기" aria-label="팝업으로 열기"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 2h16v16H2V2Zm2 2v12h12V4H4Zm4 3h6v6H8V7Z"/></svg></button><button class="iconbtn" id="infotoggle" title="방송 정보" aria-label="방송 정보" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM3 19v-4a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v4h-2v-4a3 3 0 0 0-3-3H8a3 3 0 0 0-3 3v4H3Z"/></svg></button></div></div>
</section></main><div id="broadcastToasts" role="status" aria-live="polite" aria-atomic="false"></div><dialog id="ratingDialog" aria-labelledby="ratingTitle" aria-describedby="ratingQuestion"><form id="ratingForm"><span id="ratingAvatar" class="avatar rating-avatar"></span><h2 id="ratingTitle" class="rating-title"></h2><p id="ratingQuestion" class="rating-question">이번 방송, 연결 상태는 어땠나요?</p><div class="rating-stars" role="radiogroup" aria-label="연결 상태 별점"><label title="1점"><input type="radio" name="broadcastRating" value="1" aria-label="1점"><span aria-hidden="true">☆</span></label><label title="2점"><input type="radio" name="broadcastRating" value="2" aria-label="2점"><span aria-hidden="true">☆</span></label><label title="3점"><input type="radio" name="broadcastRating" value="3" aria-label="3점"><span aria-hidden="true">☆</span></label><label title="4점"><input type="radio" name="broadcastRating" value="4" aria-label="4점"><span aria-hidden="true">☆</span></label><label title="5점"><input type="radio" name="broadcastRating" value="5" aria-label="5점"><span aria-hidden="true">☆</span></label></div><p id="ratingStatus" role="status" aria-live="polite"></p><div class="rating-actions"><button class="rating-confirm" id="ratingSend" type="submit" disabled>확인</button><button class="rating-skip" id="ratingSkip" type="button" autofocus>건너뛰기</button></div></form></dialog><dialog id="feedbackDialog" aria-labelledby="feedbackTitle"><form id="feedbackForm"><div class="feedback-head"><h2 id="feedbackTitle">개발자에게 피드백 보내기</h2><button class="iconbtn" id="feedbackClose" type="button" aria-label="닫기">×</button></div><label for="feedbackText" class="sr-only">피드백 내용</label><textarea id="feedbackText" maxlength="1000" required rows="5"></textarea><div class="feedback-bottom"><label class="feedback-urgent"><input id="feedbackUrgent" type="checkbox">긴급</label><span id="feedbackStatus" role="status" aria-live="polite"></span><button class="primary" id="feedbackSend" type="submit">전송</button></div></form></dialog><script>
const groups=${JSON.stringify(members)};
const initialMemberStates=[];
const realtimeOrigin='';
const stripLeadingMentions=${stripLeadingMentions.toString()};
const memberFromPath=${memberFromPath.toString()};
const firstLiveMember=${firstLiveMember.toString()};
const avatars={"GANGZIIII":"https://pbs.twimg.com/profile_images/2079577190120017921/5IQ_nY3z_200x200.jpg","ShizukiToa_":"https://pbs.twimg.com/profile_images/2109194861454991360/gmbvYD-8_normal.jpg","AyatsunoYuni": "https://pbs.twimg.com/profile_images/2106898417473765378/EWJt3rQG_normal.jpg", "SakihaneHuya": "https://pbs.twimg.com/profile_images/2112914105988534273/12E-Bd8C_normal.jpg", "NenekoMashiro": "https://pbs.twimg.com/profile_images/2093138069209919488/M_Ckz81n_normal.jpg", "ArahashiTabi": "https://pbs.twimg.com/profile_images/2109951512793550848/9gKe9qj0_normal.jpg", "ShirayukiHina_": "https://pbs.twimg.com/profile_images/2096096251553198081/V2oCybbe_normal.jpg", "AkaneLize": "https://pbs.twimg.com/profile_images/2094140237320740864/Kyx-TSwi_normal.jpg", "AokumoRin": "https://pbs.twimg.com/profile_images/2112495217878466560/JxqyWCpf_normal.jpg", "TenkoShibuki": "https://pbs.twimg.com/profile_images/2110747276453003264/2gSgV1C9_normal.jpg", "HanakoNana_": "https://pbs.twimg.com/profile_images/2012139881682886656/MYD8iYpq_normal.jpg", "YuzuhaRiko": "https://pbs.twimg.com/profile_images/2081257497386696704/Onv3oD96_normal.jpg", "CoganeRang": "https://pbs.twimg.com/profile_images/2109194867054456832/NCvLV-QW_normal.jpg", "HanayoHiyori": "https://pbs.twimg.com/profile_images/2109194867427700736/7FOyJX35_normal.jpg", "TokinoMary": "https://pbs.twimg.com/profile_images/2109237456528871424/3BXtLoxe_200x200.jpg"};
let cachedAvatarUrls={};try{cachedAvatarUrls=JSON.parse(localStorage.getItem('chatAvatarUrls')||'{}');}catch{}
const avatarImages=new Map(),avatarRequests=new Map();
const fontSizes=[14,16,18];let fontIndex=0;
const $=id=>document.getElementById(id);let selected=memberFromPath(location.pathname,groups)||'GANGZIIII',statuses=Object.fromEntries(Object.entries(avatars).map(([handle,avatar])=>[handle,{avatar:cachedAvatarUrls[handle]||avatar,status:'unknown',...initialMemberStates.find(s=>s.handle===handle)}])),room=null,cursor=0,latestHistoryReady=false,generation=0,seen=new Set(),auto=true,poll=null,nextPollMs=500,connecting=false,rootPending=false;
let roomCollectionStopped=false,chatRequestGeneration=null,memberUpdateVersion=0;
function createRealtimeTransport({origin,onMembers,onRoom,onState,WebSocketImpl=globalThis.WebSocket,setTimer=setTimeout,clearTimer=clearTimeout,isHidden=()=>document.hidden,random=Math.random}){
 let socket=null,retry=null,opening=null,heartbeat=null,pongDeadline=null,attempt=0,subscription=null,stopped=false;
 const connected=()=>socket?.readyState===1;
 function suspendChecks(){clearTimer(heartbeat);clearTimer(pongDeadline);heartbeat=pongDeadline=null;}
 function ping(){if(!connected()||isHidden()||pongDeadline!==null)return;const current=socket;try{current.send('ping');pongDeadline=setTimer(()=>{pongDeadline=null;disconnect(current);},10000);}catch{disconnect(current);}}
 function alive(){suspendChecks();if(connected()&&!isHidden())heartbeat=setTimer(()=>{heartbeat=null;ping();},25000);}
 function sendSubscription(){if(connected())socket.send(JSON.stringify({type:'subscribe',postId:subscription?.postId||null,after:subscription?.after||0}));}
 function reconnect(){if(stopped||retry!==null||isHidden())return;const delay=Math.min(15000,1000*2**Math.min(attempt++,4))*(.8+.2*random());retry=setTimer(()=>{retry=null;connect();},delay);}
 function disconnect(current){if(socket!==current)return;clearTimer(opening);opening=null;suspendChecks();socket=null;onState(false);current.close();reconnect();}
 function connect(){
  if(stopped||isHidden()||socket||!WebSocketImpl)return;
  if(retry!==null){clearTimer(retry);retry=null;}
  try{const url=new URL('/api/live',origin);url.protocol=url.protocol==='https:'?'wss:':'ws:';const current=new WebSocketImpl(url.href);socket=current;
   opening=setTimer(()=>{if(current.readyState!==1)disconnect(current);},10000);
   current.onopen=()=>{if(socket!==current)return;clearTimer(opening);opening=null;attempt=0;alive();sendSubscription();onState(true);};
   current.onmessage=event=>{if(socket!==current)return;if(event.data==='pong'){alive();return;}try{const value=JSON.parse(event.data);if(value.type==='members'&&Array.isArray(value.members)){alive();onMembers(value.members);}else if(value.type==='room'&&subscription&&String(value.postId)===subscription.postId&&Array.isArray(value.data?.messages)){alive();onRoom(value.data,value.postId);}else if(value.type==='error')current.close();}catch{}};
   current.onerror=()=>disconnect(current);
   current.onclose=()=>disconnect(current);
  }catch{socket=null;onState(false);reconnect();}
 }
 function pause(){clearTimer(retry);clearTimer(opening);retry=opening=null;suspendChecks();const current=socket;socket=null;current?.close();}
 return{get connected(){return connected();},start:connect,resume(){if(stopped)return;if(connected()){suspendChecks();ping();}else connect();},pause,suspendChecks,setRoom(postId,after=0,force=false){const next=postId?{postId:String(postId),after:Math.max(0,Number(after)||0)}:null;if(!force&&subscription?.postId===next?.postId&&subscription?.after===next?.after)return;subscription=next;sendSubscription();},advance(after){if(subscription)subscription.after=Math.max(subscription.after,Number(after)||0);},close(){stopped=true;pause();}};
}
const realtime=realtimeOrigin?createRealtimeTransport({origin:realtimeOrigin,onMembers:members=>{memberUpdateVersion++;void applyMemberStates(members).catch(()=>{});},onRoom:(data,postId)=>{if(String(room?.tweet)!==String(postId))return;const more=applyRoomData(data,generation,false);realtime.advance(cursor);if(more)realtime.setRoom(postId,cursor,true);},onState:connected=>{if(connected){if(latestHistoryReady)clearTimeout(poll);}else if(room?.tweet&&!roomCollectionStopped)scheduleChatPoll(generation,1500);}}):null;
function scheduleChatPoll(g,delay=5000,catchup=false){clearTimeout(poll);if(g!==generation||!room?.tweet||(realtimeOrigin&&(document.hidden||(!catchup&&realtime.connected))))return;poll=setTimeout(()=>tick(g),delay);}
// Source: https://abs.twimg.com/x-web/x-web/assets/icon-spaces-fill-dkNkOItq.js
const spacesIcon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M22.4 14.26a10.75 10.75 0 0 1-20.8 0l1.94-.52a8.75 8.75 0 0 0 16.92 0z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M12 1.75a7 7 0 0 1 7 7v2.75a7 7 0 0 1-13.99.36V8.75a7 7 0 0 1 7-7M11.1 13h1.8V7h-1.8zm-3-1h1.8V8H8.1zm6 0h1.8V8h-1.8z"/></svg>';
function safeAvatarUrl(url){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='pbs.twimg.com'&&u.pathname.startsWith('/profile_images/')?u.href:null;}catch{return null;}}
function loadAvatar(url){if(avatarRequests.has(url))return avatarRequests.get(url);const pending=new Promise((resolve,reject)=>{const img=new Image();img.className='avatar-photo';img.onload=()=>{avatarImages.set(url,img);resolve(img);};img.onerror=()=>{avatarRequests.delete(url);reject(Error('프로필 이미지 로딩 실패'));};img.src=url;});avatarRequests.set(url,pending);return pending;}
function avatar(el,name,url,live=false,key=name){
 el.className='avatar'+(live?' avatar-live':'');
 if(el._avatarKey!==key){el.replaceChildren();el._avatarKey=key;el._avatarUrl=null;el._avatarPhoto=null;el._avatarBadge=null;}
 const target=safeAvatarUrl(url),previous=safeAvatarUrl(cachedAvatarUrls[key]);el._avatarRequested=target;
 const show=(image,src)=>{if(el._avatarKey!==key)return;const photo=image.cloneNode();photo.alt=name+' 프로필';if(el._avatarPhoto)el._avatarPhoto.replaceWith(photo);else el.append(photo);el._avatarPhoto=photo;el._avatarUrl=src;};
 if(!el._avatarUrl&&previous&&previous!==target){const prior=avatarImages.get(previous);if(prior)show(prior,previous);else loadAvatar(previous).then(image=>{if(el._avatarKey===key&&!el._avatarUrl)show(image,previous);}).catch(()=>{});}
 if(target&&el._avatarUrl!==target){const commit=image=>{if(el._avatarKey!==key||el._avatarRequested!==target)return;show(image,target);if(cachedAvatarUrls[key]!==target){cachedAvatarUrls[key]=target;try{localStorage.setItem('chatAvatarUrls',JSON.stringify(cachedAvatarUrls));}catch{}}};const loaded=avatarImages.get(target);if(loaded)commit(loaded);else loadAvatar(target).then(commit).catch(()=>{});}
 if(live&&!el._avatarBadge){const badge=document.createElement('span');badge.className='space-badge';badge.setAttribute('aria-label','Space 방송 중');badge.innerHTML=spacesIcon;el.append(badge);el._avatarBadge=badge;}
 if(!live&&el._avatarBadge){el._avatarBadge.remove();el._avatarBadge=null;}
}

function updateElapsed(data){let start=Number(data?.startedAt);if(start>1e9&&start<1e12)start*=1000;const valid=data?.state==='Running'&&Number.isFinite(start)&&start>0&&start<=Date.now();$('audienceElapsed').hidden=!valid;if(valid){const seconds=Math.floor((Date.now()-start)/1000);$('audienceElapsed').textContent=Math.floor(seconds/3600)+':'+String(Math.floor(seconds/60)%60).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');$('audienceElapsed').setAttribute('aria-label','방송 경과시간 '+$('audienceElapsed').textContent);}}
function updateAudience(data){const count=data?.currentParticipants;const visible=data?.state==='Running'&&Number.isSafeInteger(count)&&count>=0;$('audience').hidden=!visible;$('audienceCount').textContent=visible?Intl.NumberFormat('ko').format(count)+'명 참여 중':'';$('audience').setAttribute('aria-label',visible?'현재 참여자 '+Intl.NumberFormat('ko').format(count)+'명':'');$('listeners').textContent=visible?Intl.NumberFormat('ko').format(count)+'명 참여 중':'';updateElapsed(data);}

function label(s){return s==='live'?'방송 중':s==='offline'?'오프라인':'확인 중';}
function render(){ $('dropdown').replaceChildren();groups.forEach((g,i)=>{if(g[0]){const title=document.createElement('div');title.className='group';title.textContent=i+'기생 · '+g[1];$('dropdown').append(title);}g[2].forEach(([name,handle])=>{const b=document.createElement('button');b.className='member'+(handle===selected?' active':'');const a=document.createElement('span');a.className='avatar';avatar(a,name,statuses[handle]?.avatar,statuses[handle]?.status==='live',handle);const n=document.createElement('span');n.className='identity';const strong=document.createElement('strong');strong.textContent=name;const small=document.createElement('small');small.textContent='@'+handle;n.append(strong,small);const s=document.createElement('span');s.className='status '+(statuses[handle]?.status||'unknown');s.textContent=label(statuses[handle]?.status);b.append(a,n,s);b.onclick=()=>select(name,handle,i);$('dropdown').append(b);});});updateSelected();}
const broadcastToastStates=new Map(initialMemberStates.filter(s=>s.state==='Running'||s.state==='Ended'||s.status==='offline').map(s=>[s.handle,{...s}])),broadcastToastSeen=new Set();
function showBroadcastToast(handle,started,photo){const member=groups.flatMap(g=>g[2]).find(m=>m[1]===handle);if(!member)return;const layer=document.getElementById('broadcastToasts');if(!layer)return;const toast=document.createElement('div');toast.className='broadcast-toast';if(started){const picture=document.createElement('span');picture.className='avatar';avatar(picture,member[0],photo||statuses[handle]?.avatar,false,handle);toast.append(picture);}const text=document.createElement('span');text.textContent=member[0]+(started?'의 방송이 시작되었습니다!':'의 방송이 종료되었습니다.');toast.append(text);layer.append(toast);while(layer.children.length>3)layer.firstElementChild.remove();setTimeout(()=>toast.remove(),3000);}
function broadcastToastEvent(handle,space,started,photo){const key=handle+':'+(space||'unknown')+':'+started;if(broadcastToastSeen.has(key))return;broadcastToastSeen.add(key);if(started)showBroadcastToast(handle,true,photo);else showBroadcastRating(handle,space,photo);}
function observeBroadcastState(next){if(next.stale||next.status==='unknown'||!['live','offline'].includes(next.status))return;const previous=broadcastToastStates.get(next.handle);if(previous){if(next.status==='live'&&(previous.status!=='live'||(next.space&&previous.space&&next.space!==previous.space)))broadcastToastEvent(next.handle,next.space,true,next.avatar);else if(next.handle===selected&&previous.status==='live'&&next.state==='Ended'&&(!previous.space||!next.space||previous.space===next.space))broadcastToastEvent(next.handle,next.space||previous.space,false,next.avatar||previous.avatar);}broadcastToastStates.set(next.handle,{...next});}
let ratingSession=null;
function updateRatingStars(){const score=ratingSession?.score||0;document.querySelectorAll('input[name="broadcastRating"]').forEach(input=>{input.disabled=!!ratingSession?.sending||!!ratingSession?.sent;const filled=Number(input.value)<=score;input.closest('label').classList.toggle('filled',filled);input.closest('label').querySelector('span').textContent=filled?'★':'☆';});$('ratingSend').disabled=!score||!!ratingSession?.sending;}
function showBroadcastRating(handle,space,photo){const member=groups.flatMap(g=>g[2]).find(m=>m[1]===handle),dialog=$('ratingDialog');if(handle!==selected||!space||!member||!dialog||dialog.open)return;const key='chatBroadcastRating:'+handle+':'+space;try{if(localStorage.getItem(key))return;localStorage.setItem(key,'shown');}catch{}ratingSession={handle,space,postId:statuses[handle]?.tweet||room?.tweet||null,id:crypto.randomUUID(),score:0,sending:false};$('ratingTitle').textContent=member[0]+'의 방송이 종료되었습니다.';avatar($('ratingAvatar'),member[0],photo||statuses[handle]?.avatar,false,handle);$('ratingForm').reset();$('ratingStatus').textContent='';$('ratingSend').textContent='확인';$('ratingSkip').textContent='건너뛰기';updateRatingStars();dialog.classList?.toggle('motion-disabled',!!$('disableAnimation').checked);dialog.showModal();}
function closeBroadcastRating(){$('ratingDialog').close();}
async function submitBroadcastRating(event){event.preventDefault();const session=ratingSession;if(!session?.score||session.sending||session.sent)return;session.sending=true;updateRatingStars();$('ratingStatus').textContent='전송 중…';try{const response=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:session.id,kind:'broadcast-rating',member:session.handle,space:session.space,postId:session.postId,rating:session.score})}),result=await response.json();if(!response.ok)throw Error(result.error||'전송하지 못했습니다. 다시 시도해 주세요.');if(ratingSession!==session)return;try{localStorage.setItem('chatBroadcastRating:'+session.handle+':'+session.space,'sent');}catch{}$('ratingStatus').textContent='평가를 보냈습니다. 감사합니다!';$('ratingSend').textContent='전송 완료';session.sent=true;$('ratingSkip').textContent='닫기';}catch(e){if(ratingSession===session)$('ratingStatus').textContent=e.message;}finally{session.sending=false;if(ratingSession===session){updateRatingStars();if(session.sent)$('ratingSend').disabled=true;}}}
function trackAnalyticsMember(handle){const name=groups.flatMap(g=>g[2]).find(m=>m[1].toLowerCase()===String(handle||'').toLowerCase())?.[0]||'외부 테스트';window.spaceliveMemberName=name;if(typeof window.gtag==='function')window.gtag('set','content_group',name);}
function updateSelected(){const s=statuses[selected];$('selectedStatus').textContent=label(s?.status);$('selectedStatus').className='status '+(s?.status||'unknown');avatar($('selectedAvatar'),$('selectedName').textContent,s?.avatar,s?.status==='live',selected);}
async function select(name,handle,i){
 rootPending=false;$('selectedAvatar').hidden=false;const g=++generation;clearTimeout(poll);room=null;latestHistoryReady=false;roomCollectionStopped=false;cursor=0;realtime?.setRoom(null);connecting=false;seen=new Set();trackAnalyticsMember(handle);history.replaceState(null,'','/'+handle+(document.body.classList.contains('popup')?'?popup=1':''));selected=handle;localStorage.setItem('member',handle);
 $('selectedName').textContent=name;$('selectedHandle').textContent='@'+handle+(groups[i][1]?' · '+groups[i][1]:'');$('dropdown').hidden=true;$('choose').setAttribute('aria-expanded','false');$('streamHandle').textContent='@'+handle;$('external').href='https://x.com/'+handle;$('messages').replaceChildren();notice('채팅방에 오신 것을 환영합니다! 스페라이브는 아직 베타 버전이에요. 채팅 오류나 피드백이 있으면 좌측 하단에 있는 피드백 버튼을 눌러주세요.');updateAudience(null);$('state').textContent='SPACE';render();
 $('connection').textContent='◌ 공유 게시물 확인 중';
 try{
  let s=statuses[handle];
  if(!s?.postUrl){s=await api('/api/member?handle='+encodeURIComponent(handle));if(g!==generation)return;statuses[handle]={...statuses[handle],...s};render();}
  if(s?.postUrl){await connect(s.postUrl);}
  else{$('title').textContent='오프라인';$('connection').textContent=s?.collecting?'◌ 공유 게시물 찾는 중':'○ 연결 대기';if(s?.collecting&&!realtimeOrigin)poll=setTimeout(()=>{if(g===generation)select(name,handle,i);},1000);}
 }catch(e){if(g!==generation)return;$('connection').textContent='○ 공유 게시물 조회 제한';notice(e.message,true);}
}
async function applyMemberStates(a){if(!Array.isArray(a))return;for(const s of a){observeBroadcastState(s);statuses[s.handle]={...statuses[s.handle],...s,status:s.status,avatar:s.avatar||statuses[s.handle]?.avatar};}render();if(rootPending){if(a.some(s=>s.collecting&&!s.checkedAt))return;const handle=firstLiveMember(groups,a)||groups[0][2][0][1];const index=groups.findIndex(group=>group[2].some(m=>m[1]===handle));const member=groups[index][2].find(m=>m[1]===handle);await select(member[0],member[1],index);return;}const current=statuses[selected];if(room&&current?.space===room.id&&current?.state&&current.state!=='Unknown'){room.state=current.state;room.currentParticipants=current.currentParticipants;room.startedAt=current.startedAt??room.startedAt;updateAudience(room);if(current.state==='Ended'&&latestHistoryReady&&(!realtimeOrigin||roomCollectionStopped)){showBroadcastEnded();clearTimeout(poll);$('connection').textContent='○ 종료됨 · 답글 조회 중지 · '+seen.size+'개';}$('state').textContent=current.state==='Running'?'LIVE':current.state==='Ended'?'종료됨':'예정';}if(!connecting&&current?.postUrl&&current.status==='live'&&(!room||room.id!==current.space)){connect(current.postUrl);};}
function showBroadcastEnded(){if(!latestHistoryReady)return;const box=$('messages');let n=box.querySelector('.broadcast-ended');if(!n){n=document.createElement('div');n.className='notice broadcast-ended';n.textContent='방송이 종료되었습니다.';}box.append(n);if(auto)box.scrollTop=box.scrollHeight;}
function notice(text,error=false){const n=document.createElement('div');n.className='notice'+(error?' error':'');n.textContent=text;$('messages').append(n);}
async function api(path){const r=await fetch(realtimeOrigin?new URL(path,realtimeOrigin).href:path,{cache:'no-store',signal:globalThis.AbortSignal?.timeout?.(15000)});const d=await r.json();if(!r.ok){const error=Error(d.error||'연결 실패');error.status=r.status;error.retryAfterMs=Math.max(0,Number(r.headers.get('retry-after'))||0)*1000;throw error;}return d;}
async function connect(input){const g=++generation;clearTimeout(poll);room=null;latestHistoryReady=false;roomCollectionStopped=false;realtime?.setRoom(null);connecting=true;$('connection').textContent='◌ Space 확인 중';$('title').textContent='스페이스를 확인하고 있어요';$('messages').replaceChildren();notice('채팅방에 오신 것을 환영합니다! 스페라이브는 아직 베타 버전이에요. 채팅 오류나 피드백이 있으면 좌측 하단에 있는 피드백 버튼을 눌러주세요.');seen=new Set();auto=true;latestChatPreview=null;updateFollowNotice();cursor=0;try{const r=await api('/api/resolve?url='+encodeURIComponent(input));if(g!==generation)return;if(r.collecting&&!r.id){$('connection').textContent='◌ 공유 게시물 확인 중';connecting=false;poll=setTimeout(()=>{if(g===generation&&!document.hidden)connect(input);},realtimeOrigin?10000:1000);return;}room=r;connecting=false;const groupIndex=groups.findIndex(group=>group[2].some(m=>m[1].toLowerCase()===r.handle?.toLowerCase()));if(groupIndex>=0){const member=groups[groupIndex][2].find(m=>m[1].toLowerCase()===r.handle.toLowerCase());selected=member[1];localStorage.setItem('member',selected);$('selectedName').textContent=member[0];$('selectedHandle').textContent='@'+selected+(groups[groupIndex][1]?' · '+groups[groupIndex][1]:'');}else if(r.handle){selected=r.handle;$('selectedName').textContent=r.handle;$('selectedHandle').textContent='@'+r.handle+' · 테스트 계정';}$('title').textContent=r.title;$('state').textContent=r.state==='Running'?'LIVE':r.state==='Ended'?'종료됨':r.state==='Unknown'?'상태 미확인':'예정';$('streamInfo').textContent=r.state==='Ended'?'종료된 Space · 공개 메시지 기록':'공개 Space · 읽기 전용';$('streamHandle').textContent='@'+r.handle;updateAudience(r);$('external').href=r.tweet?'https://x.com/'+r.handle+'/status/'+r.tweet:'https://x.com/i/spaces/'+r.id;statuses[r.handle]={...statuses[r.handle],status:r.state==='Running'?'live':r.state==='Ended'?'offline':'unknown',avatar:r.avatar,space:r.state==='Running'?r.id:undefined};render();trackAnalyticsMember(selected);history.replaceState(null,'',groupIndex>=0?'/'+selected+(document.body.classList.contains('popup')?'?popup=1':''):'/?space='+r.id+(r.tweet?'&post='+r.tweet:'')+(document.body.classList.contains('popup')?'&popup=1':''));$('streamInfo').textContent=realtimeOrigin?'공유 게시물 답글 · 실시간 연결':'공유 게시물 답글 · 자동 주기로 확인';if(!r.tweet){notice('방송 상태는 연결됐습니다. 답글을 읽으려면 이 Space를 공유한 게시물 URL이 필요합니다.');$('connection').textContent='○ 공유 게시물 미발견 · 답글 수집 대기';return;}await tick(g);}catch(e){if(g!==generation)return;connecting=false;$('title').textContent='스페이스에 연결하지 못했습니다';$('connection').textContent=e.status===429?'○ 조회 제한 · 잠시 후 다시 시도':'○ 연결 실패';notice(e.message,true);}}
let latestChatPreview=null;
function updateFollowNotice(){const box=$('messages'),distance=box.scrollHeight-box.clientHeight-box.scrollTop;$('resumeChat').hidden=auto||distance<100;$('latestChatName').textContent=latestChatPreview?.name||'';$('latestChatName').style.setProperty('--nick-color',latestChatPreview?.color||'#e7e9ea');$('latestChatName').style.setProperty('--nick-color-light',latestChatPreview?.lightColor||'#536471');$('latestChatText').textContent=latestChatPreview?.text||'최신 채팅으로 이동';}
function resumeChatFollowing(){stopChatMotion();auto=true;$('messages').scrollTop=$('messages').scrollHeight;updateFollowNotice();}
function renderChatMessages(messages,g,prepend=false,animate=true){
 const box=$('messages'),anchor=[...box.querySelectorAll('.message')].find(n=>n.getBoundingClientRect().bottom>=box.getBoundingClientRect().top),top=anchor?.getBoundingClientRect().top,oldHeight=box.scrollHeight,oldScroll=box.scrollTop,following=auto,previousPositions=animate&&!prepend?captureChatMotion():null,addedMessages=[],fragment=document.createDocumentFragment();
  for(const m of messages){if(seen.has(m.id))continue;seen.add(m.id);
   const n=document.createElement('div');n.className='message';n.setAttribute('data-message-id',m.id);n.style.fontSize=fontSizes[fontIndex]+'px';
   const t=document.createElement('time');t.textContent=m.time?new Date(m.time).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false}):'';t.hidden=!$('timestamps').checked;
   const b=document.createElement('b');b.textContent=m.name;b.title='@'+m.handle;const palette=['#ad8abf','#d58cb2','#9bb8d8','#9cc99d','#cfb088','#a7a1d0','#b9c77c','#82bfb7'],lightPalette=['#794895','#a33170','#28649a','#326c38','#805815','#6152a0','#596817','#146f66'];let hash=0;for(const ch of m.handle||m.name)hash=(hash*31+ch.charCodeAt(0))>>>0;b.style.setProperty('--nick-color',palette[hash%palette.length]);b.style.setProperty('--nick-color-light',lightPalette[hash%lightPalette.length]);if(!prepend)latestChatPreview={name:m.name,color:palette[hash%palette.length],lightColor:lightPalette[hash%lightPalette.length],text:stripLeadingMentions(m.text)||(m.photos?.length?'첨부 이미지':'')};
   const body=document.createElement('span');body.textContent=stripLeadingMentions(m.text);n.append(t,b,body);if(m.photos?.length){const media=document.createElement('div');media.className='message-media';for(const photo of m.photos){const link=document.createElement('a');link.href=photo.url;link.target='_blank';link.rel='noopener noreferrer';const img=document.createElement('img');const thumb=new URL(photo.url);thumb.searchParams.set('name','small');img.src=thumb.href;img.alt='첨부 이미지';img.loading='lazy';img.referrerPolicy='no-referrer';if(prepend){img.width=120;img.height=90;img.style.objectFit='contain';}img.onload=()=>{if(auto&&g===generation)$('messages').scrollTop=$('messages').scrollHeight;};img.onerror=()=>link.remove();link.append(img);media.append(link);}n.append(media);}fragment.append(n);addedMessages.push(n);
  }

 if(prepend){const first=box.querySelector('.message')||box.querySelector('.broadcast-ended');if(first)box.insertBefore(fragment,first);else box.append(fragment);if(anchor)box.scrollTop+=anchor.getBoundingClientRect().top-top;else box.scrollTop=oldScroll+box.scrollHeight-oldHeight;auto=following;}else{box.append(fragment);if(addedMessages.length)animateChatArrival(previousPositions,addedMessages);}
 updateFollowNotice();return addedMessages;
}
async function loadOlderChat(g,id,before){
 let attempt=0;while(g===generation&&before){if(realtimeOrigin&&document.hidden){await new Promise(resolve=>{const resume=()=>{if(!document.hidden){document.removeEventListener('visibilitychange',resume);resolve();}};document.addEventListener('visibilitychange',resume);});if(g!==generation)return;}try{const d=await api('/api/chat-history?id='+id+'&before='+before);if(g!==generation)return;renderChatMessages(d.messages,g,true,false);if(!d.hasOlder||!d.olderCursor||d.olderCursor>=before)return;before=d.olderCursor;attempt=0;}catch{if(++attempt>=3)return;}await new Promise(resolve=>setTimeout(resolve,250));}
}
function applyRoomData(d,g,initial=false){
  if(g!==generation||!room?.tweet||!Array.isArray(d.messages))return false;
  if(Number.isFinite(d.historyCursor)&&d.historyCursor<cursor)return false;
  if(d.stopped){if(room.state==='Running')broadcastToastEvent(selected,room.id,false);room.state='Ended';updateAudience(room);}
  else if(d.spaceState==='Running'&&!roomCollectionStopped)room.state='Running';
  nextPollMs=Number.isFinite(d.pollIntervalMs)?Math.max(50,d.pollIntervalMs):500;
  const dHasMore=!!d.hasMore;cursor=Math.max(cursor,Number(d.historyCursor)||0);
  renderChatMessages(d.messages,g,false,!initial);
  latestHistoryReady=roomCollectionStopped||!dHasMore&&(!d.collecting||!!d.stopped);
  roomCollectionStopped=roomCollectionStopped||!!d.stopped&&!dHasMore;
  if(initial&&d.hasOlder)void loadOlderChat(g,room.tweet,d.olderCursor);

  if(room.state==='Ended'&&!dHasMore&&(!realtimeOrigin||roomCollectionStopped))showBroadcastEnded();
  updateFollowNotice();
  $('connection').textContent=(d.stale?'○ 갱신 지연 · ':d.collecting?'◌ 수집 중 · ':'● ')+'답글 '+seen.size+'개 · 일부 답글';
  if(roomCollectionStopped)$('connection').textContent='○ 종료됨 · 답글 조회 중지 · '+seen.size+'개';
  $('connection').title=(d.checkedAt?'마지막 성공 조회: '+new Date(d.checkedAt).toLocaleTimeString('ko-KR'):'공유 수집기에서 첫 응답을 기다리고 있습니다.')+(d.warning?' · '+d.warning:'');
  if(d.total!=null)$('streamInfo').textContent='공유 게시물 답글 '+Intl.NumberFormat('ko').format(d.total)+'개 · '+(realtimeOrigin?'실시간 연결':(nextPollMs/1000).toFixed(2)+'초마다 확인');
  return dHasMore;
}
async function tick(g){
 if(g!==generation||!room?.tweet||chatRequestGeneration===g||(realtimeOrigin&&document.hidden&&cursor>0))return;
 const startedAt=Date.now(),initial=cursor===0,id=room.tweet;let dHasMore=false;chatRequestGeneration=g;
 try{
  const d=await api('/api/replies?id='+id+'&after='+cursor+(initial?'&latest=1':''));
  if(g!==generation||room?.tweet!==id)return;
  dHasMore=applyRoomData(d,g,initial);
  if(realtimeOrigin)realtime.setRoom(id,cursor);
 }catch(e){if(g!==generation)return;nextPollMs=Math.max(2000,e.retryAfterMs||0,e.status===429?30000:0);$('connection').textContent=e.status===429?'○ 조회 제한 · 재시도 대기':'○ 갱신 실패 · 재시도 중';$('connection').title=e.message;if(!seen.size&&!$('messages').querySelector('.error'))notice(e.message,true);}
 finally{if(chatRequestGeneration===g)chatRequestGeneration=null;}
 if(g===generation&&(realtimeOrigin?!roomCollectionStopped:room?.state!=='Ended'||dHasMore))scheduleChatPoll(g,dHasMore?0:realtimeOrigin?5000:Math.max(0,nextPollMs-(Date.now()-startedAt)),dHasMore);
}
function restoreChatTheme(){let theme;try{theme=localStorage.getItem('chatTheme');}catch{}$('chatTheme').value=['light','dark'].includes(theme)?theme:'system';}
function applyChatPreferences(){const following=auto,box=$('messages');stopChatMotion();const theme=['light','dark'].includes($('chatTheme').value)?$('chatTheme').value:'system';document.documentElement.dataset.theme=theme==='system'?(typeof matchMedia==='function'&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):theme;try{localStorage.setItem('chatTheme',theme);}catch{}document.body.classList.toggle('hide-chat-images',!$('showImages').checked);try{localStorage.setItem('chatShowImages',$('showImages').checked?'1':'0');}catch{}if(following)box.scrollTop=box.scrollHeight;auto=following;updateFollowNotice();}
function chatMotionEnabled(){return !$('disableAnimation').checked&&!(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);}
function captureChatMotion(){
 const box=$('messages');if(!auto||!seen.size||!chatMotionEnabled())return null;
 const bounds=box.getBoundingClientRect();return new Map([...box.querySelectorAll('.message')].slice(-80).filter(el=>{const r=el.getBoundingClientRect();return r.bottom>=bounds.top&&r.top<=bounds.bottom;}).map(el=>[el,el.getBoundingClientRect().top]));
}
function animateChatArrival(previous,added){
 const box=$('messages');if(!auto)return;box.scrollTop=box.scrollHeight;
 if(!previous||!chatMotionEnabled()||!auto)return;
 const options={duration:220,easing:'cubic-bezier(.2,.7,.2,1)'};
 for(const [el,top]of previous){el.getAnimations?.().forEach(a=>a.cancel());const delta=top-el.getBoundingClientRect().top;if(Math.abs(delta)>1)el.animate?.([{transform:'translateY('+delta+'px)'},{transform:'translateY(0)'}],options);}
 for(const el of added)el.animate?.([{opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],options);
}
function stopChatMotion(){for(const el of $('messages').querySelectorAll('.message'))el.getAnimations?.().forEach(a=>a.cancel());}
function updateTimestampVisibility(){try{localStorage.setItem('chatTimestamps',$('timestamps').checked?'1':'0');}catch{}const following=auto,box=$('messages');stopChatMotion();document.querySelectorAll('.message time').forEach(t=>t.hidden=!$('timestamps').checked);if(following)box.scrollTop=box.scrollHeight;auto=following;updateFollowNotice();}
function updateAutoScroll(){const box=$('messages');auto=box.scrollHeight-box.clientHeight-box.scrollTop<=24;updateFollowNotice();}
async function collectAllLive(){
 if(realtimeOrigin)return;
 const started=Date.now();let interval=2000;
 try{const result=await api('/api/collect-live');interval=Number.isFinite(result.pollIntervalMs)?Math.max(50,result.pollIntervalMs):2000;}catch{interval=3000;}
 setTimeout(collectAllLive,Math.max(50,interval-(Date.now()-started)));
}
try{$('timestamps').checked=localStorage.getItem('chatTimestamps')!=='0';}catch{}
try{$('showImages').checked=localStorage.getItem('chatShowImages')!=='0';}catch{}restoreChatTheme();applyChatPreferences();$('chatTheme').onchange=applyChatPreferences;$('showImages').onchange=applyChatPreferences;if(typeof matchMedia==='function')matchMedia('(prefers-color-scheme: light)').addEventListener('change',applyChatPreferences);document.querySelectorAll('.tools .iconbtn[aria-label]').forEach(el=>el.removeAttribute('title'));let feedbackId=null,feedbackSending=false;
$('ratingSkip').onclick=closeBroadcastRating;$('ratingDialog').addEventListener('click',e=>{if(e.target!==$('ratingDialog'))return;const r=$('ratingDialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeBroadcastRating();});$('ratingForm').onsubmit=submitBroadcastRating;document.querySelectorAll('input[name="broadcastRating"]').forEach(input=>input.onchange=()=>{if(!ratingSession||ratingSession.sending||ratingSession.sent)return;ratingSession.score=Number(input.value);updateRatingStars();});
$('feedbackOpen').onclick=()=>{$('feedbackDialog').showModal();$('feedbackText').focus();};$('feedbackClose').onclick=()=>{$('feedbackDialog').close();};
$('feedbackForm').onsubmit=async event=>{event.preventDefault();if(feedbackSending)return;const message=$('feedbackText').value.trim();if(!message)return;feedbackSending=true;$('feedbackSend').disabled=true;$('feedbackStatus').textContent='전송 중…';feedbackId||=crypto.randomUUID();try{const response=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:feedbackId,message,member:selected,urgent:$('feedbackUrgent').checked})}),result=await response.json();if(!response.ok)throw Error(result.error||'전송하지 못했습니다. 다시 시도해 주세요.');$('feedbackText').value='';$('feedbackUrgent').checked=false;feedbackId=null;$('feedbackStatus').textContent='피드백을 보냈습니다. 감사합니다!';}catch(e){$('feedbackStatus').textContent=e.message;}finally{feedbackSending=false;$('feedbackSend').disabled=false;}};
$('resumeChat').onclick=resumeChatFollowing;$('choose').onclick=()=>{$('dropdown').hidden=!$('dropdown').hidden;$('choose').setAttribute('aria-expanded',String(!$('dropdown').hidden));};document.addEventListener('pointerdown',e=>{if(!e.target.closest('#settings')&&!e.target.closest('#gear')){$('settings').hidden=true;$('gear').setAttribute('aria-expanded','false');}});document.addEventListener('click',e=>{if(!e.target.closest('.selector')){$('dropdown').hidden=true;$('choose').setAttribute('aria-expanded','false');}});document.addEventListener('keydown',e=>{if(e.key==='Escape'){if($('ratingDialog').open||$('feedbackDialog').open)return;$('settings').hidden=true;$('gear').setAttribute('aria-expanded','false');$('dropdown').hidden=true;$('choose').focus();}});$('gear').onclick=()=>{$('settings').hidden=!$('settings').hidden;$('gear').setAttribute('aria-expanded',String(!$('settings').hidden));};$('infotoggle').onclick=()=>{$('stream').hidden=!$('stream').hidden;$('infotoggle').setAttribute('aria-expanded',String(!$('stream').hidden));};try{$('disableAnimation').checked=localStorage.getItem('chatAnimationDisabled')==='1';}catch{}$('disableAnimation').onchange=()=>{try{localStorage.setItem('chatAnimationDisabled',$('disableAnimation').checked?'1':'0');}catch{}stopChatMotion();};$('timestamps').onchange=updateTimestampVisibility;function updateFont(){document.querySelectorAll('.message').forEach(m=>m.style.fontSize=fontSizes[fontIndex]+'px');$('zoomlevel').textContent=Math.round(fontSizes[fontIndex]/14*100)+'%';$('zoomout').disabled=fontIndex===0;$('zoomin').disabled=fontIndex===fontSizes.length-1;}$('zoomout').onclick=()=>{fontIndex=Math.max(0,fontIndex-1);updateFont();};$('zoomin').onclick=()=>{fontIndex=Math.min(fontSizes.length-1,fontIndex+1);updateFont();};updateFont();$('messages').addEventListener('scroll',updateAutoScroll,{passive:true});$('messages').addEventListener('wheel',e=>{if(e.deltaY<0){auto=false;stopChatMotion();updateFollowNotice();}},{passive:true});$('messages').addEventListener('touchmove',()=>{auto=false;stopChatMotion();updateFollowNotice();},{passive:true});$('popup').onclick=()=>{const u=new URL(location.href);u.searchParams.set('popup','1');u.searchParams.delete('source');const height=Math.min(750,Math.max(300,screen.availHeight-80)),left=(screen.availLeft||0)+Math.max(0,Math.round((screen.availWidth-350)/2)),top=(screen.availTop||0)+Math.max(0,Math.round((screen.availHeight-height)/2));const popup=window.open(u.href,'_blank','popup=yes,width=350,height='+height+',left='+left+',top='+top+',toolbar=no,menubar=no,location=no,status=no,resizable=yes,scrollbars=yes');if(popup){try{popup.resizeTo(350,height);popup.moveTo(left,top);popup.focus();}catch{}}};const params=new URLSearchParams(location.search);if(params.has('popup')){document.body.classList.add('popup');if(window.opener&&matchMedia('(hover:hover) and (pointer:fine)').matches){try{const height=Math.min(750,Math.max(300,screen.availHeight-80));window.resizeTo(350,height);window.moveTo((screen.availLeft||0)+Math.max(0,Math.round((screen.availWidth-350)/2)),(screen.availTop||0)+Math.max(0,Math.round((screen.availHeight-height)/2)));}catch{}}}render();const requested=memberFromPath(location.pathname,groups)||localStorage.getItem('member')||'GANGZIIII';const saved=groups.flatMap(g=>g[2]).find(m=>m[1].toLowerCase()===requested.toLowerCase())?.[1]||'GANGZIIII';const savedGroup=groups.findIndex(g=>g[2].some(m=>m[1]===saved));rootPending=location.pathname==='/';if(rootPending){selected=groups[0][2][0][1];trackAnalyticsMember(selected);history.replaceState(null,'','/'+selected+(params.has('popup')?'?popup=1':''));$('selectedName').textContent=groups[0][2][0][0];$('selectedHandle').textContent='@'+selected+(groups[0][1]?' · '+groups[0][1]:'');$('external').href='https://x.com/'+selected;render();$('connection').textContent='○ 연결 대기';}else if(savedGroup>=0){const m=groups[savedGroup][2].find(m=>m[1]===saved);select(m[0],m[1],savedGroup);}async function refresh(){const g=generation,handle=selected,version=memberUpdateVersion;try{const a=await api('/api/members');if(g!==generation||handle!==selected||version!==memberUpdateVersion)return;await applyMemberStates(a);}catch{}}refresh();setInterval(()=>{if(!realtimeOrigin||(!document.hidden&&!realtime.connected))void refresh();},realtimeOrigin?30000:5000);setInterval(()=>updateElapsed(room),1000);if(realtimeOrigin){realtime.start();document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(poll);realtime.suspendChecks();return;}realtime.resume();if(realtime.connected){if(room?.tweet)realtime.setRoom(room.tweet,cursor,true);}else{void refresh();if(room?.tweet&&!roomCollectionStopped)void tick(generation);}});window.addEventListener('pagehide',()=>realtime.pause());window.addEventListener('pageshow',()=>realtime.resume());}else collectAllLive();
</script></html>`;
