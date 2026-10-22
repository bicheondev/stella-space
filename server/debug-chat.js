// Runs only in the authenticated debugging frame; normal chat stays unchanged.
export const debugChatScript=String.raw`
const debugSend=value=>parent.postMessage({type:'space-debug',...value},location.origin);
const debugOriginalApi=api;
let debugHistoryReady=false;
api=async function(path){
 const requestId=crypto.randomUUID(),requestStart=performance.now(),requestGeneration=generation;debugSend({event:'request',path,requestId,at:Date.now()});
 try{const result=await debugOriginalApi(path);debugSend({event:'response',path,requestId,at:Date.now(),result});
 if(path.startsWith('/api/resolve')&&requestGeneration===generation){debugHistoryReady=false;debugSend({event:'latency-reset'});}
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
debugButton.onclick=()=>{const value=prompt('X Space 또는 Space 공유 게시물 URL을 입력해 주세요.');if(value?.trim())connect(value.trim());};document.querySelector('.toolbar-actions').prepend(debugButton);
$('connection').hidden=false;
addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='debug-connect')return;connect(String(event.data.url||''));});
`;
