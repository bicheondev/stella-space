import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';
import {readFileSync} from 'node:fs';
import {operations,authorized} from '../server/operations.js';
test('operations access is private and analytics deduplicates visitors across days and routes',async()=>{
 process.env.OPERATIONS_SECRET='test-private-secret';
 const client=createClient({url:':memory:'});await client.executeMultiple(readFileSync(new URL('../server/session-schema.sql',import.meta.url),'utf8'));await client.execute('CREATE TABLE collector_entries(key TEXT,payload TEXT,next_poll_at INTEGER,lease_until INTEGER,last_started_at INTEGER,fetch_count INTEGER,failure_count INTEGER,last_error TEXT)');
 const db={prepare(sql){return{bind(...args){return{async first(){return(await client.execute({sql,args})).rows[0]},async all(){return{results:(await client.execute({sql,args})).rows}}}}}}};
 const url=p=>new URL(p,'https://stellive-space.vercel.app');
 assert.equal((await operations({headers:{}},url('/api/admin/overview'),db)).status,404);
 const page=await operations({headers:{}},url('/ops-test-private-secret'),null);assert.equal(page.status,200);assert.equal(page.headers.get('x-robots-tag'),'noindex, nofollow');const cookie=page.headers.get('set-cookie').split(';')[0];assert(authorized(cookie));assert(!authorized('ops=wrong'));
 const req={method:'POST',headers:{origin:'https://stellive-space.vercel.app','x-vercel-ip-country':'KR'},body:{id:'12345678-1234-1234-1234-123456789abc',path:'/GANGZIIII',referrer:'https://example.com/post'}};
 for(let i=0;i<2;i++)assert.equal((await operations(req,url('/api/visit'),db)).status,200);
 const data=await(await operations({headers:{cookie}},url('/api/admin/overview'),db)).json();assert.equal(data.totals[0].dau,1);assert.equal(data.totals[0].mau,1);assert.equal(data.totals[0].views,2);assert.equal(data.countries[0].country,'KR');assert.equal(data.referrers[0].referrer,'example.com');assert(!JSON.stringify(data).includes(req.body.id));
 assert.equal((await operations({...req,headers:{origin:'https://evil.example'}},url('/api/visit'),db)).status,403);client.close();
});
