import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createNotificationReceiver} from '../cloudflare/notifications.js';
import {saveXSession, notificationStatus, createXHeaderSigner} from '../server/x-notifications.js';
import {memberHandles} from '../worker/index.js';
import {openWebPush} from '../scripts/web-push.mjs';

const owner = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const session = {auth_token: 'a'.repeat(40), ct0: 'b'.repeat(64)};
const pushState = {
  endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/test',
  decryptor: {jwk: {d: 'private-push-key'}, auth: 'private-push-auth'},
};
function inbox(id = '123') {
  return {globalObjects: {users: {u: {screen_name: 'ShirayukiHina_'}}, tweets: {
    [id]: {id_str: id, user_id_str: 'u', text: 'Space https://x.com/i/spaces/test', created_at: '2026-10-23T01:00:00Z'},
  }}};
}
function fixture(overrides = {}) {
  let clock = 100000;
  const calls = {load: 0, control: [], fetch: [], posts: [], health: [], follow: 0, followWrites: 0, opens: [], closed: 0};
  const options = {
    db: {}, owner, now: () => clock,
    loadConfig: async () => { calls.load++; return session; },
    control: async (_, body) => { calls.control.push(body); return {owned: body.action !== 'release', state: pushState}; },
    headersFor: async () => ({'test-auth': 'present'}),
    syncFollows: async () => { calls.follow++; return {enabled: memberHandles, pending: [], checkedAt: clock}; },
    persistFollowSetup: async () => { calls.followWrites++; },
    openPush: async options => { calls.opens.push(options); return {close() { calls.closed++; }}; },
    fetcher: async (url, init) => { calls.fetch.push({url, init}); return Response.json(inbox()); },
    onPosts: async posts => { calls.posts.push(...posts); },
    persistHealth: async (_, id, value) => { calls.health.push({id, value}); },
    ...overrides,
  };
  const receiver = createNotificationReceiver(options);
  return {receiver, calls, options, advance: ms => { clock += ms; }};
}
async function step(receiver) { await receiver.step(); await receiver.idle(); }

test('receiver is inert until stepped and a missing configuration does not acquire a lease', async () => {
  const {receiver, calls} = fixture({loadConfig: async () => null});
  assert.equal(calls.control.length, 0);
  assert.equal(calls.opens.length, 0);
  await step(receiver);
  assert.equal(receiver.status().configured, false);
  assert.equal(calls.control.length, 0);
  assert.equal(calls.fetch.length, 0);
  await receiver.stop();
});

test('an existing Actions owner prevents any X connection, scan or follow change', async () => {
  const {receiver, calls} = fixture({control: async () => ({owned: false})});
  await step(receiver);
  assert.equal(receiver.status().owned, false);
  assert.equal(calls.opens.length, 0);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.follow, 0);
  assert.equal(calls.health.length, 0);
  await receiver.stop();
});

test('connected receiver scans once, renews every ten seconds and persists health without per-tick writes', async () => {
  const {receiver, calls, advance} = fixture();
  try {
    await step(receiver);
    assert.equal(receiver.status().mode, 'push');
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.posts.length, 1);
    assert.deepEqual(calls.opens[0].state, pushState);
    const firstHealthCount = calls.health.length;
    for (let i = 0; i < 19; i++) { advance(1000); await step(receiver); }
    assert.equal(calls.control.length, 2);
    assert.equal(calls.follow, 1);
    assert.equal(calls.followWrites, 1);
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.health.length, firstHealthCount);
    advance(1000); await step(receiver);
    assert.equal(calls.control.length, 3);
    assert.equal(calls.health.length, firstHealthCount + 1);
    advance(10000); await step(receiver);
    assert.equal(calls.fetch.length, 2);
    assert.equal(calls.posts.length, 1);
    assert(calls.fetch.every(call => new URL(call.url).hostname === 'api.x.com'));
    assert(!JSON.stringify(receiver.status()).includes(session.auth_token));
    assert(!JSON.stringify(calls.health).includes('private-push'));
  } finally { await receiver.stop(); }
});

