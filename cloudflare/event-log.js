// Durable audit trail: metadata only, never cookies, tokens, message bodies or headers.
const FIELDS=new Set(['handle','space','postId','source','status','state','previousStatus','previousState','startedAt','endedAt','postedAt','durationMs','count','fromPush','observedAt','pushReceivedAt','code','key']);
export function createEventLog(storage,{now=Date.now}={}){
 const sql=storage.sql;let queue=[],lastPrune=0,dropped=0;
 if(sql)sql.exec('CREATE TABLE IF NOT EXISTS diagnostic_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)');
 const seen=new Set();
 if(sql)sql.exec('CREATE TABLE IF NOT EXISTS post_observations (post_id TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(post_id,source))');
 return{
  record(kind,data={}){if(kind==='post.observed'){const key=data.source+':'+data.postId;if(seen.has(key))return;if(sql){const inserted=[...sql.exec('INSERT INTO post_observations(post_id,source,at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING post_id',String(data.postId),String(data.source),now())];if(!inserted.length){seen.add(key);return;}}seen.add(key);if(seen.size>10000)seen.delete(seen.values().next().value);}const payload={};for(const [key,value]of Object.entries(data))if(FIELDS.has(key)&&['string','number','boolean'].includes(typeof value))payload[key]=typeof value==='string'?value.slice(0,150):value;queue.push({at:now(),kind:String(kind).slice(0,60),payload});if(queue.length>2000){queue.shift();dropped++;}if(/^(push\.|member\.|post\.|space\.|coordinator\.)/.test(kind))this.flush();},
  flush(){if(!sql)return;const batch=queue;queue=[];try{storage.transactionSync(()=>{for(const e of batch)sql.exec('INSERT INTO diagnostic_events(at,kind,payload) VALUES(?,?,?)',e.at,e.kind,JSON.stringify(e.payload));if(now()-lastPrune>86400000){sql.exec('DELETE FROM diagnostic_events WHERE at < ?',now()-30*86400000);sql.exec('DELETE FROM post_observations WHERE at < ?',now()-30*86400000);lastPrune=now();}});}catch(error){queue=[...batch,...queue].slice(-2000);console.error('Diagnostic log persistence failed');}},
  read(after=0){this.flush();return{events:sql?[...sql.exec('SELECT id,at,kind,payload FROM diagnostic_events WHERE id > ? ORDER BY id LIMIT 500',after)].map(e=>({...e,payload:JSON.parse(e.payload)})):[],retentionDays:30,dropped};}
 };
}
