import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createCollector} from '../cloudflare/collector.js';
import {createDatabase} from '../cloudflare/database.js';

const handle = 'ShirayukiHina_', spaceId = '1KnownSpace', postId = '111';
const post = (id = postId, space = spaceId, time = 100) => ({id, text: 'https://x.com/i/spaces/' + space, created_timestamp: time, author: {screen_name: handle}});
const reply = (id, root = postId) => ({id, type: 'status', replying_to: {status: root}, text: '채팅 ' + id, created_timestamp: Number(id), author: {screen_name: 'listener', name: '청자'}});
function setup({ended = false, history = [], known = true} = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_windy_bushwacker.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../server/session-schema.sql', import.meta.url), 'utf8'));
  if (known) sqlite.prepare('INSERT INTO broadcast_sessions VALUES(?,?,?,?,?)').run(handle, postId, spaceId, 100000, JSON.stringify({handle, space: spaceId, state: ended ? 'Ended' : 'Running', status: ended ? 'offline' : 'live', postUrl: 'https://x.com/' + handle + '/status/' + postId, title: '방송'}));
  for (const message of history) sqlite.prepare('INSERT INTO broadcast_messages(post_id,id,payload) VALUES(?,?,?)').run(postId,message.id,JSON.stringify(message));
  let clock = 1000000, writes = 0, reads = 0, replies = [], audience = 10, metadataState = ended ? 'Ended' : 'Running', metadataFails = false, profileFails = false, conversationStatus = 200, holdReplies = null;
  const urls = [], events = [], members = [], broadcasts = [];
  const db = {prepare(sql) { return {bind(...args) { const run = all => { if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) writes++; else reads++; const query = sqlite.prepare(sql); return all ? {results: query.all(...args)} : query.get(...args) || null; }; return {async first() { return run(false); }, async all() { return run(true); }}; }}; }};
  const fetcher = async (url, init) => {
    urls.push(String(url));
    if (String(url).includes('guest/activate')) return Response.json({guest_token: 'guest'});
    if (String(url).includes('AudioSpaceById')) {
      if (metadataFails) throw Error('metadata unavailable');
      return Response.json({data: {audioSpace: {metadata: {state: metadataState, title: '방송', started_at: 100000}, participants: {total: audience}}}});
    }
    if (String(url).includes('/profile/')) {
      if (profileFails) return new Response('', {status: 404});
      return Response.json({code: 200, results: [post()]});
    }
    if (String(url).includes('/conversation/')) {
      if (holdReplies) await holdReplies;
      if (conversationStatus !== 200) return new Response('', {status: conversationStatus, headers: {'retry-after': '60'}});
      return Response.json({code: 200, status: {replies: replies.length}, replies});
    }
    throw Error('unexpected upstream ' + url);
  };
  const collector = createCollector({db, fetcher, now: () => clock, sleep: async () => {}, handles: [handle],
    notificationHealth: () => ({mode: 'push', pushConnected: true, checkedAtMs: clock}),
    onMessages: event => {
      for (const message of event.messages) assert(sqlite.prepare('SELECT id FROM broadcast_messages WHERE post_id=? AND id=?').get(event.postId,message.id), 'commit precedes publish');
      events.push(event);
    },
    onMembers: states => members.push(states), onBroadcast: event => broadcasts.push(event),
  });
  return {collector, sqlite, db, urls, events, members, broadcasts, writes: () => writes, reads: () => reads,
    advance(ms) { clock += ms; }, setReplies(value) { replies = value; }, setAudience(value) { audience = value; }, setMetadata(value) { metadataState = value; }, failMetadata() { metadataFails = true; }, failProfiles() { profileFails = true; }, restoreProfiles() { profileFails = false; }, limitReplies() { conversationStatus = 429; }, holdReplies(value) { holdReplies = value; },
    async cycle() { collector.step(); await collector.settled(); }, close() { collector.stop(); sqlite.close(); },
  };
}

