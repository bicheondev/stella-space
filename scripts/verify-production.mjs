if(!process.env.COLLECTOR_SECRET)throw Error('COLLECTOR_SECRET must be provided by a trusted runtime');
const origin=process.env.SITE_URL||'https://stellive-space.vercel.app';
const heartbeat=await fetch(origin+'/api/heartbeat',{headers:{Authorization:'Bearer '+process.env.COLLECTOR_SECRET.trim()},signal:AbortSignal.timeout(55000)});
const body=await heartbeat.text();let data;try{data=JSON.parse(body);}catch{data={error:body};}console.log(JSON.stringify({status:heartbeat.status,liveCount:data.liveCount,rooms:data.rooms,error:data.error}));
if(!heartbeat.ok)process.exitCode=1;