test('pushes bypass the safety interval, deduplicate posts and are ignored after stop', async () => {
  let next = '123';
  const {receiver, calls} = fixture({fetcher: async () => Response.json(inbox(next))});
  await step(receiver);
  next = '124';
  await calls.opens[0].onNotification();
  await receiver.idle();
  assert.deepEqual(calls.posts.map(post => post.id), ['123', '124']);
  await calls.opens[0].onNotification();
  await receiver.idle();
  assert.equal(calls.posts.length, 2);
  await receiver.stop();
  next = '125';
  await calls.opens[0].onNotification();
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.closed, 1);
  assert.equal(calls.control.at(-1).action, 'release');
});

test('losing ownership aborts pending inbox work and fences old WebSocket callbacks', async () => {
  let lease = true, pendingFetch = false, aborted = false;
  const {receiver, calls, advance} = fixture({
    control: async () => ({owned: lease, state: pushState}),
    fetcher: async (_, init) => pendingFetch ? new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, {once: true});
    }) : Response.json(inbox()),
  });
  try {
    await step(receiver);
    pendingFetch = true;
    const scan = calls.opens[0].onNotification();
    await Promise.resolve(); await Promise.resolve();
    lease = false;
    advance(10000);
    await step(receiver);
    await scan;
    assert.equal(aborted, true);
    assert.equal(receiver.status().owned, false);
    assert.equal(receiver.status().pushConnected, false);
    assert.equal(calls.closed, 1);
    await calls.opens[0].onNotification();
    assert.equal(calls.posts.length, 1);
  } finally { await receiver.stop(); }
});

test('failed delivery is retried instead of marking a post seen', async () => {
  let attempts = 0;
  const {receiver, advance} = fixture({onPosts: async () => { if (++attempts === 1) throw Error('DB unavailable'); }});
  try {
    await step(receiver);
    assert.equal(receiver.status().lastScanAt, null);
    assert.equal(attempts, 1);
    advance(5000); await step(receiver);
    assert.equal(attempts, 2);
    assert.equal(receiver.status().postsReceived, 1);
  } finally { await receiver.stop(); }
});

test('429 retry-after suppresses safety scans and push scans until the reset', async () => {
  let requests = 0;
  const {receiver, calls, advance} = fixture({fetcher: async () => {
    requests++;
    return requests === 1 ? new Response('', {status: 429, headers: {'retry-after': '120'}}) : Response.json(inbox());
  }});
  try {
    await step(receiver);
    await calls.opens[0].onNotification();
    advance(30000); await step(receiver);
    await calls.opens[0].onNotification();
    assert.equal(requests, 1);
    // Reconnecting must not turn the 120-second inbox backoff into a five-second safety scan.
    calls.opens[0].onDisconnected();
    // Step throughout the wait so the receiver retains its 60-second lease.
    for (let i = 0; i < 9; i++) { advance(10000); await step(receiver); }
    assert.equal(requests, 2);
    assert.equal(receiver.status().postsReceived, 1);
  } finally { await receiver.stop(); }
});

test('a late successful connection is closed after its ownership is lost', async () => {
  let lease = true, finishConnection, closed = 0;
  const {receiver, advance} = fixture({
    control: async () => ({owned: lease, state: pushState}),
    openPush: async () => new Promise(resolve => { finishConnection = () => resolve({close() { closed++; }}); }),
  });
  await receiver.step();
  lease = false;
  advance(10000);
  await receiver.step();
  finishConnection();
  await receiver.idle();
  assert.equal(closed, 1);
  assert.equal(receiver.status().pushConnected, false);
  await receiver.stop();
});

test('late connection state save settles before stop releases the lease', async () => {
  let finishSave, beganSave;
  const saveStarted = new Promise(resolve => { beganSave = resolve; });
  const order = [];
  const {receiver} = fixture({
    control: async (_, body) => {
      if (body.state) {
        beganSave();
        await new Promise(resolve => { finishSave = resolve; });
        order.push('save');
      }
      if (body.action === 'release') order.push('release');
      return {owned: body.action !== 'release', state: pushState};
    },
    openPush: async options => { await options.saveState(pushState); return {close() {}}; },
  });
  await receiver.step();
  await saveStarted;
  const stopping = receiver.stop();
  assert.deepEqual(order, []);
  finishSave();
  await stopping;
  assert.deepEqual(order, ['save', 'release']);
  assert.equal(receiver.status().owned, false);
});

