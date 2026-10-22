// Runs only in the authenticated debugging frame; normal chat stays unchanged.
export const debugChatScript=String.raw`
const debugSend=value=>parent.postMessage({type:'space-debug',...value},location.origin);
const debugOriginalApi=api;
let debugLastTotal=null,debugPendingCount=null;
api=async function(path){
 const requestId=crypto.randomUUID();debugSend({event:'request',path,requestId,at:Date.now()});
 try{const result=await debugOriginalApi(path);debugSend({event:'response',path,requestId,at:Date.now(),result});
 if(path.startsWith('/api/resolve')){debugLastTotal=null;debugPendingCount=null;debugSend({event:'latency-reset'});}
 if(path.startsWith('/api/replies')&&Number.isFinite(result.total)){
  const now=performance.now(),before=seen.size,g=generation,post=room?.tweet;
  if(debugPendingCount&&now-debugPendingCount.at>60000){debugPendingCount=null;debugSend({event:'latency-status',status:'60초 내 대응 채팅이 없어 측정에서 제외했어요.'});}
  if(before>0&&!result.hasMore&&debugLastTotal!==null&&result.total>debugLastTotal&&!debugPendingCount)debugPendingCount={at:now};
  debugLastTotal=result.total;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
   if(g!==generation||room?.tweet!==post)return;
   if(debugPendingCount&&seen.size>before){
    if(auto&&!document.hidden)debugSend({event:'latency-sample',ms:performance.now()-debugPendingCount.at,at:Date.now()});
    else debugSend({event:'latency-status',status:'자동 스크롤 해제 또는 백그라운드 상태라 이번 표본은 제외했어요.'});
    debugPendingCount=null;
   }else if(debugPendingCount)debugSend({event:'latency-status',status:'답글 수 증가 확인 · 새 채팅 표시 대기 중'});
  }));
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
