const members=[['에버리스','EVERYS',[['아야츠노 유니','AyatsunoYuni'],['사키하네 후야','SakihaneHuya']]],['유니버스','Universe',[['네네코 마시로','NenekoMashiro'],['아라하시 타비','ArahashiTabi'],['시라유키 히나','ShirayukiHina_'],['아카네 리제','AkaneLize']]],['클리셰','Cliché',[['아오쿠모 린','AokumoRin'],['텐코 시부키','TenkoShibuki'],['하나코 나나','HanakoNana_'],['유즈하 리코','YuzuhaRiko']]],['어비스','ABYSS',[['시즈키 토아','ShizukiToa_'],['코가네 랑','CoganeRang'],['하나요 히요리','HanayoHiyori'],['토키노 메리','TokinoMery']]]];
const bearer='AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
let guest,guestAt=0,guestPending;
async function json(url,init={}){const r=await fetch(url,{...init,headers:{'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',...init.headers},redirect:'manual',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('X 조회 제한 ('+r.status+') · '+new URL(url).pathname);const d=await r.json();if(d.errors?.length)throw Error(d.errors[0].message);return d;}
// 10% headroom below the provider's published 1,000 requests/minute.
const FX_TARGET_RPM=900,PROFILE_RPM=14*60/5,FX_SLOT_MS=Math.ceil(60000/FX_TARGET_RPM);
export function replyInterval(roomCount){return Math.ceil(60000*Math.max(1,roomCount)/(FX_TARGET_RPM-PROFILE_RPM));}
export async function reserveFxSlot(db,now=Date.now()){
  const row=await db.prepare(`INSERT INTO collector_entries (key,next_poll_at) VALUES ('budget:fx',?1+?2)
    ON CONFLICT(key) DO UPDATE SET next_poll_at=MAX(collector_entries.next_poll_at,?1)+?2
    WHERE collector_entries.next_poll_at<=?1+2000 RETURNING next_poll_at`).bind(now,FX_SLOT_MS).first();
  if(!row)throw Error('공유 호출 예산 대기 중');
  return Math.max(0,row.next_poll_at-FX_SLOT_MS-now);
}
async function fxJson(db,url){const delay=await reserveFxSlot(db);if(delay)await new Promise(r=>setTimeout(r,delay));return json(url);}
async function replySchedule(db,id){
 const now=Date.now();
 const live=await db.prepare(`SELECT COUNT(*) AS count FROM collector_entries WHERE key LIKE 'member:v2:%' AND payload IS NOT NULL AND json_extract(payload,'$.status')='live' AND last_started_at>=?1`).bind(now-30000).first();
 const active=await db.prepare(`SELECT COUNT(*) AS count FROM collector_entries WHERE key LIKE 'replies:fxtwitter:%' AND (last_started_at>=?1 OR key=?2)`).bind(now-30000,'replies:fxtwitter:'+id).first();
 const liveCount=Number(live?.count||0),activeRoomCount=Math.max(1,Number(active?.count||0));
 return {pollIntervalMs:replyInterval(Math.max(liveCount,activeRoomCount)),liveCount,activeRoomCount};
}
async function headers(){if(!guest||Date.now()-guestAt>600000){if(!guestPending)guestPending=(async()=>{guest=(await json('https://api.x.com/1.1/guest/activate.json',{method:'POST',headers:{authorization:'Bearer '+bearer}})).guest_token;guestAt=Date.now();})().finally(()=>{guestPending=null;});await guestPending;}return{authorization:'Bearer '+bearer,'x-guest-token':guest,'content-type':'application/json'};}
async function gql(op,id,variables){const u=new URL('https://x.com/i/api/graphql/'+id+'/'+op);u.searchParams.set('variables',JSON.stringify(variables));return json(u,{headers:await headers()});}
async function metadata(id){const d=await gql('AudioSpaceById','fYAuJHiY3TmYdBmrRtIKhA',{id,isMetatagsQuery:false,withReplays:true});const m=d.data?.audioSpace?.metadata;if(!m)throw Error('Space 정보를 확인할 수 없습니다.');return m;}
async function spaceMetadata(id,db){return sharedCollect(db,'space:'+id,m=>m.state==='Running'?15000:60000,()=>metadata(id));}
function find(value,test){if(!value||typeof value!=='object')return null;if(test(value))return value;for(const v of Object.values(value)){const r=find(v,test);if(r)return r;}return null;}
export function findSpacePost(posts,handle){
  return [...posts].filter(p=>p.author?.screen_name?.toLowerCase()===handle.toLowerCase()).sort((a,b)=>(b.created_timestamp||0)-(a.created_timestamp||0)).slice(0,5).map(post=>{
    const match=(post.text+' '+JSON.stringify(post.raw_text?.facets||[])).match(/https:\/\/(?:x|twitter)\.com\/i\/spaces\/([A-Za-z0-9]+)/);
    return match?{post,space:match[1]}:null;
  }).find(Boolean)||null;
}
async function profile(handle,db){
  const member=members.flatMap(g=>g[2]).find(m=>m[1].toLowerCase()===handle.toLowerCase());
  if(!member)throw Error('등록되지 않은 멤버입니다.');handle=member[1];
  const value=await sharedCollect(db,'member:v2:'+handle,5000,async()=>{
    const d=await fxJson(db,'https://api.fxtwitter.com/2/profile/'+handle+'/statuses?count=5');
    if(d.code!==200||!Array.isArray(d.results))throw Error('멤버 최근 게시물 조회 제한');
    const own=d.results.find(p=>p.author?.screen_name?.toLowerCase()===handle.toLowerCase());
    const avatar=own?.author?.avatar_url;
    const found=findSpacePost(d.results,handle);
    if(!found)return{handle,avatar,status:'offline',reason:'최근 게시물 5개에 Space 공유 글이 없어 오프라인으로 표시합니다.'};
    let m;try{m=await spaceMetadata(found.space,db);}catch{}
    return{handle,avatar,status:m?.state==='Running'?'live':m?.state==='Ended'?'offline':'unknown',state:m?.state||'Unknown',space:found.space,title:m?.title||member[0]+'의 스페이스',postUrl:'https://x.com/'+handle+'/status/'+found.post.id};
  });
  return{handle,status:'unknown',...value};
}
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
    if(tweetId){
      tweet=await json('https://cdn.syndication.twimg.com/tweet-result?id='+tweetId+'&lang=ko&token=0');
      const link=tweet.entities?.urls?.find(x=>/\/i\/spaces\//.test(x.expanded_url));
      id=link?.expanded_url?.match(/\/i\/spaces\/([A-Za-z0-9]+)/)?.[1]||tweet.card?.binding_values?.id?.string_value;
      if(!id)throw Error('게시물에서 Space 링크를 찾지 못했습니다.');
    }
    let m;
    try{m=await spaceMetadata(id,db);}catch(e){if(!tweet)throw e;}
    return{id,title:m?.title||(tweet?.user?.name||'선택한 멤버')+'의 스페이스',state:m?.state||'Unknown',handle:(()=>{const h=m?.creator_results?.result?.legacy?.screen_name||tweet?.user?.screen_name;return members.flatMap(g=>g[2]).find(x=>x[1].toLowerCase()===h?.toLowerCase())?.[1]||h;})(),avatar:m?.creator_results?.result?.legacy?.profile_image_url_https||tweet?.user?.profile_image_url_https,listeners:m?.total_live_listeners,tweet:tweetId,replies:tweet?.conversation_count};
  });
}
// All execution regions coordinate through one D1 row per collection key.
// A lease owner alone may fetch or commit. A crashed owner is recoverable after expiry.
export async function sharedCollect(db,key,ttl,produce,options={}){
  if(!db?.prepare)throw Error('Sites 공유 수집 저장소가 연결되지 않았습니다.');
  const clock=options.clock||Date.now,now=clock(),leaseMs=options.leaseMs||60000;
  const read=()=>db.prepare('SELECT * FROM collector_entries WHERE key = ?1').bind(key).first();
  let row=await read();
  const output=(r,collecting=false)=>r?.payload?{...JSON.parse(r.payload),shared:true,collecting,stale:!!r.last_error,warning:r.last_error||null}:{shared:true,collecting:true,messages:[],source:key.startsWith('replies:')?key.split(':')[1]:undefined,checkedAt:null};
  if(row&&row.next_poll_at>now){if(!row.payload&&row.last_error)throw Error(row.last_error);return output(row,row.lease_until>now);}
  if(row?.lease_until>now)return output(row,true);
  const token=crypto.randomUUID();
  const acquired=await db.prepare(`INSERT INTO collector_entries (key, lease_until, lease_token, last_started_at, fetch_count)
    VALUES (?1, ?2, ?3, ?4, 1)
    ON CONFLICT(key) DO UPDATE SET lease_until=excluded.lease_until,lease_token=excluded.lease_token,last_started_at=excluded.last_started_at,fetch_count=collector_entries.fetch_count+1
    WHERE collector_entries.next_poll_at <= ?4 AND collector_entries.lease_until <= ?4
    RETURNING *`).bind(key,now+leaseMs,token,now).first();
  if(!acquired)return output(await read(),true);
  try{
    let value=await produce();
    if(options.mergeMessages&&acquired.payload){
      const prior=JSON.parse(acquired.payload),byId=new Map();
      for(const m of [...(prior.messages||[]),...(value.messages||[])])byId.set(m.id,m);
      const messages=[...byId.values()].sort((a,b)=>a.time-b.time).slice(-500);
      while(messages.length>1&&JSON.stringify(messages).length>900000)messages.shift();
      value={...value,messages};
    }
    const checkedAt=new Date(clock()).toISOString();value={...value,checkedAt};
    const committed=await db.prepare(`UPDATE collector_entries SET payload=?1,next_poll_at=?2,lease_until=0,lease_token='',last_error=NULL,failure_count=0 WHERE key=?3 AND lease_token=?4 RETURNING *`).bind(JSON.stringify(value),(options.startCadence?acquired.last_started_at:clock())+(typeof ttl==='function'?ttl(value):ttl),key,token).first();
    return output(committed||await read(),!committed);
  }catch(e){
    const backoff=/429/.test(e.message)?30000:Math.max(typeof ttl==='function'?15000:ttl,3000);
    const failed=await db.prepare(`UPDATE collector_entries SET next_poll_at=?1,lease_until=0,lease_token='',last_error=?2,failure_count=failure_count+1 WHERE key=?3 AND lease_token=?4 RETURNING *`).bind(clock()+backoff,e.message,key,token).first();
    if(failed?.payload)return output(failed);
    if(!failed){const current=await read();if(current?.payload)return output(current,current.lease_until>clock());}
    throw e;
  }
}
export function stripLeadingMentions(text) {
  return text.replace(/^(?:\s*@[A-Za-z0-9_]{1,15}(?=\s|$)\s*)+/, '');
}
export function parseFxReplies(data,rootId){
  if(data.code!==200||!Array.isArray(data.replies))throw Error('FxTwitter 답글 조회 제한 ('+(data.code||'응답 오류')+')');
  const byId=new Map();
  for(const item of data.replies){
    if(item.type!=='status'||item.replying_to?.status!==rootId||typeof item.text!=='string')continue;
    byId.set(item.id,{id:item.id,name:item.author?.name||item.author?.screen_name||'청취자',handle:item.author?.screen_name||'',text:item.text,photos:(item.media?.photos||[]).map(p=>{try{const u=new URL(p.url);return u.protocol==='https:'&&u.hostname==='pbs.twimg.com'&&u.pathname.startsWith('/media/')?{url:u.href}:null;}catch{return null;}}).filter(Boolean).slice(0,4),time:Number(item.created_timestamp)*1000||Date.parse(item.created_at)||0,url:'https://x.com/i/status/'+item.id});
  }
  return{messages:[...byId.values()].sort((a,b)=>a.time-b.time),total:data.status?.replies??null,cursor:data.cursor?.bottom||null,limited:true,source:'fxtwitter'};
}
async function replies(id,db){
  if(!/^\d{2,20}$/.test(id))throw Error('공유 게시물 ID를 입력해 주세요.');
  const resolved=await db.prepare('SELECT payload FROM collector_entries WHERE key=?1').bind('resolve:post:'+id).first();
  const spaceId=resolved?.payload?JSON.parse(resolved.payload).id:null;
  const space=spaceId?await spaceMetadata(spaceId,db):null;
  if(space?.state==='Ended'){
    const cached=await db.prepare('SELECT payload FROM collector_entries WHERE key=?1').bind('replies:fxtwitter:'+id).first();
    return {...(cached?.payload?JSON.parse(cached.payload):{messages:[],source:'fxtwitter',limited:true}),shared:true,collecting:false,stopped:true,pollIntervalMs:null};
  }
  const schedule=await replySchedule(db,id);
  const result=await sharedCollect(db,'replies:fxtwitter:'+id,schedule.pollIntervalMs,async()=>parseFxReplies(await fxJson(db,'https://api.fxtwitter.com/2/conversation/'+id+'?ranking_mode=recency'),id),{mergeMessages:true,startCadence:true});
  return {...result,...schedule};
}
export default{async fetch(request,env={}){
  const u=new URL(request.url);
  if(u.pathname.startsWith('/api/')){try{
    let d;
    if(u.pathname==='/api/members')d=await Promise.all(members.flatMap(g=>g[2]).map(async m=>{try{return await profile(m[1],env.DB);}catch(e){return{handle:m[1],status:'unknown',error:e.message};}}));
    else if(u.pathname==='/api/member')d=await profile(u.searchParams.get('handle')||'',env.DB);
    else if(u.pathname==='/api/replies')d=await replies(u.searchParams.get('id')||'',env.DB);
    else if(u.pathname==='/api/resolve')d=await resolve(u.searchParams.get('url')||'',env.DB);
    else return new Response('Not found',{status:404});
    return Response.json(d,{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({error:e.message},{status:502});}}
  return new Response(html,{headers:{'content-type':'text/html;charset=utf-8'}});
}};
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>스페이스 채팅 · 스텔라이브</title><style>
:root{color-scheme:dark;--bg:#000000;--text:#e7e9ea;--muted:#71767b;--border:#2f3336;--purple:#1d9bf0;font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕",Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text)}button,input,select{font:inherit}button,a{-webkit-tap-highlight-color:transparent}button{color:inherit;cursor:pointer}button:focus-visible,a:focus-visible,select:focus-visible{outline:2px solid #1d9bf0;outline-offset:2px}button:hover{background:#ffffff14}button:disabled{cursor:default;opacity:.6}[hidden]{display:none!important}main,.chatwindow{width:100%;height:100dvh}.chatwindow{display:flex;flex-direction:column;background:#000000;position:relative}.selector{flex-shrink:0;padding:0 8px;border-bottom:1px solid var(--border);position:relative;z-index:4;background:#000000}.choose{width:100%;border:0;background:transparent;display:flex;align-items:center;padding:8px;gap:10px;text-align:left;min-height:62px;border-radius:0}.avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;background:#403448;display:inline-grid;place-items:center;flex-shrink:0;font-size:12px}.identity{flex:1;min-width:0}.identity strong{display:block;font-size:14px;font-weight:700;line-height:18px}.identity small{display:block;color:#71767b;font-size:12px;line-height:15px}.status{font-size:10px;color:#8b98a5;white-space:nowrap;padding:4px 8px;border-radius:999px;background:#16181c}.status.live{color:#b89cff;background:#201438}.chevron{width:16px;height:16px;color:#71767b}.windowtop{height:48px;min-height:48px;position:relative;display:grid;grid-template-columns:24px 1fr auto;gap:8px;align-items:center;padding:0 8px;border-bottom:1px solid var(--border);background:#000000}.windowtop h1{font-size:15px;font-weight:700;line-height:20px;text-align:center;margin:0}.iconbtn{width:30px;height:30px;padding:5px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;background:transparent;border:0;border-radius:4px;color:#e7e9ea;text-decoration:none}.iconbtn svg{width:20px;height:20px;fill:currentColor}.connect{display:flex;gap:8px;padding:0 0 8px}.connect input{min-width:0;width:100%;background:#000000;color:#e7e9ea;border:1px solid #67676b;border-radius:4px;padding:8px;font-size:12px;outline:none}.connect input:focus{border:2px solid #1d9bf0;padding:7px}.primary{border:0;background:#eff3f4;color:#0f1419;border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600}.primary:hover{background:#d7dbdc}.dropdown{position:absolute;top:62px;left:8px;right:8px;background:#16181c;border:1px solid #353539;border-radius:16px;max-height:min(560px,calc(100dvh - 120px));overflow:auto;z-index:8;box-shadow:0 4px 16px #0009;padding:6px}.group{font-size:11px;color:#71767b;padding:12px 8px 6px;font-weight:600}.member{border:0;background:transparent;width:100%;display:flex;align-items:center;gap:8px;padding:7px 8px;text-align:left;border-radius:4px}.member:hover,.member.active{background:#ffffff14}.member .avatar{width:28px;height:28px}.member strong{font-size:12px}.member small{font-size:10px}.settings{position:absolute;top:114px;bottom:auto;right:8px;z-index:6;width:300px;max-width:calc(100% - 16px);padding:16px;background:#16181c;border-radius:16px;box-shadow:0 0 15px #ffffff12;display:flex;flex-direction:column;gap:16px}.settings h2{font-size:14px;font-weight:600;margin:0 0 2px;padding-bottom:12px;border-bottom:1px solid var(--border)}.settings label{display:flex;align-items:center;justify-content:space-between;font-size:13px;gap:12px}.settings input{accent-color:#1d9bf0}.settings select{max-width:170px;background:#000000;color:#e7e9ea;border:1px solid #67676b;border-radius:4px;padding:5px;font-size:12px}.settings p{margin:0;color:#71767b;font-size:11px;line-height:1.6}.stream{padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0;background:#16181c}.streamtop{display:flex;gap:8px;align-items:center;font-size:11px;color:#71767b}.pill{font-size:10px;font-weight:600;color:#71767b}.stream h2{font-size:13px;font-weight:600;margin:5px 0}.stream small{font-size:11px;color:#71767b}.messages{flex:1;min-height:0;overflow:auto;overflow-wrap:anywhere;padding:8px 12px 10px;scrollbar-width:thin;scrollbar-color:#69696c transparent}.message{font-size:14px;line-height:20px;padding:4px 6px;min-height:28px;word-break:break-word}.message-media{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}.message-media img{display:block;max-width:120px;max-height:90px;object-fit:contain;border-radius:6px}.message:hover{background:#ffffff08}.message b{font-weight:500;margin-right:8px;color:var(--nick-color,#1d9bf0)}.message time{font-size:12px;color:#71767b;margin-right:8px;white-space:nowrap}.notice{padding:4px 6px;color:#71767b;font-size:13px;line-height:20px}.error{color:#ff8280}.tools{min-height:40px;height:40px;flex-shrink:0;display:flex;align-items:center;gap:4px;padding:4px 8px;background:#000000}.tools #connection{font-size:11px;color:#71767b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}.tools #scroll{width:auto;font-size:11px;color:#71767b;padding:4px 7px}.toolbar-actions{display:flex;align-items:center;gap:2px}.welcome{padding:4px 16px;color:#71767b;font-size:13px;line-height:20px}.welcome p{margin:0}@media(max-width:360px){.status{font-size:10px}.tools #scroll{font-size:10px;padding:4px}.tools #connection{font-size:10px}}
.zoom-controls{display:flex;align-items:center;gap:4px}.zoom-controls .iconbtn{width:24px;height:24px;font-size:18px;color:#71767b}.zoom-controls #zoomout,.zoom-controls #zoomin{background:transparent;border-radius:50%}.zoom-controls #zoomout:hover,.zoom-controls #zoomin:hover{background:#181818}.zoom-controls #zoomlevel{font-size:12px;color:#b4b8bf;min-width:32px;text-align:center}.windowtop h1{position:static;text-align:left;white-space:nowrap;pointer-events:none}.zoom-controls{grid-column:3}.settings{border:1px solid #2f3336}.choose .identity small{color:#71767b}.x-mark{display:flex;align-items:center;justify-content:center;color:#e7e9ea}.x-mark svg{width:18px;height:18px}.windowtop{padding:0 12px}.choose{padding:10px 8px}.tools{border-top:1px solid #16181c}.iconbtn{border-radius:50%}.choose .identity small{margin-top:2px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.settings h2{font-size:16px}.settings label{color:#e7e9ea}@media(max-width:360px){.windowtop{padding:0 10px;gap:5px}.windowtop h1{font-size:14px}.zoom-controls{gap:2px}.status{padding:4px 6px}.tools .iconbtn{width:26px;height:28px}.tools #scroll{font-size:10px}}</style><main><section class="chatwindow" aria-label="스페이스 채팅">
<div class="selector"><button class="choose" id="choose" aria-expanded="false" aria-controls="dropdown"><span id="selectedAvatar" class="avatar">히</span><span class="identity"><strong id="selectedName">하나요 히요리</strong><small id="selectedHandle">@HanayoHiyori · ABYSS</small></span><span class="status" id="selectedStatus">확인 중</span><svg class="chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="m5 7 5 5 5-5 1.4 1.4L10 14.8 3.6 8.4z"/></svg></button><div id="dropdown" class="dropdown" hidden></div><form class="connect" id="connect" hidden><input id="url" aria-label="Space 공유 게시물 URL" placeholder="Space 공유 게시물 URL"><button class="primary">연결</button></form></div>
<div class="windowtop"><span class="x-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l7.2-8.4L.8 2h6.5l4.5 6.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z"/></svg></span><h1>스페이스 채팅</h1><div class="zoom-controls"><button class="iconbtn" id="zoomout" aria-label="채팅 글자 축소" title="채팅 글자 축소">−</button><span id="zoomlevel">100%</span><button class="iconbtn" id="zoomin" aria-label="채팅 글자 확대" title="채팅 글자 확대">+</button><button class="iconbtn" id="gear" title="채팅 설정" aria-label="채팅 설정" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="4" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="10" cy="16" r="1.4"/></svg></button></div></div>
<div class="stream" id="stream" hidden><div class="streamtop"><span class="pill" id="state">SPACE</span><span id="streamHandle">@HanayoHiyori</span><span id="listeners" style="margin-left:auto"></span></div><h2 id="title">스페이스를 확인하고 있어요</h2><small id="streamInfo">공유 게시물 답글 · 자동 주기로 확인</small></div>
<div class="messages" id="messages" role="log" aria-live="polite" aria-label="채팅 메시지"><div class="welcome">채팅방에 오신 것을 환영합니다!</div></div>
<div class="settings" id="settings" hidden><h2>채팅 설정</h2><label>시간 표시<input type="checkbox" id="timestamps"></label><label>글자 크기<select id="fontsize"><option value="14">기본 (14px)</option><option value="16">크게 (16px)</option><option value="18">더 크게 (18px)</option></select></label><p>방송 중인 멤버 수에 따라 답글 조회 주기를 자동 조절합니다. 일부 답글만 표시될 수 있습니다. FxTwitter 제공자 내부의 X 인증 방식은 보장하지 않습니다.</p></div>
<div class="tools"><span id="connection" role="status">○ 연결 대기</span><button class="iconbtn" id="scroll" title="자동 스크롤 켜짐">↓ 자동 스크롤</button><div class="toolbar-actions"><button class="iconbtn" id="linktoggle" title="공유 게시물 URL 연결" aria-label="공유 게시물 URL 연결" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 6 2-2a4.24 4.24 0 0 1 6 6l-2 2-1.4-1.4 2-2a2.26 2.26 0 0 0-3.2-3.2l-2 2L7 6Zm6 8-2 2a4.24 4.24 0 0 1-6-6l2-2 1.4 1.4-2 2a2.26 2.26 0 0 0 3.2 3.2l2-2L13 14ZM6.3 12.3l6-6 1.4 1.4-6 6-1.4-1.4Z"/></svg></button><a class="iconbtn" id="external" href="https://x.com/HanayoHiyori" target="_blank" rel="noopener" title="X에서 열기" aria-label="X에서 열기"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 2h7v7h-2V5.4l-7.3 7.3-1.4-1.4L14.6 4H11V2ZM3 4h5v2H4v10h10v-4h2v5l-1 1H3l-1-1V5l1-1Z"/></svg></a><button class="iconbtn" id="popup" title="팝업으로 열기" aria-label="팝업으로 열기"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 2h16v16H2V2Zm2 2v12h12V4H4Zm4 3h6v6H8V7Z"/></svg></button><button class="iconbtn" id="infotoggle" title="방송 정보" aria-label="방송 정보" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM3 19v-4a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v4h-2v-4a3 3 0 0 0-3-3H8a3 3 0 0 0-3 3v4H3Z"/></svg></button></div></div>
</section></main><script>
const groups=${JSON.stringify(members)};
const stripLeadingMentions=${stripLeadingMentions.toString()};
const avatars={"ShizukiToa_":"https://pbs.twimg.com/profile_images/2109194861454991360/gmbvYD-8_normal.jpg","AyatsunoYuni": "https://pbs.twimg.com/profile_images/2106898417473765378/EWJt3rQG_normal.jpg", "SakihaneHuya": "https://pbs.twimg.com/profile_images/2112914105988534273/12E-Bd8C_normal.jpg", "NenekoMashiro": "https://pbs.twimg.com/profile_images/2093138069209919488/M_Ckz81n_normal.jpg", "ArahashiTabi": "https://pbs.twimg.com/profile_images/2109951512793550848/9gKe9qj0_normal.jpg", "ShirayukiHina_": "https://pbs.twimg.com/profile_images/2096096251553198081/V2oCybbe_normal.jpg", "AkaneLize": "https://pbs.twimg.com/profile_images/2094140237320740864/Kyx-TSwi_normal.jpg", "AokumoRin": "https://pbs.twimg.com/profile_images/2112495217878466560/JxqyWCpf_normal.jpg", "TenkoShibuki": "https://pbs.twimg.com/profile_images/2110747276453003264/2gSgV1C9_normal.jpg", "HanakoNana_": "https://pbs.twimg.com/profile_images/2012139881682886656/MYD8iYpq_normal.jpg", "YuzuhaRiko": "https://pbs.twimg.com/profile_images/2081257497386696704/Onv3oD96_normal.jpg", "CoganeRang": "https://pbs.twimg.com/profile_images/2109194867054456832/NCvLV-QW_normal.jpg", "HanayoHiyori": "https://pbs.twimg.com/profile_images/2109194867427700736/7FOyJX35_normal.jpg", "TokinoMery": "https://pbs.twimg.com/profile_images/2111785505700630528/zG8ipTSf_normal.jpg"};
const $=id=>document.getElementById(id);let selected='HanayoHiyori',statuses=Object.fromEntries(Object.entries(avatars).map(([handle,avatar])=>[handle,{avatar,status:'unknown'}])),room=null,cursor='',generation=0,seen=new Set(),auto=true,poll=null,nextPollMs=500,connecting=false;const test='https://x.com/hanayohiyori/status/2112891916077687250';
function avatar(el,name,url){el.textContent=name[0];if(url){const img=new Image();img.className='avatar';img.alt=name+' 프로필';img.src=url;img.onerror=()=>img.replaceWith(Object.assign(document.createElement('span'),{className:'avatar',textContent:name[0]}));el.textContent='';el.append(img);}}
function label(s){return s==='live'?'방송 중':s==='offline'?'오프라인':'확인 불가';}
function render(){ $('dropdown').replaceChildren();groups.forEach((g,i)=>{const title=document.createElement('div');title.className='group';title.textContent=(i+1)+'기생 · '+g[0]+' / '+g[1];$('dropdown').append(title);g[2].forEach(([name,handle])=>{const b=document.createElement('button');b.className='member'+(handle===selected?' active':'');const a=document.createElement('span');a.className='avatar';avatar(a,name,statuses[handle]?.avatar);const n=document.createElement('span');n.className='identity';const strong=document.createElement('strong');strong.textContent=name;const small=document.createElement('small');small.textContent='@'+handle;n.append(strong,small);const s=document.createElement('span');s.className='status '+(statuses[handle]?.status||'');s.textContent='● '+label(statuses[handle]?.status);b.append(a,n,s);b.onclick=()=>select(name,handle,i);$('dropdown').append(b);});});updateSelected();}
function updateSelected(){const s=statuses[selected];$('selectedStatus').textContent='● '+label(s?.status);$('selectedStatus').className='status '+(s?.status||'');avatar($('selectedAvatar'),$('selectedName').textContent,s?.avatar);}
async function select(name,handle,i){
 const g=++generation;clearTimeout(poll);room=null;connecting=false;seen=new Set();$('url').value='';history.replaceState(null,'','?member='+handle+(document.body.classList.contains('popup')?'&popup=1':''));selected=handle;localStorage.setItem('member',handle);
 $('selectedName').textContent=name;$('selectedHandle').textContent='@'+handle+' · '+groups[i][1];$('dropdown').hidden=true;$('choose').setAttribute('aria-expanded','false');$('streamHandle').textContent='@'+handle;$('external').href='https://x.com/'+handle;$('messages').replaceChildren();$('listeners').textContent='';$('state').textContent='SPACE';render();
 $('connection').textContent='◌ 공유 게시물 확인 중';
 try{
  let s=statuses[handle];
  if(!s?.postUrl){s=await api('/api/member?handle='+encodeURIComponent(handle));if(g!==generation)return;statuses[handle]={...statuses[handle],...s};render();}
  if(s?.postUrl){$('url').value=s.postUrl;await connect(s.postUrl);}
  else{$('title').textContent='공유 게시물을 아직 찾지 못했습니다';$('connection').textContent=s?.collecting?'◌ 공유 게시물 찾는 중':'○ 연결 대기';notice(s?.reason||'최근 게시물에서 Space를 확인하는 중입니다. 아래 링크 버튼으로 공유 게시물을 직접 연결할 수 있습니다.');if(s?.collecting)poll=setTimeout(()=>{if(g===generation)select(name,handle,i);},1000);}
 }catch(e){if(g!==generation)return;$('connection').textContent='○ 공유 게시물 조회 제한';notice(e.message,true);}
}
function notice(text,error=false){const n=document.createElement('div');n.className='notice'+(error?' error':'');n.textContent=text;$('messages').append(n);}
async function api(path){const r=await fetch(path,{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'연결 실패');return d;}
async function connect(input){const g=++generation;clearTimeout(poll);room=null;connecting=true;$('connection').textContent='◌ Space 확인 중';$('title').textContent='스페이스를 확인하고 있어요';$('messages').replaceChildren();seen=new Set();cursor='';try{const r=await api('/api/resolve?url='+encodeURIComponent(input));if(g!==generation)return;if(r.collecting&&!r.id){$('connection').textContent='◌ 공유 게시물 확인 중';poll=setTimeout(()=>{if(g===generation)connect(input);},1000);return;}room=r;connecting=false;const groupIndex=groups.findIndex(group=>group[2].some(m=>m[1].toLowerCase()===r.handle?.toLowerCase()));if(groupIndex>=0){const member=groups[groupIndex][2].find(m=>m[1].toLowerCase()===r.handle.toLowerCase());selected=member[1];localStorage.setItem('member',selected);$('selectedName').textContent=member[0];$('selectedHandle').textContent='@'+selected+' · '+groups[groupIndex][1];}$('url').value=input;$('title').textContent=r.title;$('state').textContent=r.state==='Running'?'LIVE':r.state==='Ended'?'종료됨':r.state==='Unknown'?'상태 미확인':'예정';$('streamInfo').textContent=r.state==='Ended'?'종료된 Space · 공개 메시지 기록':'공개 Space · 읽기 전용';$('streamHandle').textContent='@'+r.handle;$('listeners').textContent=r.listeners?Intl.NumberFormat('ko').format(r.listeners)+'명 청취':'';$('external').href=r.tweet?'https://x.com/'+r.handle+'/status/'+r.tweet:'https://x.com/i/spaces/'+r.id;statuses[r.handle]={...statuses[r.handle],status:r.state==='Running'?'live':r.state==='Ended'?'offline':'unknown',avatar:r.avatar,space:r.state==='Running'?r.id:undefined};render();history.replaceState(null,'','?space='+r.id+(r.tweet?'&post='+r.tweet:'')+(document.body.classList.contains('popup')?'&popup=1':''));$('streamInfo').textContent='공유 게시물 답글 · 자동 주기로 확인';$('scroll').disabled=false;if(!r.tweet){notice('답글을 보려면 Space 링크 대신 공유 게시물 URL을 입력해 주세요.');$('connection').textContent='○ 공유 게시물 URL 필요';return;}notice($('selectedName').textContent+'의 채팅방에 오신 것을 환영합니다!');await tick(g);}catch(e){if(g!==generation)return;connecting=false;$('title').textContent='스페이스에 연결하지 못했습니다';$('connection').textContent='○ 연결 제한';notice(e.message,true);}}
async function tick(g){
 if(g!==generation||!room?.tweet)return;
 const startedAt=Date.now();
 try{
  const d=await api('/api/replies?id='+room.tweet);
  if(g!==generation)return;
  if(d.stopped)room.state='Ended';
  nextPollMs=Number.isFinite(d.pollIntervalMs)?Math.max(50,d.pollIntervalMs):500;
  for(const m of d.messages){if(seen.has(m.id))continue;seen.add(m.id);
   const n=document.createElement('div');n.className='message';n.style.fontSize=$('fontsize').value+'px';
   const t=document.createElement('time');t.textContent=m.time?new Date(m.time).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false}):'';t.hidden=!$('timestamps').checked;
   const b=document.createElement('b');b.textContent=m.name;b.title='@'+m.handle;const palette=['#ad8abf','#d58cb2','#9bb8d8','#9cc99d','#cfb088','#a7a1d0','#b9c77c','#82bfb7'];let hash=0;for(const ch of m.handle||m.name)hash=(hash*31+ch.charCodeAt(0))>>>0;b.style.setProperty('--nick-color',palette[hash%palette.length]);
   const body=document.createElement('span');body.textContent=stripLeadingMentions(m.text);n.append(t,b,body);if(m.photos?.length){const media=document.createElement('div');media.className='message-media';for(const photo of m.photos){const link=document.createElement('a');link.href=photo.url;link.target='_blank';link.rel='noopener noreferrer';const img=document.createElement('img');const thumb=new URL(photo.url);thumb.searchParams.set('name','small');img.src=thumb.href;img.alt='첨부 이미지';img.loading='lazy';img.referrerPolicy='no-referrer';img.onload=()=>{if(auto&&g===generation)$('messages').scrollTop=$('messages').scrollHeight;};img.onerror=()=>link.remove();link.append(img);media.append(link);}n.append(media);}$('messages').append(n);
  }
  while($('messages').children.length>500)$('messages').firstChild.remove();
  if(auto)$('messages').scrollTop=$('messages').scrollHeight;
  $('connection').textContent=(d.stale?'○ 갱신 지연 · ':d.collecting?'◌ 수집 중 · ':'● ')+'FxTwitter'+' · '+seen.size+'개 · 일부 답글';
  if(room.state==='Ended')$('connection').textContent='○ 종료됨 · 답글 조회 중지 · '+seen.size+'개';
  $('connection').title=(d.checkedAt?'마지막 성공 조회: '+new Date(d.checkedAt).toLocaleTimeString('ko-KR'):'공유 수집기에서 첫 응답을 기다리고 있습니다.')+(d.warning?' · '+d.warning:'');
  if(d.total!=null)$('streamInfo').textContent='공유 게시물 답글 '+Intl.NumberFormat('ko').format(d.total)+'개 · '+(nextPollMs/1000).toFixed(2)+'초마다 확인';
 }catch(e){if(g!==generation)return;$('connection').textContent='○ 갱신 실패 · 재시도 중';$('connection').title=e.message;if(!seen.size&&!$('messages').querySelector('.error'))notice(e.message,true);}
 if(g===generation&&room?.state!=='Ended')poll=setTimeout(()=>tick(g),Math.max(0,nextPollMs-(Date.now()-startedAt)));
}
$('choose').onclick=()=>{$('dropdown').hidden=!$('dropdown').hidden;$('choose').setAttribute('aria-expanded',String(!$('dropdown').hidden));};document.addEventListener('click',e=>{if(!e.target.closest('.selector')){$('dropdown').hidden=true;$('choose').setAttribute('aria-expanded','false');}});document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('settings').hidden=true;$('gear').setAttribute('aria-expanded','false');$('dropdown').hidden=true;$('choose').focus();}});$('connect').onsubmit=e=>{e.preventDefault();if($('url').value.trim())connect($('url').value.trim());};$('gear').onclick=()=>{$('settings').hidden=!$('settings').hidden;$('gear').setAttribute('aria-expanded',String(!$('settings').hidden));};$('linktoggle').onclick=()=>{$('connect').hidden=!$('connect').hidden;$('linktoggle').setAttribute('aria-expanded',String(!$('connect').hidden));if(!$('connect').hidden)$('url').focus();};$('infotoggle').onclick=()=>{$('stream').hidden=!$('stream').hidden;$('infotoggle').setAttribute('aria-expanded',String(!$('stream').hidden));};$('timestamps').onchange=()=>document.querySelectorAll('.message time').forEach(t=>t.hidden=!$('timestamps').checked);function updateFont(){document.querySelectorAll('.message').forEach(m=>m.style.fontSize=$('fontsize').value+'px');$('zoomlevel').textContent=Math.round(Number($('fontsize').value)/14*100)+'%';$('zoomout').disabled=$('fontsize').selectedIndex===0;$('zoomin').disabled=$('fontsize').selectedIndex===$('fontsize').options.length-1;}$('fontsize').onchange=updateFont;$('zoomout').onclick=()=>{$('fontsize').selectedIndex=Math.max(0,$('fontsize').selectedIndex-1);updateFont();};$('zoomin').onclick=()=>{$('fontsize').selectedIndex=Math.min($('fontsize').options.length-1,$('fontsize').selectedIndex+1);updateFont();};updateFont();$('scroll').onclick=()=>{auto=!auto;$('scroll').textContent=auto?'↓ 자동 스크롤':'↓ 아래로';$('scroll').title='자동 스크롤 '+(auto?'켜짐':'꺼짐');if(auto)$('messages').scrollTop=$('messages').scrollHeight;};$('popup').onclick=()=>{const u=new URL(location.href);u.searchParams.set('popup','1');u.searchParams.delete('source');window.open(u,'stella-space','width=350,height=750');};const params=new URLSearchParams(location.search);if(params.has('popup'))document.body.classList.add('popup');render();$('url').value=test;const saved=params.get('member')||localStorage.getItem('member')||'HanayoHiyori';const savedGroup=groups.findIndex(g=>g[2].some(m=>m[1]===saved));if(!params.has('post')&&!params.has('space')&&savedGroup>=0){const m=groups[savedGroup][2].find(m=>m[1]===saved);select(m[0],m[1],savedGroup);}else connect(params.get('post')?'https://x.com/i/status/'+params.get('post'):params.get('space')||test);async function refresh(){const g=generation,handle=selected;try{const a=await api('/api/members');if(g!==generation||handle!==selected)return;for(const s of a)statuses[s.handle]={...statuses[s.handle],...s,status:s.status,avatar:s.avatar||statuses[s.handle]?.avatar};render();const current=statuses[selected];if(current?.space===room?.id&&current?.state&&current.state!=='Unknown'){room.state=current.state;if(current.state==='Ended'){clearTimeout(poll);$('connection').textContent='○ 종료됨 · 답글 조회 중지 · '+seen.size+'개';}$('state').textContent=current.state==='Running'?'LIVE':current.state==='Ended'?'종료됨':'예정';}if(!connecting&&current?.postUrl&&current.status==='live'&&(!room||room.id!==current.space)){$('url').value=current.postUrl;connect(current.postUrl);};}catch{}}refresh();setInterval(refresh,5000);
</script></html>`;
