import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {operations,authorized} from '../server/operations.js';
import {visitorAnalytics,encryptToken,decryptToken,saveAnalyticsToken} from '../server/visitor-analytics.js';
async function fixture(){const client=createClient({url:':memory:'});await client.executeMultiple(readFileSync(new URL('../server/session-schema.sql',import.meta.url),'utf8'));await client.execute('CREATE TABLE collector_entries(key TEXT,payload TEXT,next_poll_at INTEGER,lease_until INTEGER,last_started_at INTEGER,fetch_count INTEGER,failure_count INTEGER,last_error TEXT)');return{client,db:{prepare(sql){return{bind(...args){return{async first(){return(await client.execute({sql,args})).rows[0]},async all(){return{results:(await client.execute({sql,args})).rows}}}}}}}};}
const url=p=>new URL(p,'https://stellive-space.vercel.app');
test('private console removes own tracking and protects analytics read and connection endpoints',async()=>{
 process.env.OPERATIONS_SECRET='test-private-secret';
 const {client,db}=await fixture();try{
 for(const path of ['/api/admin/overview','/api/admin/analytics','/api/admin/analytics/connect'])assert.equal((await operations({headers:{}},url(path),db)).status,404);
 const page=await operations({headers:{}},url('/ops-test-private-secret'),null),html=await page.text();assert.equal(page.headers.get('x-robots-tag'),'noindex, nofollow');const cookie=page.headers.get('set-cookie').split(';')[0];assert(authorized(cookie));assert(!authorized('ops=wrong'));assert(!authorized('ops=한'.repeat(32)));
 assert(!html.includes('googletagmanager.com'));assert(!html.includes('sendBeacon'));assert(html.includes('view-connections'));assert(html.includes('memberSearch'));new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 assert.equal((await operations({headers:{},method:'POST'},url('/api/visit'),db)).status,410);
 assert.equal((await operations({method:'POST',headers:{cookie,origin:'https://evil.example'},body:{token:'x'.repeat(30)}},url('/api/admin/analytics/connect'),db)).status,403);
 assert.equal((await operations({method:'GET',headers:{cookie}},url('/api/admin/analytics/connect'),db)).status,405);
 const result=await(await operations({headers:{cookie}},url('/api/admin/analytics'),db)).json();assert.equal(result.status,'disconnected');assert(!('totals'in result));
 await client.execute({sql:'INSERT INTO broadcast_sessions(handle,post_id,space_id,started_at,payload) VALUES(?,?,?,?,?)',args:['HanayoHiyori','123','space',1000,JSON.stringify({state:'Ended'})]});
 const data=await(await operations({headers:{cookie}},url('/api/admin/overview'),db)).json();assert.equal(data.sessions[0].handle,'HanayoHiyori');assert(!('totals'in data));assert(!JSON.stringify(data).includes('lease_token'));
 }finally{client.close()}
});
test('Vercel analytics uses official responses, preserves zeros and caches without exposing credentials',async()=>{
 process.env.OPERATIONS_SECRET='test-private-secret';const {client,db}=await fixture();const token='test-analytics-access-token',cipher=encryptToken(token);assert(!cipher.includes(token));assert.equal(decryptToken(cipher),token);
 await client.execute({sql:"INSERT INTO operations_settings(key,value) VALUES('analytics_token',?)",args:[cipher]});
 let calls=0;const now=Date.parse('2026-10-22T16:00:00Z'),fetcher=async(u,opts)=>{calls++;assert.equal(opts.headers.Authorization,'Bearer '+token);assert.equal(u.hostname,'api.vercel.com');assert.equal(u.pathname.endsWith('/aggregate'),true);assert.equal(u.searchParams.get('projectId'),'prj_TLbO1f29sNjvpfTNV478OLxPV15k');const by=u.searchParams.get('by');if(by==='environment'){const start=Date.parse(u.searchParams.get('since'));assert.equal(new Date(start).getUTCHours(),15);assert(Date.parse(u.searchParams.get('until'))<=now);if(u.searchParams.get('since')==='2026-10-22T15:00:00.000Z')assert.equal(u.searchParams.get('until'),'2026-10-22T16:00:00.000Z');}else{assert.equal(u.searchParams.get('since'),'2026-10-16T15:00:00.000Z');assert.equal(u.searchParams.get('until'),'2026-10-22T16:00:00.000Z');}return Response.json({data:by==='environment'?[{environment:'production',visitors:0,pageviews:0}]:[]})};
 try{const data=await visitorAnalytics(db,{now,fetcher});assert.equal(data.status,'connected');assert.equal(data.totals.visitors,0);assert.equal(data.daily.length,7);assert.equal(data.daily.at(-1).timestamp,'2026-10-23T00:00:00+09:00');assert.equal(data.since,'2026-10-17');assert.equal(data.timezone,'Asia/Seoul');assert(!JSON.stringify(data).includes(token));assert.equal(calls,10);
 await visitorAnalytics(db,{now:now+1000,fetcher});assert.equal(calls,10);
 const stale=await visitorAnalytics(db,{now:now+130000,fetcher:async()=>new Response('',{status:403})});assert.equal(stale.status,'stale');assert.equal(stale.totals.visitors,0);assert(stale.message.includes('권한'));
 }finally{client.close()}
});
test('analytics connection validates token upstream and stores only authenticated encryption',async()=>{
 process.env.OPERATIONS_SECRET='test-private-secret';const {client,db}=await fixture(),original=globalThis.fetch,token='test-new-analytics-token';
 try{globalThis.fetch=async()=>new Response('',{status:403});await assert.rejects(()=>saveAnalyticsToken(db,token),/권한/);assert.equal((await client.execute('SELECT * FROM operations_settings')).rows.length,0);
 globalThis.fetch=async()=>Response.json({data:{visitors:3,pageviews:5}});await saveAnalyticsToken(db,token);const row=(await client.execute("SELECT value FROM operations_settings WHERE key='analytics_token'")).rows[0];assert.equal(decryptToken(row.value),token);assert(!row.value.includes(token));const b=Buffer.from(row.value,'base64');b[13]^=1;assert.throws(()=>decryptToken(b.toString('base64')));
 }finally{globalThis.fetch=original;client.close()}
});
test('schema removes retired visitor data while keeping chat archive',async()=>{
 const client=createClient({url:':memory:'});try{await client.execute('CREATE TABLE visitor_daily(visitor TEXT)');await client.executeMultiple(readFileSync(new URL('../server/session-schema.sql',import.meta.url),'utf8'));const names=(await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(r=>r.name);assert(!names.includes('visitor_daily'));assert(names.includes('broadcast_messages'));assert(names.includes('operations_settings'));}finally{client.close()}
});
test('dashboard renders real metric zeros, member state, job failures and safely escaped content',()=>{
 const html=readFileSync(new URL('../server/operations.html',import.meta.url),'utf8');const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/renderAnalytics\(\);load\(\);loadAnalytics\(\);loadAnalytics\(analyticsProvider[\s\S]*$/,'');
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{value:id.endsWith('Filter')?'all':'',innerHTML:'',textContent:'',checked:true,hidden:false,className:'',addEventListener(){},focus(){},style:{}});return elements.get(id)};
 const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],addEventListener(){},hidden:false},setInterval(){},Date,Number,String,Math,JSON,console});new vm.Script(script).runInContext(ctx);
 vm.runInContext(`data={now:Date.parse('2026-10-22T10:00:00Z'),collectors:[{key:'member:v2:HanayoHiyori',handle:'HanayoHiyori',status:'live',checkedAt:'2026-10-22T09:59:59Z',next_poll_at:0,lease_until:0},{key:'replies:fxtwitter:123',last_error:'<script>bad</script>',failure_count:2,next_poll_at:0,lease_until:0}],sessions:[{handle:'HanayoHiyori',post_id:'123',messages:45}],errors:[]};renderOverview();analytics={status:'connected',checkedAt:Date.now(),totals:{visitors:0,pageviews:0},daily:[{timestamp:'2026-10-22T00:00:00Z',visitors:0,pageviews:0}],countries:[],referrers:[],pages:[]};renderAnalytics();`,ctx);
 assert.equal(get('liveMembers').textContent,'1');assert.equal(get('storedMessages').textContent,'45');assert.equal(get('todayVisitors').textContent,'0');assert(get('membersTable').innerHTML.includes('하나요 히요리'));assert(get('jobsTable').innerHTML.includes('이번 확인을 마치지 못했어요'));assert(get('logAttention').innerHTML.includes('다음 동작'));assert(!get('jobsTable').innerHTML.includes('<script>bad'));assert(get('overviewChart').innerHTML.includes('<svg'));
 for(const [key,error,expected] of [
 ['timeline:fx:HanayoHiyori','외부 조회 오류 (404)','FxTwitter'],
 ['timeline:carry:HanayoHiyori','외부 조회 오류 (429)','CarryFeed'],
 ['timeline:carry:HanayoHiyori','보조 게시물 조회 대기 중','내부 수집기'],
 ['space:abcdef','외부 조회 오류 (429)','X API'],
 ['x-notifications:run','푸시 연결 대기','xnotif / Mozilla 푸시'],
 ['x-notifications:run','X 알림함 조회 실패 (429)','X API'],
 ['member:v2:HanayoHiyori','외부 조회 오류 (404) · /2/profile/test/statuses · 외부 조회 오류 (429) · /api/profile/test/statuses','FxTwitter / CarryFeed'],
 ['member:v2:HanayoHiyori','SQLITE_ERROR','공유 저장소 (Turso)'],
 ['member:v2:HanayoHiyori','원인 불명','수집기 · 원인 확인 중']
 ])assert.equal(vm.runInContext('issueProvider('+JSON.stringify({key,error})+')',ctx),expected);
 vm.runInContext("data.errors=[{id:1,key:'timeline:carry:HanayoHiyori',error:'외부 조회 오류 (429)',at:data.now}];renderOverview();",ctx);
 assert(get('recentErrors').innerHTML.includes('CarryFeed'));assert(get('errorsTable').innerHTML.includes('발생 위치 · CarryFeed'));assert(get('logAttention').innerHTML.includes('발생 위치 · FxTwitter'));

 vm.runInContext("data={now:Date.now(),collectors:[{key:'member:v2:HanayoHiyori',handle:'HanayoHiyori',status:'offline',checkedAt:new Date().toISOString(),lease_until:Date.now()+10000}],sessions:[],errors:[]};renderOverview();",ctx);
 assert(get('systemHealth').innerHTML.includes('방송 대기 중'));assert(!get('systemHealth').innerHTML.includes('답글 조회 중'));
 vm.runInContext("data.collectors.push({key:'replies:fxtwitter:123',lease_until:Date.now()+10000});renderOverview();",ctx);
 assert(get('systemHealth').innerHTML.includes('1개 답글 조회 중'));
 vm.runInContext("data.sessions=[{handle:'HanayoHiyori',post_id:'123',state:'Ended',messages:0}];renderOverview();",ctx);
 assert(get('systemHealth').innerHTML.includes('방송 대기 중'));
 vm.runInContext("data={now:Date.now(),collectors:[{key:'member:v2:HanayoHiyori',handle:'HanayoHiyori',status:'offline',source:'carry',checkedAt:new Date().toISOString(),lease_until:0},{key:'timeline:fx:HanayoHiyori',last_started_at:Date.now()-1000,last_error:'외부 조회 오류 (404)',lease_until:0}],sessions:[],errors:[]};renderOverview();",ctx);
 assert.equal(get('errorCount').textContent,0);assert(get('jobsTable').innerHTML.includes('대체 경로로 확인됨'));
 vm.runInContext("data.collectors.push({key:'timeline:fx:TokinoMery',last_error:'외부 조회 오류 (404)',lease_until:0});renderOverview();",ctx);assert.equal(get('errorCount').textContent,0);assert(get('jobsTable').innerHTML.includes('이전 대상 · 기록 보관'));
 vm.runInContext("data.collectors[0].warning='두 경로 모두 실패';renderOverview();",ctx);assert.equal(get('errorCount').textContent,1);
});
test('switching provider tabs never lets a late Vercel response overwrite the GA view',async()=>{
 const html=readFileSync(new URL('../server/operations.html',import.meta.url),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/renderAnalytics\(\);load\(\);loadAnalytics\(\);loadAnalytics\(analyticsProvider[\s\S]*$/,'');
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',setAttribute(){},focus(){},addEventListener(){}});return elements.get(id)},pending=[];
 const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},Date,Number,String,Math,JSON,fetch:path=>new Promise(resolve=>pending.push({path,resolve})),localStorage:{setItem(){},getItem(){return null}}});vm.runInContext(script,ctx);vm.runInContext("selectProvider('vercel');selectProvider('ga');",ctx);assert.equal(pending.length,2);
 pending[0].resolve(Response.json({status:'connected',totals:{visitors:99,pageviews:199},daily:[],pages:[],referrers:[],countries:[],timezone:'UTC'}));await new Promise(r=>setImmediate(r));assert.equal(get('todayVisitors').textContent,'—');assert.equal(get('analyticsSourceTitle').textContent,'Google Analytics 4');
 pending[1].resolve(Response.json({status:'disconnected',message:'GA 연결 필요'}));await new Promise(r=>setImmediate(r));assert.equal(get('todayVisitors').textContent,'—');assert(get('overviewChart').innerHTML.includes('GA 연결'));
 vm.runInContext("selectProvider('vercel')",ctx);assert.equal(get('todayVisitors').textContent,'99');assert.equal(get('analyticsSourceTitle').textContent,'Vercel Web Analytics');
});
test('live log updates announce only new errors and real chat changes, and preserve state during outages',async()=>{
 const html=readFileSync(new URL('../server/operations.html',import.meta.url),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/renderAnalytics\(\);load\(\);loadAnalytics\(\);loadAnalytics\(analyticsProvider[\s\S]*$/,'');
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{value:id.endsWith('Filter')?'all':'',checked:true,hidden:true,style:{},innerHTML:'',textContent:'',setAttribute(){},focus(){},addEventListener(){}});return elements.get(id)},timers=[];
 const base={now:Date.now(),collectors:[{key:'member:v2:HanayoHiyori',handle:'HanayoHiyori',status:'live',checkedAt:new Date().toISOString(),last_started_at:Date.now(),lease_until:Date.now()+5000,next_poll_at:Date.now()+6000}],sessions:[{handle:'HanayoHiyori',post_id:'123',space_id:'space',state:'Running',messages:2}],errors:[]};let response=base,fail=false;
 const ctx=vm.createContext({document:{getElementById:get,querySelectorAll:()=>[],addEventListener(){},hidden:false},setInterval(fn,ms){timers.push(ms)},setTimeout(){return 1},clearTimeout(){},Date,Number,String,Math,JSON,fetch:async()=>fail?Response.json({error:'temporary outage'},{status:503}):Response.json(response)});vm.runInContext(script,ctx);
 await vm.runInContext('load()',ctx);assert(get('logNow').innerHTML.includes('pulse-dot'));assert.equal(get('logNotification').hidden,true);
 response={...base,now:base.now+2000,sessions:[{...base.sessions[0],messages:5}],errors:[{id:1,at:base.now+1000,key:'replies:fxtwitter:123',error:'429 <script>bad</script>'}]};await vm.runInContext('load()',ctx);assert.equal(get('logNotification').hidden,false);assert(get('collectionActivity').textContent.includes('3개'));assert(get('errorsTable').innerHTML.includes('조회 요청이 잠시 몰렸어요'));assert(get('errorsTable').innerHTML.includes('&lt;script&gt;bad&lt;/script&gt;'));assert(!get('errorsTable').innerHTML.includes('<script>bad'));
 fail=true;await vm.runInContext('load()',ctx);assert.equal(get('globalError').hidden,false);assert(get('logLiveBadge').innerHTML.includes('연결 지연'));assert.equal(get('storedMessages').textContent,'5');assert(timers.includes(2000));assert(timers.includes(1000));
});