test('public snapshots, resolve and cached chat reads never collect or write', async () => {
  const f = setup({history: [{id: '1001', time: 1, text: 'saved'}]});
  await f.collector.initialize(); const initialReads = f.reads(), writes = f.writes();
  for (let i = 0; i < 100; i++) {
    assert.equal(f.collector.snapshot().length,1);
    assert.equal((await f.collector.resolve('https://x.com/' + handle + '/status/' + postId)).tweet, postId);
    assert.equal((await f.collector.room(postId)).messages.length,1);
  }
  assert.equal(f.urls.length,0); assert.equal(f.writes(),writes); assert.equal(f.reads(),initialReads);
  await assert.rejects(f.collector.resolve('https://x.com/unknown/status/999'), {code:'UNTRACKED_SPACE',status:404});
  assert.equal(f.urls.length,0); f.close();
});

test('repeated replies are committed and published once, including after collector restart', async () => {
  const f = setup(); await f.collector.initialize(); f.setReplies([reply('1001')]);
  await f.cycle();
  assert.equal(f.events.length,1); assert.deepEqual(f.events[0].messages.map(m => m.id),['1001']);
  const writes = f.writes();
  for (let i = 0; i < 20; i++) { f.advance(100); await f.cycle(); }
  assert.equal(f.writes(),writes, 'unchanged polls do not write leases, cache blobs, or history');
  assert.equal(f.events.length,1);
  f.advance(100); f.setReplies([reply('1001'),reply('1002')]); await f.cycle();
  assert.deepEqual(f.events.at(-1).messages.map(m => m.id),['1002']);
  assert.equal((await f.collector.room(postId,{latest:false,after:f.events[0].historyCursor})).messages[0].id,'1002');
  f.collector.stop();
  const restarted = createCollector({db:f.db, handles:[handle], fetcher:async url => String(url).includes('guest/activate') ? Response.json({guest_token:'guest'}) : String(url).includes('AudioSpaceById') ? Response.json({data:{audioSpace:{metadata:{state:'Running'}}}}) : String(url).includes('/profile/') ? Response.json({code:200,results:[post()]}) : Response.json({code:200,replies:[reply('1001'),reply('1002')]}), sleep:async()=>{}, now:()=>2000000});
  await restarted.initialize(); const restartWrites = f.writes(); restarted.step(); await restarted.settled();
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM broadcast_messages').get().n,2);
  assert(f.writes() <= restartWrites + 1, 'only changed session metadata can write on recovery');
  restarted.stop(); f.sqlite.close();
});

test('metadata failure keeps a previously running room collecting and marks state unknown', async () => {
  const f = setup(); await f.collector.initialize(); f.failMetadata(); f.failProfiles(); f.setReplies([reply('1001')]); await f.cycle();
  assert.equal(f.collector.snapshot()[0].status,'unknown'); assert.equal(f.collector.snapshot()[0].stale,true);
  assert.equal((await f.collector.room(postId)).stopped,false);
  f.advance(100); f.setReplies([reply('1002')]); await f.cycle();
  assert.equal(f.events.at(-1).messages[0].id,'1002'); f.close();
});

test('an explicit end drains an issued reply request before sending the end event', async () => {
  const f = setup(); await f.collector.initialize(); await f.cycle(); f.advance(6000); f.setMetadata('Ended'); f.setReplies([reply('1001')]);
  let release; f.holdReplies(new Promise(resolve => { release = resolve; })); f.collector.step();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.some(event => event.stopped),false);
  release(); await f.collector.settled();
  assert.equal(f.events.at(-1).stopped,true);
  assert.deepEqual(f.events.filter(event => event.messages.length).flatMap(event => event.messages.map(m => m.id)),['1001']);
  const calls = f.urls.filter(url => url.includes('/conversation/')).length;
  f.advance(6000); await f.cycle();
  assert.equal(f.urls.filter(url => url.includes('/conversation/')).length,calls);
  assert.equal((await f.collector.room(postId)).messages.length,1); f.close();
});

