import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHub} from '../cloudflare/hub.js';

class Socket {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  closes = [];
  saved = null;
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code, reason) { this.closes.push({code, reason}); this.readyState = 3; }
  serializeAttachment(value) { this.saved = structuredClone(value); }
  deserializeAttachment() { return this.saved; }
}
const subscribe = (id, after = 0) => JSON.stringify({type: 'subscribe', postId: id, after});
const room = (cursor, ids = [], extra = {}) => ({messages: ids.map(id => ({id})), historyCursor: cursor, hasMore: false, ...extra});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

test('room updates wait for the in-flight replay and resume after its delivered cursor', async () => {
  const socket = new Socket(), first = deferred(), calls = [];
  const hub = createHub({sockets: () => [socket], readRoom: async (id, options) => {
    calls.push({id, ...options});
    return calls.length === 1 ? first.promise : room(3, ['3']);
  }});
  hub.accept(socket);
  const loading = hub.handle(socket, subscribe('123', 1));
  await Promise.resolve();
  const update = hub.publishRoom('123');
  assert.equal(calls.length, 1);
  first.resolve(room(2, ['2']));
  await loading; await update; await hub.idle();
  assert.deepEqual(calls.map(call => call.after), [1, 2]);
  assert(calls.every(call => call.latest === false));
  assert.deepEqual(socket.sent.map(frame => frame.data.messages[0].id), ['2', '3']);
  assert.equal(socket.saved.after, 3);
});

test('switching rooms fences an older in-flight response without concurrent reads', async () => {
  const socket = new Socket(), first = deferred(), calls = [];
  const hub = createHub({sockets: () => [socket], readRoom: async id => {
    calls.push(id);
    return id === '123' ? first.promise : room(10, ['new']);
  }});
  const loading = hub.handle(socket, subscribe('123'));
  await Promise.resolve();
  const switched = hub.handle(socket, subscribe('456'));
  assert.deepEqual(calls, ['123']);
  first.resolve(room(2, ['old']));
  await loading; await switched; await hub.idle();
  assert.deepEqual(calls, ['123', '456']);
  assert.deepEqual(socket.sent.map(frame => frame.postId), ['456']);
  assert.equal(socket.saved.postId, '456');
});

test('null subscription immediately fences pending data and future room publications', async () => {
  const socket = new Socket(), first = deferred();
  let reads = 0;
  const hub = createHub({sockets: () => [socket], readRoom: async () => { reads++; return first.promise; }});
  const loading = hub.handle(socket, subscribe('123'));
  await Promise.resolve();
  await hub.handle(socket, subscribe(null));
  first.resolve(room(9, ['old']));
  await loading; await hub.publishRoom('123'); await hub.idle();
  assert.equal(socket.sent.length, 0);
  assert.equal(reads, 1);
  assert.equal(socket.saved.postId, null);
  assert.equal(socket.saved.after, 0);
});

test('hibernation restores room and cursor from the socket attachment', async () => {
  const socket = new Socket();
  socket.saved = {postId: '123', after: 70, version: 4};
  const hub = createHub({sockets: () => [socket], readRoom: async (id, options) => {
    assert.equal(id, '123'); assert.equal(options.after, 70);
    return room(71, ['new']);
  }});
  await hub.publishRoom('123'); await hub.idle();
  assert.equal(socket.sent[0].data.messages[0].id, 'new');
  assert.deepEqual(socket.saved, {postId: '123', after: 71, version: 4});
});

test('hasMore catch-up pages are requested by the client instead of an unbounded server loop', async () => {
  const socket = new Socket(), cursors = [];
  const hub = createHub({readRoom: async (_, options) => {
    cursors.push(options.after);
    return options.after === 0 ? room(500, ['a'], {hasMore: true}) : room(999, ['b']);
  }});
  await hub.handle(socket, subscribe('123'));
  assert.deepEqual(cursors, [0]);
  assert.equal(socket.sent[0].data.hasMore, true);
  await hub.handle(socket, subscribe('123', 500));
  assert.deepEqual(cursors, [0, 500]);
  assert.equal(socket.saved.after, 999);
});

test('invalid and oversized subscription frames never reach the collector', async () => {
  let reads = 0;
  const hub = createHub({readRoom: async () => { reads++; return room(0); }});
  for (const raw of ['{', '[]', 'null', JSON.stringify({type: 'unknown'}), subscribe('not-a-post'), subscribe('123', null), subscribe('123', -1), subscribe('123', 1.5), subscribe('123', Number.MAX_SAFE_INTEGER + 1), 'a'.repeat(2049), new ArrayBuffer(1)]) {
    const socket = new Socket();
    await hub.handle(socket, raw);
    assert.equal(socket.sent[0].type, 'error');
    assert.equal(socket.closes.length, 1);
  }
  assert.equal(reads, 0);
});

