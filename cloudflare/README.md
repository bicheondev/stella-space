# Spacelive realtime migration

Deployment is restricted to the personal Cloudflare account pinned in `wrangler.jsonc`.
Never deploy this project to a company account or authorize all accounts. Verify
`wrangler whoami` before uploading code or secrets. No paid plan is required by
this configuration; changing plans requires the owner's decision.

## Ownership and traffic

Vercel serves static member pages, OAuth, the operations console and feedback.
The browser connects directly to the Cloudflare Worker over HTTPS/WebSocket.
The Worker routes every member and viewer to one SQLite-backed Durable Object,
`spacelive-v3` (the pinned `COORDINATOR_NAME`). That single object owns collection, the shared recent-message cache,
X push reception, and fanout. Turso retains the existing session/message archive.
Public reads never start another provider collection job.

The initial deployment is paused. It can load retained history but cannot collect
until an authenticated `POST /control/start`. `/control/status` and
`POST /control/stop` require `Authorization: Bearer <COLLECTOR_SECRET>` too.
Public `/health` reports readiness and enabled state only. All public data remains
public X content; credentials, integration settings and operational errors are
excluded. Only `https://spacelive.vercel.app` may open browser WebSockets.

## Free plan budget (verified 2026-10-23)

Official references:

- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/

| Resource | Free allowance | Design / estimate |
|---|---:|---|
| Worker requests | 100,000/day, account-wide | WebSocket handshake + initial/history HTTP, no healthy polling |
| DO requests | 100,000/day | Handshakes/HTTP, alarms, and inbound WS messages at 20:1 |
| DO duration | 13,000 GB-s/day | One continuously active 128 MB object ≈ 11,059 GB-s/day |
| DO SQLite rows written | 100,000/day | Each alarm schedule is a write; no chat archive writes here |
| DO SQLite rows read | 5 million/day | Enabled flag and alarm restoration; chats stay in memory/Turso |
| DO storage | 5 GB/account | Enabled flag; the existing archive remains in Turso |
| External subrequests | 50/invocation | Shared 36-request budget for providers, Turso and X bootstrap |

The unrelated koryo-proxy Worker was removed. Any other Workers in this account still share the 100,000 Worker limit. Daily free
limits reset at 00:00 UTC (09:00 KST). Free-limit exhaustion fails requests; it
does not provide an unlimited fallback or guarantee uptime.

A connected viewer does not create another DO or duration allocation. Outbound
chat messages are not billed as incoming DO requests. The browser sends a ping
after 25 seconds of silence; the DO auto-response returns pong. That heartbeat
still contributes to incoming message counts. A viewer's initial archived chat
load uses one request per 200 messages: 2,600 retained messages require about 13
history requests, plus member/resolve/socket setup. This load, reconnections and
other account traffic must be included in capacity estimates.

For example, 1,000 visits each loading 2,600 messages need roughly 17,000 Worker
requests, before reloads/reconnections. At 5,000 such visits the same estimate reaches ~85,000/day, so
that scenario has little headroom. This is a sizing example, not a traffic
forecast or measured production limit.

The DO normally schedules a 30-second watchdog. At high request consumption it
uses a two-second alarm, up to about 43,200 alarms/day if busy continuously.
The existing alarm is reused when due soon, preventing a second storage write
for every budget refill. The shared fetch pool allows four simultaneous HTTP
responses and waits for response bodies to drain, leaving connection capacity
for the outgoing push WebSocket. Timers alone do not replenish the invocation
budget. A remote Free-runtime probe completed 160 requests across four alarms without incoming traffic; the unbudgeted control failed at request 51. Local workerd does not enforce all production quotas.

## Secrets

Upload only `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `COLLECTOR_SECRET`, and
`OPERATIONS_SECRET` to the personal Worker. Keep `OPERATIONS_SECRET` unchanged:
the existing encrypted X/Discord integrations depend on it. Do not copy GitHub
OAuth secrets to Cloudflare. Use a separate Cloudflare control secret, not the old Vercel collector token. Use Wrangler secret upload through a protected
temporary file; never put credentials in this directory, logs or commits.

## Validation and cutover

1. Run the local tests and `wrangler deploy --dry-run -c cloudflare/wrangler.jsonc`.
2. Verify the signed-in personal account and Free plan. Run a private remote
   quota probe with dummy upstream data, without real X/Turso/Discord traffic.
   Do not poll status during the probe: incoming requests also replenish limits
   and could hide a broken background loop. Verify recovery across a restart.
3. Deploy the real Worker paused and upload the four required secrets. Confirm
   read-only history/API/WebSocket behavior before moving collection ownership.
4. Ship the Vercel integration with an empty `SPACELIVE_REALTIME_ORIGIN` first.
   Push to GitHub and verify the automatic Vercel deployment. Use manual deploy
   only if the automatic deployment fails.
5. Set `SPACELIVE_REALTIME_ORIGIN` to the verified Worker origin. Push the cutover
   change and verify the automatic production deployment. The build generates
   static member pages; old hot API calls redirect directly to Cloudflare.
6. Let pre-migration Actions runs finish or stop them. Their older source does
   not understand the migration response. Stop the legacy provider collector
   before starting Cloudflare; do not run two independent provider budgets.
7. Start the private coordinator, verify all members, push ownership, archive
   cursors and fanout. Check Vercel invocations fall and CF counters stay inside
   the account-wide limits. Do not mark migration complete before these checks.

For rollback, stop the Cloudflare coordinator first, remove the Vercel origin,
rebuild/redeploy the previous collector, then resume its Actions workflow. An
automatic fallback to legacy collection is intentionally absent: it would risk
two collectors using independent provider budgets.

## Runtime cutover verification (2026-10-23)

The production coordinator connected to X push, completed authenticated inbox
scans, and resolved all 15 members without provider errors after cutover.
The previous `spacelive` and `spacelive-v2` objects were explicitly stopped.
Do not change `COORDINATOR_NAME` during routine deployments: creating another
active object duplicates collection and consumes duration allowance.

Workers do not support fetch `redirect: error`. The shared request budget maps
it to `manual` and rejects 301/302/303/307/308 without following Location,
preserving the no-redirect policy for authenticated requests. Public provider
requests identify this app with a descriptive User-Agent.

A separate 20-minute soak probe was interrupted by a DO restart at 13m50s;
it completed 28/28 upstream requests before restart with no incoming requests.
This is not a passed 20-minute soak. Production persists the enabled flag and
schedules its watchdog before work so a replacement instance can recover.
The probe has been stopped; it does not run alongside production.

Private local administration uses the git-ignored, mode-600 file
`.env.cloudflare-control` containing `CLOUDFLARE_COLLECTOR_SECRET`:

```sh
node --env-file=.env.cloudflare-control scripts/cloudflare-control.mjs status
```

The same command accepts `start`, `stop`, and `retire-previous`. The last action
only disables the two retired coordinator names. Never print or commit the
control secret. Deploy CF with `--durable-objects-code-update-mode immediate`,
then verify the actual coordinator revision/status; upload success alone does
not prove an existing object is executing the new code.