test('parent abort stops and releases without waiting on its own stop promise', async () => {
  const signal = new AbortController();
  const {receiver, calls} = fixture({signal: signal.signal});
  await step(receiver);
  signal.abort();
  await receiver.stop();
  assert.equal(receiver.status().mode, 'stopped');
  assert.equal(calls.control.at(-1).action, 'release');
});

test('first-time follow setup is split into bounded batches and preserves previous successes', async () => {
  const targets = [];
  const {receiver, advance} = fixture({syncFollows: async (_, options) => {
    targets.push(options.targets);
    return {enabled: options.targets, pending: [], retryAt: 0, checkedAt: options.now};
  }});
  try {
    await step(receiver);
    for (let i = 0; i < 10; i++) { advance(1000); await step(receiver); }
    assert.equal(targets.length, 5);
    assert(targets.every(batch => batch.length <= 3));
    assert.deepEqual(targets.flat(), memberHandles);
    assert.deepEqual(receiver.status().followSetup.enabled, memberHandles);
    assert.deepEqual(receiver.status().followSetup.pending, []);
  } finally { await receiver.stop(); }
});

test('real Turso-compatible helpers encrypt push state and preserve operations health and single ownership', async () => {
  process.env.OPERATIONS_SECRET = 'test-cloudflare-operations-secret';
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_windy_bushwacker.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../server/session-schema.sql', import.meta.url), 'utf8'));
  const db = {prepare(sql) { return {bind(...args) { return {
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async all() { return {results: sqlite.prepare(sql).all(...args)}; },
  }; }}; }};
  await saveXSession(db, session, {fetcher: async () => Response.json({id_str: '12345', screen_name: 'checker'})});
  let clock = Date.now(), opens = 0;
  const options = {db, now: () => clock, headersFor: async () => ({}),
    syncFollows: async () => ({enabled: [], pending: [], checkedAt: clock, retryAt: clock + 300000}),
    fetcher: async () => Response.json(inbox()),
    openPush: async callbacks => { opens++; await callbacks.saveState(pushState); return {close() {}}; },
  };
  const first = createNotificationReceiver({...options, owner});
  const second = createNotificationReceiver({...options, owner: otherOwner});
  try {
    await step(first);
    await step(second);
    assert.equal(opens, 1);
    const stored = sqlite.prepare("SELECT value FROM operations_settings WHERE key='x_push_state'").get().value;
    assert(!stored.includes('private-push'));
    assert.equal((await notificationStatus(db)).healthy, true);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM collector_entries WHERE key LIKE 'notification-posts:%'").get().count, 0);
    await first.stop();
    clock += 10001;
    await step(second);
    assert.equal(opens, 2);
    assert.equal(second.status().owned, true);
  } finally { await first.stop(); await second.stop(); sqlite.close(); }
});

test('the Cloudflare signer routes app-shell and transaction chunk requests through the injected fetcher', async () => {
  let clock = 1000;
  const calls = [];
  class Transaction {
    constructor(document) { this.homePageDocument = document; }
    getOnDemandFileUrl(document) { assert.equal(document.kind, 'parsed'); return 'https://abs.twimg.com/test-ondemand.js'; }
    async initialize() { this.indices = await this.getIndices(this.homePageDocument); }
    async generateTransactionId(method, path) { return [method, path, ...this.indices.flat()].join(':'); }
  }
  const signer = createXHeaderSigner({now: () => clock, Transaction,
    parseDocument: text => { assert.equal(text, 'app shell'); return {kind: 'parsed'}; },
    fetcher: async (url, init) => {
      calls.push(url);
      assert.equal(init.redirect, 'error');
      assert(init.signal);
      return new Response(url.includes('/i/jf/') ? 'app shell' : 'f(a[3], 16);f(b[14],16);f(c[7], 16)');
    },
  });
  const [first, second] = await Promise.all([signer(session, 'GET', '/one'), signer(session, 'POST', '/two')]);
  assert.deepEqual(calls, ['https://x.com/i/jf/', 'https://abs.twimg.com/test-ondemand.js']);
  assert.equal(first['x-client-transaction-id'], 'GET:/one:3:14:7');
  assert.equal(second['x-client-transaction-id'], 'POST:/two:3:14:7');
  clock += 3600001;
  await signer(session, 'GET', '/three');
  assert.equal(calls.length, 4);
});