test('HTTP status takes precedence over misleading legacy error labels',()=>{
 const html=readFileSync(new URL('../server/operations.html',import.meta.url),'utf8');
 const fn=html.match(/function friendlyIssue\(error\)\{[^\n]+/)[0];
 const issue=vm.runInNewContext('('+fn+')');
 for(const [code,title]of [[404,'요청한 정보를 찾지 못했어요'],[410,'요청한 정보를 찾지 못했어요'],[401,'정보 제공처가 조회를 허용하지 않았어요'],[403,'정보 제공처가 조회를 허용하지 않았어요'],[429,'조회 요청이 잠시 몰렸어요'],[500,'정보 제공처와 연결이 원활하지 않아요'],[502,'정보 제공처와 연결이 원활하지 않아요'],[503,'정보 제공처와 연결이 원활하지 않아요'],[408,'응답을 기다리다 시간이 지났어요'],[504,'응답을 기다리다 시간이 지났어요'],[400,'조회 요청을 처리하지 못했어요']])assert.equal(issue('X 조회 제한 ('+code+') · /profile')[0],title);
 assert.equal(issue('공유 호출 예산 대기 중')[0],'조회 차례를 기다리고 있어요');
 assert.equal(issue('보조 게시물 조회 대기 중')[0],'조회 차례를 기다리고 있어요');
 assert.equal(issue('조회 제한')[0],'조회가 일시적으로 제한됐어요');
});

test('error history deletion is admin-only, same-origin and bounded so newer errors and active jobs survive',async()=>{
 process.env.OPERATIONS_SECRET='test-private-secret';const{client,db}=await fixture();
 try{
 await client.execute("INSERT INTO collector_errors(at,key,error) VALUES(1,'timeline:fx:test','old'),(2,'timeline:fx:test','old'),(3,'timeline:fx:test','new')");
 await client.execute("INSERT INTO collector_entries(key,last_error) VALUES('timeline:fx:test','active failure')");
 const page=await operations({headers:{}},url('/ops-test-private-secret'),null),cookie=page.headers.get('set-cookie').split(';')[0];
 assert.equal((await operations({method:'DELETE',headers:{},body:{through:2}},url('/api/admin/errors'),db)).status,404);
 assert.equal((await operations({method:'DELETE',headers:{cookie,origin:'https://evil.example'},body:{through:2}},url('/api/admin/errors'),db)).status,403);
 assert.equal((await operations({method:'GET',headers:{cookie}},url('/api/admin/errors'),db)).status,405);
 assert.equal((await operations({method:'DELETE',headers:{cookie,origin:url('/').origin},body:{through:'2'}},url('/api/admin/errors'),db)).status,400);
 const response=await operations({method:'DELETE',headers:{cookie,origin:url('/').origin},body:{through:2}},url('/api/admin/errors'),db);assert.equal((await response.json()).deleted,2);
 assert.equal((await client.execute('SELECT * FROM collector_errors')).rows[0].error,'new');assert.equal((await client.execute('SELECT last_error FROM collector_entries')).rows[0].last_error,'active failure');
 }finally{client.close()}
});

test('debug chat requires operations authentication and reuses service chat without analytics',async()=>{
 process.env.OPERATIONS_SECRET='test-private-secret';const {client,db}=await fixture();try{
 assert.equal((await operations({method:'GET',headers:{}},url('/api/admin/debug-chat'),db)).status,404);
 const page=await operations({headers:{}},url('/ops-test-private-secret/debug'),null);assert.equal(page.status,200);assert.equal(page.headers.get('x-robots-tag'),'noindex, nofollow');
 const cookie=page.headers.get('set-cookie').split(';')[0],html=await page.text();assert(html.includes('Space 온라인 / 오프라인 감지'));assert(html.includes('Space 채팅 수집 감지'));assert(html.includes("e.source!==$('chat').contentWindow"));new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 const chat=await operations({method:'GET',headers:{cookie}},url('/api/admin/debug-chat'),db),body=await chat.text();assert(body.includes('채팅방에 오신 것을 환영합니다!'));assert(body.includes('Space 또는 공유 게시물 URL 테스트'));assert(body.includes('event.source!==parent'));assert(!body.includes('googletagmanager'));for(const script of body.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
 }finally{client.close()}
});

test('debug live error feed escapes upstream text and deduplicates repeated browser failures',()=>{
 const html=readFileSync(new URL('../server/debug.html',import.meta.url),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1],elements=new Map();
 const ctx=vm.createContext({Date,Map,JSON,String,Array,custom:{handle:'testHost'},snapshot:{errors:[{id:1,key:'timeline:fx:AyatsunoYuni',at:Date.now(),error:'<img src=x onerror=bad()> 404'}]},names:[['유니','AyatsunoYuni']],$:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id)}});
 vm.runInContext(script.slice(script.indexOf('const esc='),script.indexOf('function cell(')),ctx);
 vm.runInContext("renderErrors();recordLocalError('x-notifications','푸시 연결 실패');recordLocalError('x-notifications','푸시 연결 실패')",ctx);
 assert.match(elements.get('errorLog').innerHTML,/FxTwitter/);assert.match(elements.get('errorLog').innerHTML,/&lt;img/);assert(!elements.get('errorLog').innerHTML.includes('<img'));assert.equal(vm.runInContext('localErrors.length',ctx),1);assert.match(elements.get('errorCount').textContent,/2건/);
 vm.runInContext("snapshot.errors.push({id:2,key:'replies:fxtwitter:123',at:Date.now(),error:'reply failed'});$('hideFxTimelineErrors').checked=true;renderErrors()",ctx);assert(!elements.get('errorLog').innerHTML.includes('timeline:fx:'));assert(elements.get('errorLog').innerHTML.includes('replies:fxtwitter:123'));assert.match(elements.get('errorCount').textContent,/1건 숨김/);
 vm.runInContext("$('hideFxTimelineErrors').checked=false;renderErrors()",ctx);assert(elements.get('errorLog').innerHTML.includes('timeline:fx:AyatsunoYuni'));
});