test('a pushed newer Space replaces the session without deleting the old archive', async () => {
  const f = setup({ended:true,history:[{id:'1001',text:'old',time:1}]}); await f.collector.initialize(); await f.cycle();
  f.setMetadata('Running'); f.setReplies([reply('2001','222')]);
  assert.equal(await f.collector.ingestPosts([post('222','1BrandNewSpace',200)]),1);
  await f.cycle(); await f.cycle();
  assert.equal((await f.collector.resolve('https://x.com/' + handle + '/status/222')).tweet,'222');
  assert.deepEqual((await f.collector.room('222')).messages.map(m => m.id),['2001']);
  assert.deepEqual((await f.collector.room(postId)).messages.map(m => m.id),['1001']);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM broadcast_messages').get().n,2);
  assert.equal(f.broadcasts.at(-1).previous.space,spaceId);
  f.close();
});

test('rate limiting pauses upstream retries without consuming database writes', async () => {
  const f = setup(); await f.collector.initialize(); await f.cycle(); f.advance(100); f.limitReplies(); await f.cycle();
  const count = f.urls.filter(url => url.includes('/conversation/')).length, writes = f.writes();
  for (let i = 0; i < 15; i++) { f.advance(100); await f.cycle(); }
  assert.equal(f.urls.filter(url => url.includes('/conversation/')).length,count);
  assert.equal(f.writes(),writes); assert.equal((await f.collector.room(postId)).stale,true); f.close();
});

test('older history and a reconnect outside the memory window replay the stored cursor', async () => {
  const history = Array.from({length:650},(_,i) => ({id:String(1000+i),time:i,text:'saved'}));
  const f = setup({ended:true,history}); await f.collector.initialize();
  const latest = await f.collector.room(postId);
  assert.equal(latest.messages.length,200); assert.equal(latest.messages[0].id,'1450'); assert.equal(latest.hasOlder,true);
  const older = await f.collector.room(postId,{before:latest.olderCursor});
  assert.equal(older.messages.at(-1).id,'1449');
  const gap = await f.collector.room(postId,{latest:false,after:1});
  assert.equal(gap.messages[0].id,'1001'); assert.equal(gap.messages.length,500); assert.equal(gap.hasMore,true);
  assert.equal(f.urls.length,0); f.close();
});

test('slow member checks do not prevent an independent room poll', async () => {
  const f = setup(); await f.collector.initialize();
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const c = createCollector({db:f.db, handles:[handle], now:()=>1000000, sleep:async()=>{}, fetcher:async url => {
    if(String(url).includes('/profile/')) { await slow; return Response.json({code:200,results:[post()]}); }
    if(String(url).includes('guest/activate')) return Response.json({guest_token:'guest'});
    if(String(url).includes('AudioSpaceById')) return Response.json({data:{audioSpace:{metadata:{state:'Running'}}}});
    return Response.json({code:200,replies:[reply('1001')]});
  }});
  await c.initialize(); c.step(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await c.room(postId)).messages[0].id,'1001'); release(); await c.settled(); c.stop(); f.close();
});

test('a pushed post survives restart before discovery and duplicate pushes do not write', async () => {
  const f = setup({ended:true}); await f.collector.initialize();
  assert.equal(await f.collector.ingestPosts([post('222','1NewSpace',200)]),1);
  const writes = f.writes();
  assert.equal(await f.collector.ingestPosts([post('222','1NewSpace',200)]),0); assert.equal(f.writes(),writes);
  f.collector.stop();
  const resumed = createCollector({db:f.db,handles:[handle],now:()=>2000000,sleep:async()=>{},fetcher:async url => {
    if(String(url).includes('guest/activate')) return Response.json({guest_token:'guest'});
    if(String(url).includes('AudioSpaceById')) {
      const id = JSON.parse(new URL(url).searchParams.get('variables')).id;
      return Response.json({data:{audioSpace:{metadata:{state:id === '1NewSpace' ? 'Running' : 'Ended'}}}});
    }
    return Response.json({code:200,results:[],replies:[]});
  }});
  await resumed.initialize(); resumed.step(); await resumed.settled();
  assert.equal((await resumed.resolve('https://x.com/' + handle + '/status/222')).id,'1NewSpace');
  resumed.stop(); f.sqlite.close();
});

