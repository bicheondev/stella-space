import {randomUUID} from 'node:crypto';
import {openWebPush} from '../scripts/web-push.mjs';
import {notificationPosts, syncFollowNotifications} from '../scripts/x-notifications.mjs';
import {notificationConfig, signedXHeaders, createXHeaderSigner, webPushControl} from '../server/x-notifications.js';
import {memberHandles} from '../worker/index.js';

const LEASE_MS = 60000;
const RENEW_MS = 10000;
const HEALTH_MS = 20000; // The existing operations dashboard expires push health after 30 seconds.
const CONFIG_MS = 60000;
const INBOX_PATH = '/2/notifications/device_follow.json';

async function writeHealth(db, owner, value) {
  await db.prepare(`INSERT INTO collector_entries(key,payload,next_poll_at) VALUES(?1,?2,0)
    ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,last_error=NULL RETURNING key`)
    .bind('x-notifications:' + owner, JSON.stringify(value)).first();
}

async function writeFollowSetup(db, value) {
  await db.prepare(`INSERT INTO operations_settings(key,value) VALUES('x_follow_setup',?1)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE json_extract(excluded.value,'$.checkedAt')>=json_extract(operations_settings.value,'$.checkedAt') RETURNING key`)
    .bind(JSON.stringify(value)).first();
}

/**
 * One DO owns one receiver. Construction is inert; its owner calls step() only after activation.
 * step() does not await X requests: pass the DO's waitUntil to retain that bounded work.
 * The Turso lease fences overlapping deployments and the previous Actions receiver.
 */
