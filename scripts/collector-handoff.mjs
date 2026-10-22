// Only the current shared receiver may schedule a successor. No personal token is stored.
export function successorScheduler({repository,token,runId,fetcher=fetch,clock=Date.now}){
 let nextAttempt=0,done=false;
 return async function schedule({owner,elapsed}){
  if(!owner||done||elapsed<240000||clock()<nextAttempt||!repository||!token)return false;
  nextAttempt=clock()+30000;
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  const root='https://api.github.com/repos/'+repository+'/actions';
  // Cron/manual runs may already have supplied a successor; reuse it instead of multiplying runs.
  const response=await fetcher(root+'/workflows/collector.yml/runs?per_page=10',{headers,signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('다음 수집기 확인 실패 ('+response.status+')');
  const {workflow_runs:runs=[]}=await response.json();
  if(runs.some(r=>Number(r.id)>Number(runId)&&['queued','in_progress','waiting','requested','pending'].includes(r.status))){done=true;return true;}
  const dispatched=await fetcher(root+'/workflows/collector.yml/dispatches',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({ref:'main'}),signal:AbortSignal.timeout(10000)});
  if(dispatched.status!==204)throw Error('다음 수집기 시작 실패 ('+dispatched.status+')');done=true;return true;
 };
}
