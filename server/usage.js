import {readFileSync} from 'node:fs';
const seed=JSON.parse(readFileSync(new URL('./usage-snapshots.json',import.meta.url),'utf8'));
const definitions={
 vercel:{name:'Vercel',period:'rolling30',url:'https://vercel.com/bicheondevs-projects/~/usage',metrics:[['cpuSeconds','CPU 실행 시간',14400,'seconds'],['memoryGBh','메모리 실행량',360,'GBh'],['invocations','함수 호출',1000000,'count'],['cdnRequests','CDN 요청',1000000,'count']]},
 cloudflare:{name:'Cloudflare',period:'daily',url:'https://dash.cloudflare.com/4465bbcc09f7b9f879ca63f37780539d/workers/durable-objects',metrics:[['workerRequests','Worker 요청',100000,'count'],['doRequests','Durable Object 요청',100000,'count'],['durationGBs','Durable Object 실행량',13000,'GBs'],['rowsRead','SQL 읽기',5000000,'count'],['rowsWritten','SQL 쓰기',100000,'count']]},
 turso:{name:'Turso',period:'monthly',url:'https://app.turso.tech/vercel-icfg-gzbu4kpfyqxxo2dtjuz3abt3',metrics:[['rowsRead','읽기',500000000,'count'],['rowsWritten','쓰기',10000000,'count'],['storageBytes','저장공간',5000000000,'bytes']]}
};
const caches=new WeakMap();
export function usageDashboard(snapshot=seed,now=Date.now()){
 return{checkedAt:new Date(now).toISOString(),automatic:false,providers:Object.entries(definitions).map(([id,def])=>{
  const saved=snapshot?.providers?.[id],at=Date.parse(saved?.checkedAt),valid=Number.isFinite(at)&&at<=now+60000;
  const sameDay=valid&&Math.floor(at/86400000)===Math.floor(now/86400000),expired=def.period==='daily'&&!sameDay;
  const resetsAt=def.period==='daily'?new Date((Math.floor(now/86400000)+1)*86400000).toISOString():def.period==='monthly'&&Date.parse(saved?.resetsAt)>now?saved.resetsAt:null;
  return{id,name:def.name,url:def.url,period:def.period,resetsAt,checkedAt:valid?saved.checkedAt:null,source:valid?saved.source:'사용량 조회 연결 필요',status:!valid?'unavailable':expired?'expired':now-at>3600000?'stale':'snapshot',resetLabel:def.period==='rolling30'?'최근 30일 · 고정 초기화 없음':def.period==='daily'?'매일 오전 9시 KST 초기화':resetsAt?'월 사용량 주기':'월 사용량 · 초기화 시각 미확인',metrics:def.metrics.map(([key,label,limit,unit])=>{const value=saved?.metrics?.[key],used=valid&&!expired&&typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;return{key,label,limit,unit,used,leftPercent:used===null?null:Math.max(0,Math.min(100,(1-used/limit)*100))};})};
 })};
}
export function validateUsage(snapshot,now=Date.now()){
 if(!snapshot||typeof snapshot!=='object'||!snapshot.providers||Array.isArray(snapshot.providers))throw Error('서비스별 확인값을 입력해 주세요.');
 const providers={};
 for(const [id,value]of Object.entries(snapshot.providers)){
  const def=definitions[id],at=Date.parse(value?.checkedAt);if(!def||!Number.isFinite(at)||at>now+60000||now-at>31*86400000)throw Error('서비스와 확인 시각을 확인해 주세요.');
  if(value.period!==def.period)throw Error('사용량 집계 주기가 맞지 않습니다.');
  const metrics={};for(const [key]of def.metrics){const n=value.metrics?.[key];if(n===undefined)continue;if(typeof n!=='number'||!Number.isFinite(n)||n<0)throw Error('사용량은 0 이상의 숫자여야 합니다.');metrics[key]=n;}
  if(!Object.keys(metrics).length)throw Error('확인된 사용량이 없습니다.');
  const resetsAt=value.resetsAt?new Date(value.resetsAt).toISOString():undefined;
  providers[id]={checkedAt:new Date(at).toISOString(),source:'관리자가 확인한 실측값',period:def.period,metrics,...(resetsAt&&def.period==='monthly'?{resetsAt}:{})};
 }
 if(!Object.keys(providers).length)throw Error('확인된 서비스가 없습니다.');return{version:1,providers};
}
export async function readUsage(db,{now=Date.now()}={}){
 let cached=caches.get(db);if(!cached||now-cached.at>300000){let snapshot=seed;try{const row=await db.prepare("SELECT value FROM operations_settings WHERE key='usage_snapshot'").bind().first();if(row)snapshot={version:1,providers:{...seed.providers,...validateUsage(JSON.parse(row.value),now).providers}};}catch{}cached={at:now,snapshot};caches.set(db,cached);}return usageDashboard(cached.snapshot,now);
}
export async function saveUsage(db,input,{now=Date.now()}={}){
 const next=validateUsage(input,now);let saved={};const row=await db.prepare("SELECT value FROM operations_settings WHERE key='usage_snapshot'").bind().first();if(row)try{saved=JSON.parse(row.value).providers||{}}catch{}
 const snapshot={version:1,providers:{...saved,...next.providers}};
 await db.prepare("INSERT INTO operations_settings(key,value) VALUES('usage_snapshot',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value RETURNING key").bind(JSON.stringify(snapshot)).first();caches.delete(db);return readUsage(db,{now});
}