test('overview counts archived replies for test posts without roster broadcast sessions',async()=>{
 process.env.OPERATIONS_SECRET='test-private-secret';const {client,db}=await fixture();try{
 await client.execute({sql:'INSERT INTO broadcast_messages(post_id,id,payload) VALUES(?,?,?)',args:['999','reply1',JSON.stringify({id:'reply1'})]});
 const page=await operations({headers:{}},url('/ops-test-private-secret'),null),cookie=page.headers.get('set-cookie').split(';')[0];
 const data=await(await operations({headers:{cookie}},url('/api/admin/overview'),db)).json();assert.equal(data.sessions.length,0);assert.deepEqual(data.archives,[{post_id:'999',messages:1}]);
 }finally{client.close()}
});

test('test chat deletion requires admin origin and preserves member and unknown archives',async()=>{
 process.env.OPERATIONS_SECRET='test-private-secret';const{client,db}=await fixture();
 try{
 const page=await operations({headers:{}},url('/ops-test-private-secret'),db),cookie=page.headers.get('set-cookie').split(';')[0];
 for(const [id,handle]of [['12345','ExternalTester'],['23456','ShirayukiHina_']])await client.execute({sql:'INSERT INTO collector_entries(key,payload) VALUES(?,?)',args:['resolve:post:'+id,JSON.stringify({tweet:id,handle})]});
 for(const id of ['12345','23456','34567'])await client.execute({sql:'INSERT INTO broadcast_messages(post_id,id,payload) VALUES(?,?,?)',args:[id,'1','{}']});
 assert.equal((await operations({method:'DELETE',headers:{}},url('/api/admin/test-chats'),db)).status,404);
 assert.equal((await operations({method:'DELETE',headers:{cookie,origin:'https://evil.example'}},url('/api/admin/test-chats'),db)).status,403);
 const result=await(await operations({method:'DELETE',headers:{cookie,origin:url('/').origin}},url('/api/admin/test-chats'),db)).json();assert.equal(result.deleted,1);
 assert.deepEqual((await client.execute('SELECT post_id FROM broadcast_messages ORDER BY post_id')).rows.map(r=>r.post_id),['23456','34567']);
 }finally{client.close()}
});