test('the Cloudflare signer retries failures without exposing response contents', async () => {
  let calls = 0;
  const signer = createXHeaderSigner({fetcher: async () => {
    calls++;
    return new Response('private upstream contents', {status: 503});
  }});
  for (let i = 0; i < 2; i++) await assert.rejects(() => signer(session, 'GET', '/one'), error => !error.message.includes('private'));
  assert.equal(calls, 2);
});

test('Web Push budgets its native connection and uses injected headers and fetch for registration', async () => {
  const order = [], calls = [];
  class Client {
    async connect() { order.push('socket'); return pushState.endpoint; }
    getUaid() { return 'uaid'; }
    getRemoteBroadcasts() { return {}; }
    close() {}
  }
  const decryptor = {getJwk: () => ({d: 'test'}), getAuthBase64url: () => 'auth', getPublicKeyBase64url: () => 'public'};
  const client = await openWebPush({Client, createDecryptor: async () => decryptor, session,
    signal: new AbortController().signal, onNotification: async () => {}, onDisconnected: () => {}, saveState: async () => {},
    beforeConnect: async ({signal}) => { assert(!signal.aborted); order.push('budget'); },
    headersFor: async () => ({'injected-header': 'yes'}),
    fetcher: async (url, options) => { calls.push(url); assert.equal(options.headers['injected-header'], 'yes'); return Response.json({ok: true}); },
  });
  assert.deepEqual(order, ['budget', 'socket']);
  assert.deepEqual(calls, ['https://x.com/i/api/1.1/notifications/settings/login.json']);
  client.close();
});

test('notification delivery failures are isolated and push observations retain their own trigger time',async()=>{
 const observations=[],events=[];const f=fixture({onObservedPosts:async posts=>{observations.push(posts);throw Error('Discord delivery unavailable');},onEvent:(kind,payload)=>events.push({kind,payload})});
 try{await step(f.receiver);assert.equal(f.calls.posts.length,1);assert.equal(f.receiver.status().error,null);f.advance(1234);await f.calls.opens[0].onNotification();await f.receiver.idle();
 const observed=events.filter(e=>e.kind==='post.observed');assert.equal(observed[0].payload.source,'fallback-inbox');assert.equal(observed.at(-1).payload.source,'push-inbox');assert.equal(observed.at(-1).payload.pushReceivedAt,101234);assert.equal(observed.at(-1).payload.pushDetectedAt,101234);assert.equal(f.receiver.status().error,null);assert.equal(f.calls.posts.length,1);assert.equal(observations.length,2);
 }finally{await f.receiver.stop()}
});

test('a push arriving during a fallback scan does not relabel that response as a push observation',async()=>{
 let calls=0,release;const gate=new Promise(r=>release=r),observations=[];
 const f=fixture({fetcher:async()=>{calls++;if(calls===2)await gate;return Response.json(inbox(String(122+calls)));},onObservedPosts:async posts=>observations.push(...posts)});
 try{await step(f.receiver);f.advance(30000);await f.receiver.step();await new Promise(r=>setImmediate(r));assert.equal(calls,2);f.advance(2000);const push=f.calls.opens[0].onNotification();release();await push;await f.receiver.idle();
 const fallback=observations.find(p=>p.id==='124'),triggered=observations.find(p=>p.id==='125');assert.equal(fallback.timing.source,'fallback-inbox');assert.equal(fallback.timing.pushReceivedAt,null);assert.equal(triggered.timing.source,'push-inbox');assert.equal(triggered.timing.pushReceivedAt,132000);
 }finally{release();await f.receiver.stop()}
});

test('disconnect diagnostics retain safe close metadata and preserve inbox fallback',async()=>{
 const events=[],f=fixture({onEvent:(kind,payload)=>events.push({kind,payload})});
 try{
  await step(f.receiver);
  f.calls.opens[0].onDisconnected({code:1006,durationMs:125750,wasClean:false,source:'socket-close',reason:'private-upstream-data'});
  const event=events.find(e=>e.kind==='push.disconnected');
  assert.deepEqual(event.payload,{code:1006,durationMs:125750,wasClean:false,source:'socket-close'});
  assert.equal(f.receiver.status().pushConnected,false);assert.equal(f.receiver.status().mode,'polling');
  f.advance(5000);await step(f.receiver);assert.ok(f.calls.fetch.length>=2);
 }finally{await f.receiver.stop();}
});