export function createNotificationReceiver({
  db, signal, onPosts = async () => {}, onHealth = async () => {},
  waitUntil = () => {}, fetcher = fetch, now = Date.now,
  owner = randomUUID(), loadConfig = notificationConfig, control = webPushControl,
  openPush = openWebPush, headersFor = signedXHeaders, syncFollows = syncFollowNotifications,
  beforeConnect = async () => {},
  persistHealth = writeHealth, persistFollowSetup = writeFollowSetup,
} = {}) {
  let stopped = false, session = null, configured = false, owned = false;
  let lastFailure=null;
  let mode = 'stopped', error = null, pushClient = null, connection = null;
  let epoch = 0, ownedController = null, leaseUntil = 0, leaseTimer;
  let nextLeaseAt = 0, nextConfigAt = 0, nextConnectAt = 0, nextScanAt = 0, nextFollowAt = 0;
  let savedPushState = null, healthDirty = false, scanRetryAt = 0;
  let lastHealthAt = -Infinity, lastPushAt = null, lastScanAt = null, postsReceived = 0;
  let connectFailures = 0, scanFailures = 0, dirty = false, followSetup = null;
  let stepPending = null, scanPending = null, connectPending = null, followPending = null, healthPending = null;
  let stopPending = null;
  const lifetime = new AbortController(), pending = new Set(), seen = new Set();
  const buildHeaders = headersFor === signedXHeaders ? createXHeaderSigner({fetcher, now, signal: lifetime.signal}) : headersFor;
  const active = token => !stopped && owned && token === epoch && now() < leaseUntil;
  const status = () => ({
    configured, owned: owned && now() < leaseUntil, mode, pushConnected: owned && now() < leaseUntil && !!pushClient,
    lastPushAt, lastScanAt, postsReceived, error, followSetup, lastFailure,
    source: 'cloudflare', checkedAtMs: Number.isFinite(lastHealthAt) ? lastHealthAt : null,
  });

  function track(promise) {
    const safe = Promise.resolve(promise).catch(() => {}).finally(() => pending.delete(safe));
    pending.add(safe);
    waitUntil(safe);
    return safe;
  }

  function closePush() {
    const oldConnection = connection, oldClient = pushClient;
    connection = null;
    pushClient = null;
    oldConnection?.abort();
    try { oldClient?.close(); } catch {}
  }

  function loseOwnership(message = null) {
    const hadOwnership = owned;
    owned = false;
    leaseUntil = 0;
    clearTimeout(leaseTimer);
    epoch++;
    ownedController?.abort();
    ownedController = null;
    closePush();
    mode = 'stopped';
    error = message;
    if (hadOwnership && !stopped) publish(true);
  }

  function publish(force = false) {
    if (healthPending) {
      healthDirty ||= force;
      return healthPending;
    }
    if (!force && now() - lastHealthAt < HEALTH_MS) return healthPending;
    const value = {...status(), checkedAtMs: now(), checkedAt: new Date(now()).toISOString()};
    const task = (async () => {
      await persistHealth(db, owner, value);
      lastHealthAt = value.checkedAtMs;
      await onHealth({...value});
    })();
    healthPending = track(task).finally(() => {
      healthPending = null;
      if (healthDirty) {
        healthDirty = false;
        publish(true);
      }
    });
    return healthPending;
  }

  async function renew() {
    if (now() < nextLeaseAt) return owned && now() < leaseUntil;
    const started = now();
    nextLeaseAt = started + RENEW_MS;
    try {
      const lease = await control(db, {owner});
      if (stopped) return false;
      if (!lease.owned || now() >= started + LEASE_MS) {
        loseOwnership();
        return false;
      }
      savedPushState = lease.state;
      if (!owned) {
        owned = true;
        epoch++;
        ownedController = new AbortController();
        nextScanAt = 0;
        mode = 'connecting';
      }
      leaseUntil = started + LEASE_MS;
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(() => loseOwnership('푸시 수신 담당 확인 대기'), Math.max(1, leaseUntil - now()));
      leaseTimer.unref?.();
      return lease;
    } catch {
      loseOwnership('푸시 수신 담당 확인 대기');
      return false;
    }
  }

  function startConnection(state) {
    if (connectPending || pushClient || now() < nextConnectAt || !active(epoch)) return;
    const token = epoch, selectedSession = session;
    const current = new AbortController();
    connection = current;
    const connectionSignal = AbortSignal.any([lifetime.signal, ownedController.signal, current.signal]);
    const task = (async () => {
      try {
        const client = await openPush({
          session: selectedSession, state, signal: connectionSignal, fetcher, headersFor: buildHeaders, beforeConnect,
          onNotification: async () => {
            if (!active(token) || connection !== current) return;
            lastPushAt = now();
            error = null;
            await requestScan(true);
          },
          onDisconnected: () => {
            if (!active(token) || connection !== current) return;
            closePush();
            mode = 'polling';
            error = '푸시 재연결 대기 · 알림함 보조 조회 중';
            nextConnectAt = now() + Math.min(60000, 1000 * 2 ** Math.min(connectFailures++, 6));
            nextScanAt = Math.min(nextScanAt, now() + 5000);
            publish(true);
          },
          saveState: async value => {
            if (!active(token) || connectionSignal.aborted) throw Error('수신 담당 변경');
            const saved = await control(db, {owner, state: value});
            if (!saved.owned) loseOwnership();
            if (!saved.owned || !active(token) || connectionSignal.aborted) throw Error('수신 담당 변경');
            savedPushState = value;
          },
        });
        if (!active(token) || connection !== current || connectionSignal.aborted) {
          client.close();
          return;
        }
        pushClient = client;
        connectFailures = 0;
        mode = 'push';
        error = null;
        publish(true);
      } catch (failure) {
        lastFailure=String(failure?.message).slice(0,180);
        if (!active(token) || connection !== current) return;
        closePush();
        mode = 'polling';
        error = '푸시 재연결 대기 · 알림함 보조 조회 중';
        nextConnectAt = now() + Math.min(60000, 1000 * 2 ** Math.min(connectFailures++, 6));
        publish(true);
      }
    })();
    connectPending = track(task).finally(() => { connectPending = null; });
  }

  function requestScan(fromPush = false) {
    if (!active(epoch) || now() < nextScanAt && !fromPush) return Promise.resolve();
    // A rate-limit backoff also applies to incoming pushes.
    if (now() < scanRetryAt) return Promise.resolve();
    if (scanPending) {
      if (fromPush) dirty = true;
      return scanPending;
    }
    const token = epoch, selectedSession = session;
    const scanSignal = AbortSignal.any([lifetime.signal, ownedController.signal]);
    const task = (async () => {
      let passes = 0;
      do {
        dirty = false;
        if (!active(token)) return;
        try {
          const headers = await buildHeaders(selectedSession, 'GET', INBOX_PATH);
          if (!active(token)) return;
          const response = await fetcher('https://api.x.com' + INBOX_PATH + '?count=40&tweet_mode=extended', {
            headers, redirect: 'error', signal: AbortSignal.any([scanSignal, AbortSignal.timeout(15000)]),
          });
          if (!active(token)) return;
          if (!response.ok) {
            if (response.status === 429) {
              const after = Number(response.headers.get('retry-after'));
              const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
              nextScanAt = Math.max(now() + 30000, after > 0 ? now() + after * 1000 : 0, reset || 0);
              scanRetryAt = nextScanAt;
            }
            throw Error('알림함 조회 실패');
          }
          const data = await response.json();
          if (data.errors?.length) throw Error('알림함 조회 실패');
          const posts = notificationPosts(data).filter(post => !seen.has(post.id));
          if (!active(token)) return;
          if (posts.length) await onPosts(posts, {signal: scanSignal});
          if (!active(token)) return;
          for (const post of posts) seen.add(post.id);
          if (seen.size > 5000) {
            const keep = [...seen].slice(-2000);
            seen.clear();
            for (const id of keep) seen.add(id);
          }
          postsReceived += posts.length;
          lastScanAt = now();
          scanFailures = 0;
          scanRetryAt = 0;
          error = null;
          nextScanAt = now() + (pushClient ? 30000 : 5000);
          publish();
        } catch (failure) {
          lastFailure=String(failure?.message).slice(0,180);
          if (!active(token)) return;
          error = 'X 알림함 조회 실패 · 세션 또는 제공처 상태를 확인하세요.';
          nextScanAt = Math.max(nextScanAt, now() + Math.min(60000, 5000 * 2 ** Math.min(scanFailures++, 4)));
          scanRetryAt = Math.max(scanRetryAt, nextScanAt);
          publish();
          return;
        }
      } while (dirty && ++passes < 2 && active(token));
      if (dirty) nextScanAt = now();
    })();
    scanPending = track(task).finally(() => { scanPending = null; });
    return scanPending;
  }

  function startFollowSetup() {
    if (followPending || !active(epoch) || followSetup?.retryAt > now() || now() < nextFollowAt) return;
    const enabled = memberHandles.filter(handle => followSetup?.enabled?.includes(handle));
    // Setting up all 15 accounts at once can exceed the Free plan's per-event subrequest limit.
    const targets = memberHandles.filter(handle => !enabled.includes(handle)).slice(0, 3);
    if (!targets.length) return;
    nextFollowAt = now() + CONFIG_MS;
    const token = epoch, selectedSession = session;
    const setupSignal = AbortSignal.any([lifetime.signal, ownedController.signal]);
    const task = (async () => {
      try {
        const previous = JSON.stringify(followSetup);
        const partial = await syncFollows({...selectedSession, followSetup: {...followSetup, enabled: []}}, {
          now: now(), headersFor: buildHeaders, targets,
          fetcher: (url, init = {}) => {
            if (!active(token)) throw Error('수신 담당 변경');
            return fetcher(url, {...init, signal: AbortSignal.any([setupSignal, ...(init.signal ? [init.signal] : [])])});
          },
        });
        if (!active(token)) return;
        const combined = new Set([...enabled, ...partial.enabled]);
        const result = {...partial, enabled: memberHandles.filter(handle => combined.has(handle)),
          pending: memberHandles.filter(handle => !combined.has(handle))};
        followSetup = result;
        if (!result.retryAt && result.pending.length) nextFollowAt = now() + 1000;
        if (JSON.stringify(result) !== previous) await persistFollowSetup(db, result);
      } catch {
        if (active(token)) followSetup = {...followSetup, retryAt: now() + 300000};
      }
    })();
    followPending = track(task).finally(() => { followPending = null; });
  }

  async function performStep() {
    if (stopped || signal?.aborted) return status();
    if (owned && now() >= leaseUntil) loseOwnership('푸시 수신 담당 확인 대기');
    if (now() >= nextConfigAt) {
      nextConfigAt = now() + CONFIG_MS;
      try {
        const next = await loadConfig(db);
        if (stopped) return status();
        if (session && (next?.auth_token !== session.auth_token || next?.ct0 !== session.ct0)) {
          closePush();
          ownedController?.abort();
          ownedController = owned ? new AbortController() : null;
          epoch++;
          nextConnectAt = 0;
          nextScanAt = 0;
          nextFollowAt = 0;
        }
        session = next;
        configured = !!next;
        followSetup = next?.followSetup || followSetup;
      } catch {
        error = 'X 봇 연결 설정을 확인하지 못했습니다.';
      }
    }
    if (!session) {
      if (owned) {
        loseOwnership();
        await idle();
        await control(db, {owner, action: 'release'}).catch(() => {});
      }
      return status();
    }
    const lease = await renew();
    if (!lease || stopped) return status();
    startConnection(savedPushState);
    requestScan();
    startFollowSetup();
    publish();
    return status();
  }

  function step() {
    if (!stepPending) stepPending = performStep().finally(() => { stepPending = null; });
    return stepPending;
  }

  function stop() {
    if (stopPending) return stopPending;
    stopped = true;
    lifetime.abort();
    signal?.removeEventListener('abort', handleAbort);
    const shouldRelease = owned || !!stepPending;
    loseOwnership();
    session = null;
    stopPending = (async () => {
      await stepPending?.catch(() => {});
      await idle();
      // Release after state saves settle, so a late save cannot reacquire a released lease.
      if (shouldRelease) await control(db, {owner, action: 'release'}).catch(() => {});
      if (Number.isFinite(lastHealthAt)) await publish(true);
    })();
    return stopPending;
  }

  async function idle() {
    while (pending.size) await Promise.all([...pending]);
  }
  function handleAbort() { waitUntil(stop()); }
  signal?.addEventListener('abort', handleAbort, {once: true});
  return {step, stop, status, idle};
}