test('subscription spam is bounded before creating unbounded queued reads', async () => {
  const socket = new Socket(), first = deferred();
  let reads = 0;
  const hub = createHub({now: () => 1000, readRoom: async () => { reads++; return first.promise; }});
  const loading = hub.handle(socket, subscribe('123'));
  await Promise.resolve();
  for (let i = 0; i < 25; i++) void hub.handle(socket, subscribe('123', i));
  assert.equal(reads, 1);
  assert.equal(socket.closes.length, 1);
  first.resolve(room(100, ['late']));
  await loading; await hub.idle();
  assert.equal(socket.sent.filter(frame => frame.type === 'room').length, 0);
});

test('unregistered rooms expose a generic error without echoing internal errors', async () => {
  const socket = new Socket();
  const hub = createHub({readRoom: async () => { throw Error('database password private'); }});
  await hub.handle(socket, subscribe('123'));
  assert.equal(socket.sent[0].type, 'error');
  assert(!JSON.stringify(socket.sent).includes('private'));
  assert.equal(socket.saved.postId, null);
});

test('slow sockets are closed before more chat is buffered and members use the same protection', async () => {
  const socket = new Socket();
  socket.bufferedAmount = 200;
  const hub = createHub({sockets: () => [socket], maxBufferedBytes: 100, readRoom: async () => room(3, ['a'])});
  await hub.handle(socket, subscribe('123'));
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.saved.after, 0);
  assert.equal(socket.closes[0].code, 1013);
  hub.broadcastMembers([{handle: 'test'}]);
  assert.equal(socket.sent.length, 0);
});

test('closed sockets discard pending reads and do not advance the persisted cursor', async () => {
  const socket = new Socket(), first = deferred();
  const hub = createHub({readRoom: async () => first.promise});
  const loading = hub.handle(socket, subscribe('123', 5));
  await Promise.resolve();
  hub.remove(socket);
  first.resolve(room(9, ['a']));
  await loading; await hub.idle();
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.saved.after, 5);
});

test('one publication shares a single room read and encoded frame across 1000 matching cursors', async () => {
  const clients = Array.from({length: 1000}, () => {
    const socket = new Socket();
    socket.saved = {postId: '123', after: 100, version: 1};
    return socket;
  });
  let reads = 0, encodes = 0;
  const hub = createHub({sockets: () => clients, readRoom: async () => {
    reads++;
    const data = room(101, ['new']);
    data.toJSON = () => { encodes++; return {...data, toJSON: undefined}; };
    return data;
  }});
  await hub.publishRoom('123'); await hub.idle();
  assert.equal(reads, 1);
  assert.equal(encodes, 1);
  assert(clients.every(socket => socket.saved.after === 101 && socket.sent.length === 1));
});

test('a slower viewer has its own replay while 1000 current viewers share their read', async () => {
  const clients = Array.from({length: 1001}, (_, index) => {
    const socket = new Socket();
    socket.saved = {postId: '123', after: index === 1000 ? 10 : 100, version: 1};
    return socket;
  });
  const cursors = [];
  const hub = createHub({sockets: () => clients, readRoom: async (_, options) => {
    cursors.push(options.after);
    return room(101, options.after === 10 ? ['older', 'new'] : ['new']);
  }});
  await hub.publishRoom('123'); await hub.idle();
  assert.deepEqual(cursors.sort((a, b) => a - b), [10, 100]);
  assert.equal(clients[0].sent[0].data.messages.length, 1);
  assert.equal(clients[1000].sent[0].data.messages.length, 2);
});

test('a fresh publication does not reuse an older in-flight read at the same cursor', async () => {
  const first = new Socket(), second = new Socket(), staleRead = deferred();
  let requests = 0;
  const hub = createHub({sockets: () => [first, second], readRoom: async (_, options) => {
    requests++;
    return requests === 1 ? staleRead.promise : room(102, options.after === 100 ? ['101', '102'] : ['102']);
  }});
  const old = hub.handle(first, subscribe('123', 100));
  // Wait until the shared read has reached the collector.
  await Promise.resolve(); await Promise.resolve();
  const publication = hub.publishRoom('123');
  await hub.handle(second, subscribe('123', 100));
  assert.equal(second.sent[0].data.historyCursor, 102);
  staleRead.resolve(room(101, ['101']));
  await old; await publication; await hub.idle();
  assert.equal(first.saved.after, 102);
  assert.deepEqual(first.sent.map(frame => frame.data.historyCursor), [101, 102]);
});

test('settled reads are evicted so a later subscribe at the same cursor sees new data', async () => {
  const socket = new Socket();
  let current = 2, requests = 0;
  const hub = createHub({readRoom: async () => { requests++; return room(current, [String(current)]); }});
  await hub.handle(socket, subscribe('123', 1));
  current = 3;
  await hub.handle(socket, subscribe('123', 1));
  assert.equal(requests, 2);
  assert.equal(socket.sent[1].data.historyCursor, 3);
});
