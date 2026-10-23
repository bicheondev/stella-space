// Runs only in the authenticated debugging frame; normal chat stays unchanged.
export const debugChatScript=String.raw`
const debugSend=value=>parent.postMessage({type:'space-debug',...value},location.origin);
const debugOriginalApi=api;
let debugHistoryReady=false,debugExternal=false,debugCursor=0;
async function debugConnect(value){debugExternal=true;debugCursor=0;realtime?.close();realtimeOrigin='';await connect(value);}
api=async function(path){
 const requestId=crypto.randomUUID(),requestStart=performance.now(),requestGeneration=generation;debugSend({event:'request',path,requestId,at:Date.now()});
 try{
 let result;
 if(debugExternal&&/^\/api\/(resolve|replies|chat-history)\?/.test(path)){
  if(document.hidden)await new Promise(resolve=>{const resume=()=>{if(!document.hidden){document.removeEventListener('visibilitychange',resume);resolve();}};document.addEventListener('visibilitychange',resume);});
  const response=await fetch(path.replace('/api/','/api/admin/debug-space/'),{cache:'no-store',signal:AbortSignal.timeout(15000)});
  result=await response.json();if(!response.ok){const error=Error(result.error||'테스트 조회에 실패했습니다.');error.status=response.status;error.retryAfterMs=Math.max(0,Number(response.headers.get('retry-after'))||0)*1000;throw error;}
  if(path.startsWith('/api/replies')){debugCursor+=(result.messages||[]).filter(message=>!seen.has(message.id)).length;result.historyCursor=debugCursor;result.hasOlder=false;}
 }else result=await debugOriginalApi(path);
 debugSend({event:'response',path,requestId,at:Date.now(),result});
 if(path.startsWith('/api/resolve')&&requestGeneration===generation){debugHistoryReady=false;debugCursor=0;debugSend({event:'latency-reset'});}
 if(path.startsWith('/api/replies')&&requestGeneration===generation){
  const responseAt=performance.now(),post=room?.tweet,g=generation;
  const ids=(result.messages||[]).filter(m=>!seen.has(m.id)).map(m=>String(m.id));
  const eligible=debugHistoryReady&&!result.hasMore&&!result.stopped&&auto&&!document.hidden;
  if(!result.hasMore)debugHistoryReady=true;
  if(eligible&&ids.length)requestAnimationFrame(()=>requestAnimationFrame(()=>{
   if(g!==generation||room?.tweet!==post||!auto||document.hidden)return;
   const rendered=new Set([...$('messages').querySelectorAll('[data-message-id]')].map(el=>el.getAttribute('data-message-id')));
   if(!ids.every(id=>rendered.has(id)))return;
   const displayedAt=performance.now();debugSend({event:'latency-sample',requestId,post,ids,count:ids.length,requestMs:responseAt-requestStart,renderMs:displayedAt-responseAt,ms:displayedAt-requestStart,at:Date.now()});
  }));
  else if(!eligible)debugSend({event:'latency-status',status:'첫 기록·이전 기록·종료된 방송·자동 스크롤 해제·백그라운드 상태는 측정에서 제외해요.'});
 }
 if(path.startsWith('/api/resolve')&&result.handle&&!groups.flatMap(g=>g[2]).some(m=>m[1]===result.handle)){$('selectedName').textContent=result.handle;$('selectedHandle').textContent='테스트 계정';avatar($('selectedAvatar'),result.handle,result.avatar,result.state==='Running');}
 return result;
 }catch(error){debugSend({event:'failure',path,requestId,at:Date.now(),error:error.message});throw error;}
};
const debugButton=document.createElement('button');debugButton.className='iconbtn';debugButton.title='Space 또는 공유 게시물 URL 테스트';debugButton.setAttribute('aria-label',debugButton.title);debugButton.textContent='🔗';
debugButton.onclick=()=>{const value=prompt('X Space 또는 Space 공유 게시물 URL을 입력해 주세요.');if(value?.trim())debugConnect(value.trim());};document.querySelector('.toolbar-actions').prepend(debugButton);
$('connection').hidden=false;$('streamInfo').hidden=false;$('listeners').hidden=false;
addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent)return;if(event.data?.type==='debug-stop'){++generation;clearTimeout(poll);room=null;debugExternal=false;connecting=false;$('connection').textContent='○ 테스트 종료';return;}if(event.data?.type==='debug-connect')debugConnect(String(event.data.url||''));});
`;
