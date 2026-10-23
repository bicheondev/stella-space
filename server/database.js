import {readFileSync} from 'node:fs';
import {createClient} from '@libsql/client';
let client,ready;
export function database(){
 if(!process.env.TURSO_DATABASE_URL)throw Error('공유 데이터베이스 연결이 필요합니다.');
 client||=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
 ready||=(async()=>{await client.execute(`CREATE TABLE IF NOT EXISTS collector_entries (key TEXT PRIMARY KEY,payload TEXT,next_poll_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT NOT NULL DEFAULT '',last_started_at INTEGER NOT NULL DEFAULT 0,fetch_count INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0,last_error TEXT)` );await client.executeMultiple(readFileSync(new URL('./session-schema.sql',import.meta.url),'utf8'));const columns=(await client.execute('PRAGMA table_info(feedback_messages)')).rows;if(!columns.some(c=>c.name==='urgent'))try{await client.execute('ALTER TABLE feedback_messages ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0')}catch(e){if(!(await client.execute('PRAGMA table_info(feedback_messages)')).rows.some(c=>c.name==='urgent'))throw e;}})().catch(e=>{ready=null;throw e;});
 return{prepare(sql){return{bind(...args){const execute=async()=>{await ready;return client.execute({sql,args});};return{async first(){return(await execute()).rows[0]||null;},async all(){return{results:(await execute()).rows};}};}};}};
}