test('debug latency displays mean and standard deviation and resets empty measurements',()=>{
 const html=readFileSync(new URL('../server/debug.html',import.meta.url),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 const elements=new Map(['chatLatency','latencyDetail','latencyStages'].map(id=>[id,{textContent:''}]));const ctx=vm.createContext({document:{getElementById:id=>elements.get(id)}});
 const start=script.indexOf('const $=');vm.runInContext(script.slice(start,script.indexOf('function updateClock')),ctx);
 vm.runInContext('latencySamples=[{ms:100,requestMs:80,renderMs:20,count:2},{ms:300,requestMs:260,renderMs:40,count:1}];renderLatency()',ctx);assert.equal(elements.get('chatLatency').textContent,'0.200초 ± 0.100초');assert.match(elements.get('latencyDetail').textContent,/2회 요청 · 3개 답글/);
 vm.runInContext('latencySamples=[];renderLatency()',ctx);assert.equal(elements.get('chatLatency').textContent,'—');
});

test('debug latency matches fresh reply IDs in the same response and never pairs a count with later chat',async()=>{
 const {debugChatScript}=await import('../server/debug-chat.js');const events=[],frames=[],rendered=new Set(),seen=new Set();let now=0;
 const responses=[{total:10,messages:[{id:'1'}]},{total:11,messages:[]},{total:11,messages:[{id:'2'}]}];
 const ctx=vm.createContext({api:async()=>{now+=100;return responses.shift()},crypto:{randomUUID:()=>String(now)},performance:{now:()=>now},Date,location:{origin:'https://test'},parent:{postMessage:e=>events.push(e)},generation:1,room:{tweet:'12345'},seen,auto:true,document:{hidden:false},requestAnimationFrame:fn=>frames.push(fn),$:()=>({querySelectorAll:()=>[...rendered].map(id=>({getAttribute:()=>id}))})});
 vm.runInContext(debugChatScript.slice(0,debugChatScript.indexOf('const debugButton=')),ctx);
 const run=async id=>{await vm.runInContext("api('/api/replies?id=12345')",ctx);if(id){seen.add(id);rendered.add(id)}while(frames.length){now+=16;frames.shift()()}};
 await run('1');await run();assert.equal(events.filter(e=>e.event==='latency-sample').length,0);
 await run('2');const sample=events.find(e=>e.event==='latency-sample');assert.deepEqual([...sample.ids],['2']);assert.equal(sample.requestMs,100);assert.equal(sample.renderMs,32);assert.equal(sample.ms,132);
});
