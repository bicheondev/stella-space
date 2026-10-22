const origin=process.env.SITE_URL||'https://stellive-space.vercel.app';
if(!process.env.COLLECTOR_SECRET)throw Error('COLLECTOR_SECRET is missing');
const deadline=Date.now()+270000;
while(Date.now()<deadline){
 const start=Date.now();let interval=5000;
 try{const response=await fetch(origin+'/api/heartbeat',{headers:{Authorization:'Bearer '+process.env.COLLECTOR_SECRET.trim()},signal:AbortSignal.timeout(55000)});if(!response.ok)throw Error('HTTP '+response.status);const data=await response.json();interval=data.liveCount?Math.max(100,data.pollIntervalMs||1000):5000;console.log(new Date().toISOString(),JSON.stringify({live:data.liveCount,rooms:data.rooms?.length,stale:data.stale}));}catch(e){console.error(e.message);interval=5000;}
 await new Promise(r=>setTimeout(r,Math.max(50,interval-(Date.now()-start))));
}
