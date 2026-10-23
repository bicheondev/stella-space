const POST_ID = /^\d{2,20}$/;
const validCursor = value => Number.isSafeInteger(value) && value >= 0;
const encoder = new TextEncoder();

/**
 * Socket attachments survive Durable Object hibernation: {postId, after, version}.
 * handle() receives subscribe frames; publishRoom() schedules catch-up from each delivered cursor.
 * One read per socket runs at a time, and a room change fences the previous in-flight result.
 * Responses with hasMore are paged by a client's next subscribe frame, not an unbounded server loop.
 */
export function createHub({
  sockets = () => [], readRoom, waitUntil = () => {}, now = Date.now,
  maxInputBytes = 2048, maxOutputBytes = 1024 * 1024, maxBufferedBytes = 1024 * 1024,
  subscribeBurst = 20, subscribePerSecond = 2, maxSharedReads = 128,
} = {}) {
  if (typeof readRoom !== 'function') throw Error('readRoom is required');
  const states = new WeakMap(), jobs = new Set(), sharedReads = new Map();
  let publicationVersion = 0;

  function readShared(postId, after) {
    // Only share work that is still in flight. A new publication advances the key even
    // if an older read has not completed, so late joiners cannot receive a stale cache.
    const key = `${publicationVersion}:${postId}:${after}`;
    if (sharedReads.has(key)) return sharedReads.get(key);
    const pending = (async () => {
      const data = await readRoom(postId, {after, latest: false});
      const valid = data && Array.isArray(data.messages) && validCursor(data.historyCursor) && data.historyCursor >= after;
      if (!valid) return {data, text: null, size: 0};
      const text = JSON.stringify({type: 'room', postId, data});
      return {data, text, size: encoder.encode(text).byteLength};
    })().finally(() => {
      if (sharedReads.get(key) === pending) sharedReads.delete(key);
    });
    if (sharedReads.size >= Math.max(1, maxSharedReads)) sharedReads.delete(sharedReads.keys().next().value);
    sharedReads.set(key, pending);
    return pending;
  }

  function stateFor(socket) {
    let state = states.get(socket);
    if (state) return state;
    let saved;
    try { saved = socket.deserializeAttachment?.(); } catch {}
    const valid = (saved?.postId === null || typeof saved?.postId === 'string' && POST_ID.test(saved.postId)) && validCursor(saved?.after);
    state = {
      postId: valid ? saved.postId : null, after: valid ? saved.after : 0,
      version: validCursor(saved?.version) ? saved.version : 0,
      dirty: false, pending: null, closed: false, tokens: subscribeBurst, refillAt: now(),
    };
    states.set(socket, state);
    return state;
  }

  function attach(socket, state) {
    try { socket.serializeAttachment?.({postId: state.postId, after: state.after, version: state.version}); }
    catch { close(socket, state, 1011, 'Connection state unavailable'); }
  }

  function close(socket, state, code, reason) {
    if (state.closed) return;
    state.closed = true;
    state.version++;
    state.dirty = false;
    try { socket.close(code, reason); } catch {}
  }

  function sendEncoded(socket, state, value, size) {
    if (state.closed || socket.readyState !== undefined && socket.readyState !== 1) return false;
    if (Number(socket.bufferedAmount || 0) > maxBufferedBytes || size > maxOutputBytes) {
      close(socket, state, 1013, 'Reconnect to resume chat');
      return false;
    }
    try { socket.send(value); return true; }
    catch { close(socket, state, 1011, 'Connection unavailable'); return false; }
  }

  function send(socket, state, value) {
    try {
      const text = JSON.stringify(value);
      return sendEncoded(socket, state, text, encoder.encode(text).byteLength);
    } catch {
      close(socket, state, 1011, 'Response unavailable');
      return false;
    }
  }

  function reject(socket, state, message, code = 1008) {
    send(socket, state, {type: 'error', message});
    close(socket, state, code, 'Invalid subscription');
  }

  function schedule(socket, state) {
    if (state.closed || !state.postId) return Promise.resolve();
    state.dirty = true;
    if (state.pending) return state.pending;
    const job = Promise.resolve().then(async () => {
      while (state.dirty && !state.closed && state.postId) {
        state.dirty = false;
        const postId = state.postId, after = state.after, version = state.version;
        let result;
        try { result = await readShared(postId, after); }
        catch {
          if (!state.closed && state.version === version && state.postId === postId) {
            state.postId = null;
            state.after = 0;
            state.version++;
            attach(socket, state);
            send(socket, state, {type: 'error', message: '방송 기록을 불러오지 못했습니다.'});
          }
          continue;
        }
        if (state.closed || state.version !== version || state.postId !== postId) continue;
        if (!result.text) {
          reject(socket, state, '방송 기록을 불러오지 못했습니다.', 1011);
          continue;
        }
        if (sendEncoded(socket, state, result.text, result.size)) {
          state.after = result.data.historyCursor;
          attach(socket, state);
        }
      }
    }).catch(() => {
      close(socket, state, 1011, 'Chat unavailable');
    }).finally(() => {
      state.pending = null;
      jobs.delete(job);
      // Events can arrive after the loop's last check but before its promise settles.
      if (state.dirty && !state.closed && state.postId) schedule(socket, state);
    });
    state.pending = job;
    jobs.add(job);
    waitUntil(job);
    return job;
  }

  function accept(socket) {
    const state = stateFor(socket);
    attach(socket, state);
    return {postId: state.postId, after: state.after, version: state.version};
  }

  function handle(socket, raw) {
    const state = stateFor(socket);
    if (state.closed) return Promise.resolve();
    if (typeof raw !== 'string' || raw.length > maxInputBytes || encoder.encode(raw).byteLength > maxInputBytes) {
      reject(socket, state, '잘못된 연결 요청입니다.', 1009);
      return Promise.resolve();
    }
    const current = now();
    state.tokens = Math.min(subscribeBurst, state.tokens + Math.max(0, current - state.refillAt) * subscribePerSecond / 1000);
    state.refillAt = current;
    if (state.tokens < 1) {
      reject(socket, state, '연결 요청이 너무 많습니다. 잠시 후 다시 연결해 주세요.');
      return Promise.resolve();
    }
    state.tokens--;
    let request;
    try { request = JSON.parse(raw); } catch {}
    const postId = request?.postId, after = request?.after === undefined ? 0 : request.after;
    if (!request || request.type !== 'subscribe' || !(postId === null || typeof postId === 'string' && POST_ID.test(postId)) || !validCursor(after)) {
      reject(socket, state, '잘못된 연결 요청입니다.');
      return Promise.resolve();
    }
    state.version++;
    state.postId = postId;
    state.after = postId ? after : 0;
    state.dirty = !!postId;
    attach(socket, state);
    return postId ? schedule(socket, state) : Promise.resolve();
  }

  function publishRoom(postId) {
    publicationVersion++;
    if (!Number.isSafeInteger(publicationVersion)) {
      publicationVersion = 0;
      sharedReads.clear();
    }
    const tasks = [];
    for (const socket of sockets()) {
      const state = stateFor(socket);
      if (!state.closed && state.postId === String(postId)) tasks.push(schedule(socket, state));
    }
    return Promise.all(tasks);
  }

  function broadcastMembers(members) {
    const text = JSON.stringify({type: 'members', members});
    const size = encoder.encode(text).byteLength;
    for (const socket of sockets()) sendEncoded(socket, stateFor(socket), text, size);
  }

  function remove(socket) {
    const state = stateFor(socket);
    state.closed = true;
    state.version++;
    state.dirty = false;
  }

  async function idle() {
    while (jobs.size) await Promise.all([...jobs]);
  }

  return {accept, handle, publishRoom, broadcastMembers, remove, idle};
}
