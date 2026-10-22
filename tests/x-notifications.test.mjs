import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {saveXSession,notificationConfig,notificationStatus,receiveNotificationEvent,validateXSession,collectorAuthorized} from '../server/x-notifications.js';
import {notificationPosts,notificationFrame} from '../scripts/x-notifications.mjs';
import {ingestNotificationPosts} from '../worker/index.js';
import {operations} from '../server/operations.js';
function fixture(){const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../drizzle/0000_windy_bushwacker.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../server/session-schema.sql',import.meta.url),'utf8'));return{sqlite,db:{prepare(sql){return{bind(...args){return{async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return{results:sqlite.prepare(sql).all(...args)}}}}}}}};}
const session={auth_token:'a'.repeat(40),ct0:'b'.repeat(64),expectedHandle:'checkerun23'};
test('bot sessions verify the intended account and are encrypted, never returned to the dashboard',async()=>{
 process.env.OPERATIONS_SECRET='test-ops-secret';const{sqlite,db}=fixture();try{
 assert.throws(()=>validateXSession({...session,ct0:'x\r\ncookie: bad'}));
 await assert.rejects(()=>saveXSession(db,session,{fetcher:async()=>Response.json({id_str:'12345',screen_name:'wrong_account'})}),/다릅니다/);
 assert.equal(await notificationConfig(db),null);
 await saveXSession(db,session,{fetcher:async(url,options)=>{assert.equal(new URL(url).hostname,'api.x.com');assert(options.headers.cookie.includes(session.auth_token));return Response.json({id_str:'12345',screen_name:'checkerun23'})}});
 const encrypted=sqlite.prepare("SELECT value FROM operations_settings WHERE key='x_notification_config'").get().value;assert(!encrypted.includes(session.auth_token));
 assert.equal((await notificationConfig(db)).auth_token,session.auth_token);const status=await notificationStatus(db);assert.equal(status.handle,'checkerun23');assert.equal(status.healthy,false);assert(!JSON.stringify(status).includes(session.auth_token));
 }finally{sqlite.close()}
});
test('notification credentials and ingestion require the background collector secret',async()=>{
 process.env.OPERATIONS_SECRET='test-ops-secret';process.env.COLLECTOR_SECRET='test-background-secret';const{sqlite,db}=fixture();try{
 assert(!collectorAuthorized('Bearer wrong'));assert(collectorAuthorized('Bearer test-background-secret'));
 for(const path of ['/api/notification-config','/api/notification-event','/api/admin/x-notifications'])assert.equal((await operations({method:'GET',headers:{}},new URL(path,'https://stellive-space.vercel.app'),db)).status,404);
 }finally{sqlite.close()}
});
test('only registered authors and original posts leave the notification inbox',()=>{
 const data={globalObjects:{users:{one:{screen_name:'HanayoHiyori'},two:{screen_name:'unrelated'}},tweets:{'123':{user_id_str:'one',full_text:'Space https://t.co/abc',entities:{urls:[{url:'https://t.co/abc',expanded_url:'https://x.com/i/spaces/abcdef123'}]}},'124':{user_id_str:'two',text:'private unrelated'},'125':{user_id_str:'one',text:'RT',retweeted_status_id_str:'999'}}}};
 const posts=notificationPosts(data);assert.equal(posts.length,1);assert(posts[0].text.includes('/i/spaces/abcdef123'));assert(!JSON.stringify(posts).includes('private unrelated'));assert.throws(()=>notificationPosts({}));assert(notificationFrame({topic:'notification:12345'}));assert(!notificationFrame({topic:'/dm_update/123'}));
});
test('ingestion deduplicates notifications and only a confirmed live push enables slow fallback',async()=>{
 const{sqlite,db}=fixture();try{const post={id:'123',text:'Space https://x.com/i/spaces/abcdef123',author:{screen_name:'HANAYOHIYORI'}};
 assert.equal(await ingestNotificationPosts(db,[post,{...post,id:'456',author:{screen_name:'unrelated'}}]),1);await ingestNotificationPosts(db,[post]);const saved=JSON.parse(sqlite.prepare("SELECT payload FROM collector_entries WHERE key='notification-posts:HanayoHiyori'").get().payload);assert.equal(saved.posts.length,1);
 await receiveNotificationEvent(db,{mode:'connecting'});assert.equal((await notificationStatus(db)).healthy,false);await receiveNotificationEvent(db,{mode:'polling'});assert.equal((await notificationStatus(db)).healthy,false);await receiveNotificationEvent(db,{mode:'push',lastPushAt:Date.now()});assert.equal((await notificationStatus(db)).healthy,true);
 await receiveNotificationEvent(db,{mode:'error'});assert.equal((await notificationStatus(db)).healthy,false);
 }finally{sqlite.close()}
});
