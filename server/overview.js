// Private console only. Collection and public chat do not use these caches.
export function createOverviewReader({now=Date.now}={}){
 let overview=null,overviewAt=0,pending=null,archives=null,archivesAt=0,archivePending=null,version=0;
 const unpack=r=>{if(!r.payload)return r;let p={};try{p=JSON.parse(r.payload)}catch{}const {payload,...rest}=r;return{...rest,status:p.status,state:p.state,checkedAt:p.checkedAt,source:p.discoverySource||p.source,warning:p.discoveryWarning||p.warning,title:p.title,space:p.space,avatar:p.avatar,handle:p.handle||r.handle,messages:p.messages?.length??r.messages,rooms:p.rooms,collecting:p.collecting,stopped:p.stopped,pollIntervalMs:p.pollIntervalMs};};
 async function counts(db){
  if(archives&&now()-archivesAt<10000)return archives;
  if(archivePending)return archivePending;
  const v=version;
  const task=db.prepare('SELECT post_id,COUNT(*) messages FROM broadcast_messages GROUP BY post_id').bind().all().then(r=>{if(v===version){archives=r.results;archivesAt=now();}return r.results;});
  archivePending=task;try{return await task}finally{if(archivePending===task)archivePending=null;}
 }
 async function read(db){
  if(overview&&now()-overviewAt<1500)return{...overview,now:now()};
  if(pending)return pending;
  const v=version;
  const task=(async()=>{
   const [a,c,s,e]=await Promise.all([counts(db),db.prepare("SELECT key,payload,next_poll_at,lease_until,last_started_at,fetch_count,failure_count,last_error FROM collector_entries WHERE key NOT LIKE 'budget:%'").bind().all(),db.prepare('SELECT handle,post_id,space_id,started_at,payload FROM broadcast_sessions').bind().all(),db.prepare('SELECT * FROM collector_errors ORDER BY id DESC LIMIT 100').bind().all()]);
   const byPost=new Map(a.map(r=>[r.post_id,r.messages]));
   const result={now:now(),timezone:'Asia/Seoul',archives:a,collectors:c.results.map(unpack),sessions:s.results.map(r=>unpack({...r,messages:byPost.get(r.post_id)||0})),errors:e.results};
   if(v===version){overview=result;overviewAt=now();}return result;
  })();pending=task;try{return await task}finally{if(pending===task)pending=null;}
 }
 read.invalidate=()=>{version++;overview=null;archives=null;pending=null;archivePending=null;};return read;
}
export const readOverview=createOverviewReader();