test('audience changes update members without rechecking Discord notification storage', async () => {
  const f = setup(); await f.collector.initialize(); await f.cycle();
  assert.equal(f.broadcasts.length,0, 'an already running session is not a new broadcast');
  f.setAudience(35); f.advance(6000); await f.cycle();
  assert.equal(f.collector.snapshot()[0].currentParticipants,35);
  assert.equal(f.broadcasts.length,0);
  f.setMetadata('Ended'); f.advance(6000); await f.cycle();
  assert.equal(f.broadcasts.length,1); assert.equal(f.broadcasts[0].current.state,'Ended');
  f.advance(6000); await f.cycle();
  assert.equal(f.broadcasts.length,1); f.close();
});

test('Turso requests use the shared injected subrequest budget transport', async () => {
  let calls = 0;
  const db = createDatabase({TURSO_DATABASE_URL:'https://database.invalid', TURSO_AUTH_TOKEN:'test'}, {fetcher:async () => {
    calls++;
    throw Error('Mock transport only');
  }});
  await assert.rejects(db.prepare('SELECT 1').bind().first(), /Mock transport only/);
  assert.equal(calls,1);
  db.close();
});

test('retired room caches are released while durable archives remain readable after eviction and restart', async () => {
  const f = setup({ended:true,history:[{id:'1001',text:'first broadcast',time:1}]});
  await f.collector.initialize(); await f.cycle(); f.setMetadata('Running');
  for (let i = 2; i <= 7; i++) {
    const root = String(i * 111);
    f.setReplies([reply(String(i * 1000),root)]);
    await f.collector.ingestPosts([post(root,'1Session' + i,i * 100)]);
    await f.cycle(); await f.cycle();
  }
  const reads = f.reads();
  const original = await f.collector.room(postId);
  assert.equal(original.stopped,true); assert.equal(original.messages[0].id,'1001');
  assert(f.reads() > reads, 'evicted history is loaded from storage, not retained in a message cache');
  assert.equal((await f.collector.room('222',{latest:false,after:0})).messages[0].id,'2000');
  const stored = f.sqlite.prepare('SELECT COUNT(*) n FROM broadcast_messages').get().n;
  assert.equal(stored,7);
  f.collector.stop();
  const resumed = createCollector({db:f.db,handles:[handle],fetcher:async()=>{throw Error('public reads must not fetch upstream');}});
  await resumed.initialize();
  assert.equal((await resumed.room(postId)).messages[0].id,'1001');
  assert.equal((await resumed.room('222',{before:100000})).messages[0].id,'2000');
  resumed.stop(); f.sqlite.close();
});

test('failed profile audits retry before the healthy five-minute interval without declaring offline',async()=>{
 const f=setup({known:false});try{
  f.failProfiles();await f.collector.initialize();await f.cycle();
  const attempts=f.urls.filter(u=>u.includes('/2/profile/')).length;
  assert.equal(f.collector.snapshot()[0].status,'unknown');
  f.advance(31000);await f.cycle();
  assert(f.urls.filter(u=>u.includes('/2/profile/')).length>attempts,'retry after 30s rather than waiting 5 minutes');
  assert.equal(f.collector.snapshot()[0].status,'unknown');
  f.restoreProfiles();f.advance(61000);await f.cycle();assert.equal(f.collector.snapshot()[0].status,'live');
 }finally{f.close();}
});
