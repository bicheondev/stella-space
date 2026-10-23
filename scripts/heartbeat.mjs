import {setTimeout as delay} from 'node:timers/promises';
import {successorScheduler} from './collector-handoff.mjs';
import {watchXNotifications} from './x-notifications.mjs';
import {pathToFileURL} from 'node:url';
export async function runHeartbeat({environment=process.env,fetcher=fetch,watchNotifications=watchXNotifications,makeScheduler=successorScheduler,sleep=delay,clock=Date.now,logger=console,signal}={}){
 const origin=environment.SITE_URL||'https://spacelive.vercel.app',secret=environment.COLLECTOR_SECRET?.trim();
 if(!secret)throw Error('COLLECTOR_SECRET is missing');
 // Check the migration gate before acquiring a push lease or scheduling another
 // Actions run. During a cutover an already-running receiver is aborted too.
 const started=clock(),deadline=started+360000;let receiverOwner=false,notificationTask=null,migrated=false;
 const scheduleSuccessor=makeScheduler({repository:environment.GITHUB_REPOSITORY,runId:environment.GITHUB_RUN_ID,token:environment.GH_HANDOFF_TOKEN});
 const notificationAbort=new AbortController(),abort=()=>notificationAbort.abort();
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 try{
  while(clock()<deadline&&!notificationAbort.signal.aborted){
   const start=clock();let interval=5000;
   try{
    const response=await fetcher(origin+'/api/heartbeat',{headers:{Authorization:'Bearer '+secret},signal:AbortSignal.any([notificationAbort.signal,AbortSignal.timeout(55000)])});
    if(!response.ok)throw Error('HTTP '+response.status);
    const data=await response.json();
    if(data.migrated){migrated=true;logger.log('실시간 수집기가 이전되어 기존 수집기를 종료합니다.');break;}
    notificationTask||=Promise.resolve(watchNotifications({origin,secret,signal:notificationAbort.signal,onOwnership:owned=>{receiverOwner=owned}}));
    interval=data.liveCount?Math.max(100,data.pollIntervalMs||1000):5000;
    logger.log(new Date(clock()).toISOString(),JSON.stringify({live:data.liveCount,rooms:data.rooms?.length,stale:data.stale}));
    try{if(await scheduleSuccessor({owner:receiverOwner,elapsed:clock()-started}))logger.log('다음 수집기 준비 완료');}catch(e){logger.error(e.message);}
   }catch(e){if(!notificationAbort.signal.aborted)logger.error(e.message);interval=5000;}
   try{await sleep(Math.max(50,interval-(clock()-start)),null,{signal:notificationAbort.signal});}catch{break;}
  }
 }finally{
  notificationAbort.abort();signal?.removeEventListener('abort',abort);
  try{await notificationTask;}catch(e){logger.error(e.message);}
 }
 return{migrated};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const controller=new AbortController(),abort=()=>controller.abort();
 for(const event of ['SIGTERM','SIGINT'])process.once(event,abort);
 try{await runHeartbeat({signal:controller.signal});}finally{for(const event of ['SIGTERM','SIGINT'])process.removeListener(event,abort);}
}
