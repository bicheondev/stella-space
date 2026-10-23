import {memberHandles, memberNames, findSpacePost, decideSpaceStatus, parseFxReplies, currentParticipants, replyInterval, broadcastHistory, recentBroadcastHistory} from '../worker/index.js';

const GUEST_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const PROFILE_INTERVAL = 5000, HEALTH_INTERVAL = 30000, CACHE_MESSAGES = 500;
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const postIdOf = state => state?.postUrl?.match(/\/status\/(\d{2,20})(?:\D|$)/)?.[1] || null;
const meaningful = state => JSON.stringify(Object.fromEntries(Object.entries(state || {}).filter(([key]) => !['checkedAt','stateCheckedAt','shared','collecting'].includes(key))));
const defer = until => Object.assign(Error('제공처 재시도 시각 대기 중'), {deferred: true, retryAt: until});
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, {once: true});
  });
}

// One instance belongs to one Durable Object. Reads never start collection.
export function createCollector({db, fetcher = fetch, now = Date.now, sleep = pause, handles = memberHandles,
  onEvent = () => {}, onMembers = () => {}, onMessages = () => {}, onError = () => {}, onBroadcast = () => {}, notificationHealth = () => ({})} = {}) {
  if (!db?.prepare) throw Error('공유 수집 저장소가 연결되지 않았습니다.');
  const members = new Map(handles.map(handle => [handle, {state: {handle, status: 'unknown'}, retained: null, posts: [], sources: {}, due: 0, pending: null, dirty: false, fetchCount: 0}]));
  const rooms = new Map(), metadataCache = new Map(), pending = new Set(), providerPause = {fx: 0, carry: 0}, providerSlots = {fx: 0, carry: 0};
  const abort = new AbortController();
  let initialized = false, initialization, stopped = false, guest = null, guestUntil = 0, guestPending = null, healthDue = 0, healthPending = null, ingestion = Promise.resolve();
  const iso = () => new Date(now()).toISOString();
  const emit = async (callback, value) => { try { await callback(value); } catch (error) { if (callback !== onError) try { await onError({key: 'delivery', error: error.message, at: now()}); } catch {} } };
  const report = (key, error) => { if (!stopped && !error.deferred) void emit(onError, {key, error: String(error.message || error).slice(0,1000), at: now()}); };
  function track(job) {
    pending.add(job);
    job.catch(() => {}).finally(() => pending.delete(job));
    return job;
  }

  async function request(url, init = {}, provider) {
    if (stopped) throw Error('수집기가 중지되었습니다.');
    if (provider) {
      if (providerPause[provider] > now()) throw defer(providerPause[provider]);
      const slot = Math.max(now(), providerSlots[provider]);
      if (slot > now() + 2000) throw defer(slot);
      providerSlots[provider] = slot + (provider === 'fx' ? 67 : 5000);
      if (slot > now()) await sleep(slot - now(), abort.signal);
      if (providerPause[provider] > now()) throw defer(providerPause[provider]);
    }
    const response = await fetcher(url, {...init, headers: {'user-agent': 'Spacelive/1.0 (+https://spacelive.vercel.app)', ...init.headers}, redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)])});
    let data;
    if (response.ok) data = await response.json();
    if (!response.ok || Number(data?.code) === 429) {
      const status = Number(data?.code) === 429 ? 429 : response.status;
      const error = Object.assign(Error('외부 조회 오류 (' + status + ') · ' + new URL(url).pathname), {status});
      const after = response.headers.get('retry-after'), seconds = Number(after), reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
      error.retryAt = Math.max(after && Number.isFinite(seconds) ? now() + seconds * 1000 : Date.parse(after) || 0, reset || 0);
      if (status === 429 && provider) {
        providerPause[provider] = error.retryAt = Math.max(error.retryAt, now() + (provider === 'carry' ? 300000 : 30000));
        try {
          await db.prepare(`INSERT INTO collector_entries(key,next_poll_at) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET next_poll_at=MAX(next_poll_at,excluded.next_poll_at) RETURNING key`).bind('budget:pause:' + provider,error.retryAt).first();
        } catch (storageError) { report('provider:cooldown',storageError); }
      }
      throw error;
    }
    if (data?.errors?.length) throw Error(data.errors[0].message || '외부 응답 오류');
    return data;
  }

  async function guestHeaders() {
    if (!guest || now() >= guestUntil) {
      guestPending ||= request('https://api.x.com/1.1/guest/activate.json', {method: 'POST', headers: {authorization: 'Bearer ' + GUEST_BEARER}}).then(data => {
        if (!data.guest_token) throw Error('X 게스트 인증 실패');
        guest = data.guest_token; guestUntil = now() + 600000;
      }).finally(() => { guestPending = null; });
      await guestPending;
    }
    return {authorization: 'Bearer ' + GUEST_BEARER, 'x-guest-token': guest, 'content-type': 'application/json'};
  }
  async function spaceMetadata(id) {
    let entry = metadataCache.get(id);
    if (entry?.pending) return entry.pending;
    if (entry?.due > now()) return entry.error ? null : entry.value;
    entry ||= {}; metadataCache.set(id, entry);
    entry.pending = (async () => {
      try {
        const url = new URL('https://x.com/i/api/graphql/fYAuJHiY3TmYdBmrRtIKhA/AudioSpaceById');
        url.searchParams.set('variables', JSON.stringify({id, isMetatagsQuery: false, withReplays: true, withListeners: true}));
        const data = await request(url.href, {headers: await guestHeaders()});
        const space = data.data?.audioSpace;
        if (!space?.metadata) throw Error('Space 정보를 확인할 수 없습니다.');
        if(entry.value?.state!==space.metadata.state)onEvent('space.observed',{space:id,state:space.metadata.state,previousState:entry.value?.state,startedAt:Number(space.metadata.started_at)||0,endedAt:Number(space.metadata.ended_at)||0,source:'x-metadata'});
        entry.value = {...space.metadata, currentParticipants: currentParticipants(space)};
        entry.error = null; entry.due = now() + (entry.value.state === 'Ended' ? 60000 : PROFILE_INTERVAL);
        return entry.value;
      } catch (error) {
        entry.error = error.message; entry.due = Math.max(now() + PROFILE_INTERVAL, error.retryAt || 0); report('space:' + id, error); return null;
      } finally { entry.pending = null; }
    })();
    return entry.pending;
  }

  function auditInterval(handle) {
    const health = notificationHealth() || {};
    if (health.mode === 'push' && health.pushConnected && now() - Number(health.checkedAtMs || 0) < 30000) return 300000 + handles.indexOf(handle) * 2000;
    return now() - Number(health.lastScanAt || 0) < 45000 ? 60000 : 30000;
  }
  async function discover(handle, member) {
    const audit = auditInterval(handle), warnings = [];
    let feed = Object.values(member.sources).filter(value => value.posts).sort((a,b) => b.at - a.at)[0];
    if (feed && now() - feed.at < audit) return {posts: combinePosts(member.posts, feed.posts), source: member.posts.length ? 'x-notifications' : feed.source, fresh: true};
    for (const source of ['fx','carry']) {
      const entry = member.sources[source] ||= {source, next: 0, failures: 0};
      if (entry.next > now()) { if (entry.error) warnings.push(entry.error); continue; }
      try {
        const base = source === 'fx' ? 'https://api.fxtwitter.com/2/profile/' : 'https://api.carryfeed.com/api/profile/';
        const data = await request(base + handle + '/statuses?count=5', {}, source);
        if (data.code !== 200 || !Array.isArray(data.results)) throw Error('멤버 게시물 응답을 읽을 수 없습니다.');
        onEvent('timeline.fetched',{handle,source,count:data.results.length});entry.posts = data.results; entry.at = now(); entry.failures = 0; entry.error = null; entry.next = now() + audit;
        return {posts: combinePosts(member.posts, entry.posts), source: member.posts.length ? 'x-notifications' : source, fresh: true};
      } catch (error) {
        if (!error.deferred) entry.failures++;
        entry.error = error.message; entry.next = Math.max(error.retryAt || 0, now() + (error.deferred ? 1000 : Math.max(audit, Math.min(300000, 30000 * 2 ** Math.min(entry.failures - 1, 4)))));
        warnings.push(error.message); report('timeline:' + source + ':' + handle, error);
      }
    }
    return {posts: combinePosts(member.posts, feed?.posts || []), source: member.posts.length ? 'x-notifications' : feed?.source, fresh: false, warning: warnings.join(' · ') || '게시물 조회 대기 중'};
  }
  function combinePosts(first, second) {
    return [...new Map([...second, ...first].map(post => [post.id,post])).values()].sort((a,b) => Number(b.created_timestamp || 0) - Number(a.created_timestamp || 0)).slice(0,5);
  }
  function retireRoom(room) {
    room.retired = true;
    room.rows = [];
    room.seen.clear();
    room.hasEarlier = true;
    // Retain a few small descriptors for reconnects, never old message caches.
    const retired = [...rooms.values()].filter(value => value.retired);
    for (const old of retired.slice(0, Math.max(0, retired.length - Math.max(2, handles.length * 2)))) rooms.delete(old.postId);
  }
  function trimMetadataCache() {
    const limit = Math.max(32, handles.length * 4);
    if (metadataCache.size <= limit) return;
    const current = new Set([...members.values()].map(member => member.retained?.space));
    for (const [id,entry] of metadataCache) {
      if (!entry.pending && !current.has(id)) metadataCache.delete(id);
      if (metadataCache.size <= limit) break;
    }
  }

  async function loadRoom(state) {
    const postId = postIdOf(state);
    if (!postId) return null;
    let room = rooms.get(postId);
    if (!room) {
      room = {postId, handle: state.handle, space: state.space, state: state.state, rows: [], seen: new Set(), historyCursor: 0, hasEarlier: false, checkedAt: null, due: 0, pending: null, ending: false, fetchCount: 0, failureCount: 0};
      rooms.set(postId,room);
      room.loading = (async () => {
        const rows = (await db.prepare('SELECT seq,payload FROM broadcast_messages WHERE post_id=?1 ORDER BY seq DESC LIMIT 501').bind(postId).all()).results;
        room.hasEarlier = rows.length > CACHE_MESSAGES;
        room.rows = rows.slice(0,CACHE_MESSAGES).reverse().map(row => ({seq: Number(row.seq), message: JSON.parse(row.payload)}));
        room.historyCursor = room.rows.at(-1)?.seq || 0;
        room.seen = new Set(room.rows.map(row => row.message.id));
      })();
    }
    await room.loading;
    return room;
  }

  async function commitMember(handle, member, next, startedAt) {
    const previous = member.retained;
    if (next.authoritative && next.space && postIdOf(next)) {
      if (previous?.space !== next.space && previous && ((startedAt && startedAt < member.startedAt) || BigInt(postIdOf(next)) < BigInt(postIdOf(previous)))) return;
      const room = await loadRoom(next);
      if (next.state === 'Ended') {
        room.ending = true;
        // Drain an already issued reply fetch before publishing the end marker.
        if (room.pending) await room.pending;
      }
      const sameSession = previous?.space === next.space;
      const persisted = {...next};
      delete persisted.discoveryWarning;
      if (!sameSession || meaningful(previous) !== meaningful(persisted)) {
        await db.prepare(`INSERT INTO broadcast_sessions(handle,post_id,space_id,started_at,payload) VALUES(?1,?2,?3,?4,?5)
          ON CONFLICT(handle) DO UPDATE SET post_id=excluded.post_id,space_id=excluded.space_id,started_at=excluded.started_at,payload=excluded.payload
          WHERE excluded.started_at>=broadcast_sessions.started_at`).bind(handle, room.postId, next.space, startedAt || member.startedAt || 0, JSON.stringify(persisted)).first();
        member.retained = persisted; member.startedAt = startedAt || member.startedAt || 0;
        if (!sameSession && previous) { const old = rooms.get(postIdOf(previous)); if (old) retireRoom(old); }
        room.state = next.state; room.ending = false;
        const started = next.state === 'Running' && (!previous || !sameSession);
        const ended = next.state === 'Ended' && sameSession && previous?.state === 'Running';
        if (started || ended) await emit(onBroadcast, {previous, current: persisted, name: memberNames[handle.toLowerCase()] || handle});
      }
      room.state = next.state;
      if (next.state === 'Ended' && previous?.state !== 'Ended') await emit(onMessages, envelope(room, [], room.historyCursor));
    }
    const changed = meaningful(member.state) !== meaningful(next);
    member.state = next;
    if(changed&& (next.status!==member.previousLoggedStatus||next.space!==member.previousLoggedSpace)){onEvent('member.detected',{handle,space:next.space,status:next.status,state:next.state,previousStatus:member.previousLoggedStatus,source:next.discoverySource,startedAt:next.startedAt});member.previousLoggedStatus=next.status;member.previousLoggedSpace=next.space;}
    if (changed) await emit(onMembers, snapshot());
  }
  async function checkMember(handle, member) {
    member.fetchCount++; member.lastStarted = now();
    try {
      const prior = member.retained;
      const [feed, previous] = await Promise.all([discover(handle, member), prior?.space ? spaceMetadata(prior.space) : null]);
      const link = findSpacePost(feed.posts, handle);
      const candidate = link?.space === prior?.space ? previous : link?.space ? await spaceMetadata(link.space) : null;
      const avatar = feed.posts.find(post => post.author?.screen_name?.toLowerCase() === handle.toLowerCase())?.author?.avatar_url || prior?.avatar || member.state.avatar;
      const found = link ? {handle, avatar, space: link.space, postUrl: 'https://x.com/' + handle + '/status/' + link.post.id, title: candidate?.title || memberNames[handle.toLowerCase()] + '의 스페이스'} : null;
      const state = decideSpaceStatus({prior, found, candidate, previous, feedFresh: feed.fresh});
      const next = {...state, handle, avatar, discoverySource: feed.source || null, discoveryWarning: feed.warning || null, checkedAt: iso(), stateCheckedAt: state.authoritative ? iso() : null, stale: !state.authoritative && state.status === 'unknown'};
      if (stopped) return;
      const startedAt = link && state.space === link.space ? Number(link.post.created_timestamp) * 1000 : member.startedAt;
      await commitMember(handle, member, next, startedAt);
    } catch (error) {
      report('member:v2:' + handle,error);
      if (!stopped) { member.state = {...member.state, status: 'unknown', stale: true, warning: error.message}; await emit(onMembers,snapshot()); }
    }
  }

  function envelope(room, messages, cursor = room.historyCursor) {
    return {postId: room.postId, messages, historyCursor: cursor, hasMore: false, shared: true, collecting: false, stopped: room.state === 'Ended' || !!room.retired, source: 'fxtwitter', limited: true, total: room.total ?? null, checkedAt: room.checkedAt, stale: !!room.error, warning: room.error || null, pollIntervalMs: room.state === 'Ended' ? null : replyInterval([...rooms.values()].filter(value => !value.retired && value.state !== 'Ended').length)};
  }
  async function collectRoom(room) {
    room.fetchCount++; room.lastStarted = now();
    const inserted = [];
    try {
      const data = parseFxReplies(await request('https://api.fxtwitter.com/2/conversation/' + room.postId + '?ranking_mode=recency', {}, 'fx'), room.postId);
      if (stopped || room.retired) return;
      const fresh = data.messages.filter(message => !room.seen.has(message.id));
      for (let offset = 0; offset < fresh.length; offset += 40) {
        const part = fresh.slice(offset,offset + 40), args = [];
        const placeholders = part.map((message,index) => { args.push(room.postId,message.id,JSON.stringify(message)); return '(' + [1,2,3].map(n => '?' + (index * 3 + n)).join(',') + ')'; });
        const rows = (await db.prepare('INSERT INTO broadcast_messages(post_id,id,payload) VALUES ' + placeholders.join(',') + ' ON CONFLICT(post_id,id) DO NOTHING RETURNING seq,payload').bind(...args).all()).results;
        for (const row of rows) inserted.push({seq: Number(row.seq), message: JSON.parse(row.payload)});
        for (const message of part) room.seen.add(message.id);
      }
      room.checkedAt = iso(); room.total = data.total; room.error = null; room.failureCount = 0;
    } catch (error) {
      if (!stopped) {
        if (!error.deferred) { room.failureCount++; room.error = error.message; report('replies:fxtwitter:' + room.postId,error); }
        room.due = Math.max(room.due, now() + (error.deferred ? 1000 : 3000), error.retryAt || 0);
      }
    } finally {
      // If a later insert batch fails, already committed rows must still reach clients.
      if (inserted.length && !stopped) {
        inserted.sort((a,b) => a.seq - b.seq);
        room.historyCursor = inserted.at(-1).seq;
        if (!room.retired) {
          room.rows.push(...inserted);
          if (room.rows.length > CACHE_MESSAGES) { room.hasEarlier = true; room.rows.splice(0,room.rows.length - CACHE_MESSAGES); }
          if (room.seen.size > 10000) room.seen = new Set([...room.seen].slice(-5000));
        } else { room.rows = []; room.seen.clear(); }
        await emit(onMessages,envelope(room, inserted.map(row => row.message)));
      }
    }
  }

  async function flushHealth() {
    const rows = [];
    for (const [handle,member] of members) rows.push({key: 'member:v2:' + handle, payload: {...member.state, checkedAt: member.state.checkedAt || iso()}, started: member.lastStarted || now(), due: member.due, count: member.fetchCount, error: member.state.warning || null});
    for (const room of rooms.values()) if (room.fetchCount && !room.retired) rows.push({key: 'replies:fxtwitter:' + room.postId, payload: envelope(room, []), started: room.lastStarted || now(), due: room.due, count: room.fetchCount, failures: room.failureCount, error: room.error || null});
    for (let offset = 0; offset < rows.length; offset += 15) {
      const args = [], placeholders = rows.slice(offset, offset + 15).map((row,index) => { args.push(row.key, JSON.stringify(row.payload), row.due, row.started, row.count, row.failures || 0, row.error); return '(' + [1,2,3,4,5,6,7].map(n => '?' + (index * 7 + n)).join(',') + ')'; });
      await db.prepare(`INSERT INTO collector_entries(key,payload,next_poll_at,last_started_at,fetch_count,failure_count,last_error) VALUES ${placeholders.join(',')}
        ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,next_poll_at=excluded.next_poll_at,last_started_at=excluded.last_started_at,fetch_count=excluded.fetch_count,failure_count=excluded.failure_count,last_error=excluded.last_error,lease_until=0,lease_token=''`).bind(...args).first();
    }
  }

  async function initialize() {
    if (initialized) return;
    initialization ||= (async () => {
      const [sessions, entries] = await Promise.all([
        db.prepare('SELECT handle,started_at,payload FROM broadcast_sessions').bind().all(),
        db.prepare("SELECT key,payload,next_poll_at,fetch_count,failure_count,last_started_at,last_error FROM collector_entries WHERE key LIKE 'member:v2:%' OR key LIKE 'timeline:%' OR key LIKE 'notification-posts:%' OR key LIKE 'budget:pause:%' OR key LIKE 'replies:fxtwitter:%'").bind().all(),
      ]);
      for (const row of entries.results) {
        const data = parse(row.payload);
        if (row.key.startsWith('budget:pause:')) { const source = row.key.split(':')[2]; if (source in providerPause) providerPause[source] = Number(row.next_poll_at); continue; }
        if (!data) continue;
        const handle = row.key.split(':').at(-1), member = members.get(handle);
        if (!member) continue;
        if (row.key.startsWith('member:')) { member.state = {...data, status: 'unknown', stale: true}; member.fetchCount = Number(row.fetch_count || 0); }
        else if (row.key.startsWith('timeline:')) { const source = row.key.split(':')[1]; member.sources[source] = {source, posts: data.posts || [], at: Date.parse(data.checkedAt) || 0, next: 0, failures: 0}; }
        else member.posts = data.posts || [];
      }
      for (const row of sessions.results) {
        const member = members.get(row.handle), state = parse(row.payload);
        if (!member || !state) continue;
        member.retained = state; member.startedAt = Number(row.started_at); member.state = {...state, ...member.state, handle: row.handle};
        await loadRoom(state);
      }
      for (const row of entries.results) if (row.key.startsWith('replies:fxtwitter:')) {
        const room = rooms.get(row.key.split(':').at(-1));
        if (!room) continue;
        const data = parse(row.payload, {});
        room.checkedAt = data.checkedAt || null; room.total = data.total; room.fetchCount = Number(row.fetch_count || 0); room.failureCount = Number(row.failure_count || 0); room.error = row.last_error || null;
      }
      initialized = true; healthDue = now() + HEALTH_INTERVAL;
    })().catch(error => { initialization = null; throw error; });
    return initialization;
  }
  function snapshot() { return [...members.values()].map(member => ({...member.state})); }
  function step() {
    if (!initialized || stopped) return 1000;
    for (const [handle,member] of members) if (!member.pending && member.due <= now()) {
      member.due = now() + PROFILE_INTERVAL; member.dirty = false;
      member.pending = track(checkMember(handle,member).finally(() => { member.pending = null; if (member.dirty) member.due = 0; trimMetadataCache(); }));
    }
    const active = [...rooms.values()].filter(room => room.state !== 'Ended' && !room.retired && !room.ending);
    for (const room of active) if (!room.pending && room.due <= now()) {
      room.due = now() + replyInterval(active.length);
      room.pending = track(collectRoom(room).finally(() => { room.pending = null; }));
    }
    if (!healthPending && healthDue <= now()) {
      healthDue = now() + HEALTH_INTERVAL;
      healthPending = track(flushHealth().catch(error => report('collector:health',error)).finally(() => { healthPending = null; }));
    }
    return active.length ? 100 : 1000;
  }
  function ingestPosts(posts) {
    // Serial persistence prevents an older inbox scan overwriting a newer push.
    const job = ingestion.catch(() => {}).then(async () => {
      if (stopped) return 0;
      let accepted = 0;
      const changes = new Map();
      for (const post of (posts || []).slice(0,100)) {
        const handle = handles.find(handle => handle.toLowerCase() === post?.author?.screen_name?.toLowerCase());
        if (!handle || !/^\d{2,20}$/.test(post.id || '') || typeof post.text !== 'string' || post.text.length > 30000) continue;
        const prior = changes.get(handle) || members.get(handle).posts;
        if (prior.some(value => value.id === post.id)) continue;
        const clean = {id: post.id, text: post.text, created_timestamp: Number(post.created_timestamp) || 0, author: {screen_name: handle}, raw_text: {facets: []}};
        onEvent('post.received',{handle,postId:post.id,postedAt:clean.created_timestamp*1000,source:'x-notifications'});changes.set(handle,combinePosts([clean],prior)); accepted++;
      }
      for (const [handle,posts] of changes) {
        await db.prepare(`INSERT INTO collector_entries(key,payload,next_poll_at) VALUES(?1,?2,0) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload RETURNING key`).bind('notification-posts:' + handle, JSON.stringify({posts,checkedAt:iso()})).first();
        const member = members.get(handle);
        member.posts = posts; member.dirty = true; member.due = 0;
      }
      return accepted;
    });
    ingestion = job;
    return track(job);
  }
  async function room(postId, {after = 0, latest = true, before = 0} = {}) {
    let state = rooms.get(String(postId));
    if (!state) {
      if (!/^\d{2,20}$/.test(String(postId))) throw Error('등록된 방송 기록을 찾지 못했습니다.');
      const last = await db.prepare('SELECT seq FROM broadcast_messages WHERE post_id=?1 ORDER BY seq DESC LIMIT 1').bind(String(postId)).first();
      if (!last) throw Error('등록된 방송 기록을 찾지 못했습니다.');
      // A retired descriptor may have been evicted; its durable history remains readable.
      state = {postId: String(postId), state: 'Ended', retired: true, historyCursor: Number(last.seq)};
    }
    await state.loading;
    if (state.retired) return {...envelope(state,[]), ...await (before > 0 || latest ? recentBroadcastHistory(db,state.postId,before) : broadcastHistory(db,state.postId,after))};
    if (before > 0) return {...envelope(state,[]), ...await recentBroadcastHistory(db, state.postId, before)};
    if (latest) {
      const page = state.rows.slice(-200);
      return {...envelope(state,page.map(row => row.message)), olderCursor: page[0]?.seq || 0, hasOlder: state.hasEarlier || state.rows.length > 200};
    }
    if (state.hasEarlier && after < (state.rows[0]?.seq || 0)) return {...envelope(state,[]), ...await broadcastHistory(db,state.postId,after)};
    const rows = state.rows.filter(row => row.seq > after);
    return envelope(state,rows.map(row => row.message),rows.at(-1)?.seq || after);
  }
  async function resolve(input) {
    let id = String(input || ''), postId = null;
    if (/^https?:/.test(id)) {
      const url = new URL(id);
      if (!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)) throw Error('X URL을 입력해 주세요.');
      postId = url.pathname.match(/\/status\/(\d{2,20})(?:\/|$)/)?.[1] || null;
      id = url.pathname.match(/\/i\/spaces\/([A-Za-z0-9]+)/)?.[1] || '';
    }
    const state = [...members.values()].map(member => member.retained).find(value => value && (postId ? postIdOf(value) === postId : value.space === id));
    if (!state) throw Error('아직 수집되지 않은 방송입니다.');
    return {id: state.space, tweet: postIdOf(state), handle: state.handle, title: state.title, avatar: state.avatar, state: state.state, startedAt: state.startedAt, currentParticipants: state.currentParticipants};
  }
  return {initialize, step, ingestPosts, snapshot, room, resolve, stop() { stopped = true; abort.abort(); }, async settled() { await Promise.allSettled([...pending]); }};
}
