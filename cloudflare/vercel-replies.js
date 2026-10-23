// Only this single coordinator can spend the monthly relay allocation. Viewer
// requests never call it. Reserve before I/O; persist before batches of 100 so
// restarts cannot reset or undershoot the counter.
export function createVercelReplies({origin,secret,storage,fetcher=fetch,now=Date.now,onEvent=()=>{},monthlyLimit=250000}){
 if(origin!=='https://spacelive.vercel.app'||!secret)throw Error('Invalid Vercel reply relay configuration');
 let state=null,loading=null,reserving=Promise.resolve();
 const period=()=>new Date(now()).toISOString().slice(0,7);
 const snapshot=()=>({...state,limit:monthlyLimit});
 async function reserve(){
  const task=reserving.catch(()=>{}).then(async()=>{
   if(!state){loading||=storage.get('vercel-replies-budget');const saved=await loading;state=saved?.period===period()?{...saved,used:saved.reserved}: {period:period(),used:0,reserved:0};}
   if(state.period!==period())state={period:period(),used:0,reserved:0};
   if(state.used>=monthlyLimit){const error=Error('Vercel 답글 조회의 월 안전 한도에 도달했습니다. 운영 콘솔에서 확인해 주세요.');error.status=503;error.retryAt=now()+60000;onEvent('relay.budget-exhausted',snapshot());throw error;}
   if(state.used>=state.reserved){const next=Math.min(monthlyLimit,state.used+100);await storage.put('vercel-replies-budget',{period:state.period,reserved:next});state.reserved=next;}
   state.used++;
   if(state.used===Math.floor(monthlyLimit*.8))onEvent('relay.budget-warning',snapshot());
  });reserving=task;return task;
 }
 return {status:snapshot,async fetch(url,init={}){
  const match=new URL(url).pathname.match(/^\/2\/conversation\/(\d{2,20})$/);if(!match)throw Error('Invalid reply relay target');
  await reserve();const target=new URL('/api/internal/fx-query',origin);target.searchParams.set('id',match[1]);
  return fetcher(target.href,{...init,headers:{authorization:'Bearer '+secret.trim()},redirect:'error'});
 }};
}
