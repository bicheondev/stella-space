// One coordinator owns the rolling 30-day allocation; viewers never spend it.
// Persist reservations before I/O, so a restart can only overcount, not reset it.
const DAY=86400000;
export function createVercelReplies({origin,secret,storage,fetcher=fetch,now=Date.now,onEvent=()=>{},monthlyLimit=250000}){
 if(origin!=='https://spacelive.vercel.app'||!secret)throw Error('Invalid Vercel reply relay configuration');
 let buckets=null,used=0,reserving=Promise.resolve();
 const day=()=>Math.floor(now()/DAY);
 const snapshot=()=>({windowDays:30,used,limit:monthlyLimit});
 async function reserve(){
  const task=reserving.catch(()=>{}).then(async()=>{
   if(!buckets){const saved=await storage.get('vercel-replies-budget');buckets=saved?.buckets||[];for(const b of buckets)b.used=b.reserved;}
   buckets=buckets.filter(b=>b.day>day()-30);used=buckets.reduce((sum,b)=>sum+b.used,0);
   if(used>=monthlyLimit){const error=Error('Vercel 답글 조회의 30일 안전 한도에 도달했습니다. 운영 콘솔에서 확인해 주세요.');error.status=503;error.retryAt=now()+60000;onEvent('relay.budget-exhausted',snapshot());throw error;}
   let bucket=buckets.find(b=>b.day===day());if(!bucket){bucket={day:day(),used:0,reserved:0};buckets.push(bucket);}
   if(bucket.used>=bucket.reserved){const reservedTotal=buckets.reduce((s,b)=>s+b.reserved,0);if(reservedTotal>=monthlyLimit)throw Object.assign(Error('Vercel 답글 조회의 30일 안전 한도 예약분이 소진되었습니다.'),{status:503,retryAt:now()+60000});bucket.reserved+=Math.min(100,monthlyLimit-reservedTotal);await storage.put('vercel-replies-budget',{buckets:buckets.map(({day,reserved})=>({day,reserved}))});}
   bucket.used++;used++;
   if(used===Math.floor(monthlyLimit*.8))onEvent('relay.budget-warning',snapshot());
  });reserving=task;return task;
 }
 return {status:snapshot,async fetch(url,init={}){
  const match=new URL(url).pathname.match(/^\/2\/conversation\/(\d{2,20})$/);if(!match)throw Error('Invalid reply relay target');
  await reserve();const target=new URL('/api/internal/fx-query',origin);target.searchParams.set('id',match[1]);
  return fetcher(target.href,{...init,headers:{authorization:'Bearer '+secret.trim()},redirect:'error'});
 }};
}
