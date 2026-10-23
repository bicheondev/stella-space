const action=process.argv[2]||'status';
if(!['status','events','start','stop','retire-previous'].includes(action))throw Error('Use status, start, stop, or retire-previous');
const secret=process.env.CLOUDFLARE_COLLECTOR_SECRET;
if(!secret)throw Error('CLOUDFLARE_COLLECTOR_SECRET is required');
const response=await fetch('https://spacelive-realtime.bicheondev.workers.dev/control/'+action,{method:['status','events'].includes(action)?'GET':'POST',headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('Control request failed: '+response.status);
const data=await response.json();
if(action==='status')console.log(JSON.stringify({revision:data.revision,ready:data.ready,enabled:data.enabled,startedAt:data.startedAt,connections:data.connections,metrics:data.metrics,budget:data.budget,notification:data.notification,lastError:data.lastError,members:data.members?.map(({handle,status,state,checkedAt,discoveryWarning})=>({handle,status,state,checkedAt,warning:discoveryWarning}))},null,2));
else console.log(JSON.stringify(data));
