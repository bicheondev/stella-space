// Runs only in the authenticated debugging frame; normal chat stays unchanged.
export const debugChatScript=String.raw`
const debugSend=value=>parent.postMessage({type:'space-debug',...value},location.origin);
const debugOriginalApi=api;
api=async function(path){
 const requestId=crypto.randomUUID();debugSend({event:'request',path,requestId,at:Date.now()});
 try{const result=await debugOriginalApi(path);debugSend({event:'response',path,requestId,at:Date.now(),result});
 if(path.startsWith('/api/resolve')&&result.handle&&!groups.flatMap(g=>g[2]).some(m=>m[1]===result.handle)){$('selectedName').textContent=result.handle;$('selectedHandle').textContent='테스트 계정';avatar($('selectedAvatar'),result.handle,result.avatar,result.state==='Running');}
 return result;
 }catch(error){debugSend({event:'failure',path,requestId,at:Date.now(),error:error.message});throw error;}
};
const debugButton=document.createElement('button');debugButton.className='iconbtn';debugButton.title='Space 또는 공유 게시물 URL 테스트';debugButton.setAttribute('aria-label',debugButton.title);debugButton.textContent='🔗';
debugButton.onclick=()=>{const value=prompt('X Space 또는 Space 공유 게시물 URL을 입력해 주세요.');if(value?.trim())connect(value.trim());};document.querySelector('.toolbar-actions').prepend(debugButton);
$('connection').hidden=false;
addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='debug-connect')return;connect(String(event.data.url||''));});
`;
