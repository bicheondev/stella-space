# FxTwitter reply relay

A private, fixed-destination relay for `/2/conversation/:id?ranking_mode=recency`.
Deno does not hold X login, database, Cloudflare control or Discord credentials.
Set `RELAY_SECRET` in the Deno app's secret environment variables, and set the
same value as `DENO_RELAY_SECRET` on Cloudflare. Never commit either value.

Only `/health` is public. Reply requests require Bearer authorization. Gzip
preserves all upstream payload fields, HTTP errors and Retry-After. No cache or
provider retry is used; concurrent identical requests share one fetch.

Deployment: `deno run -A --no-config --node-modules-dir=auto jsr:@deno/deploy --org bicheondev --app spacelive-fx-relay --prod .`
Run from this directory, never the repository root. CLI authentication may need
browser authorization on hosts without a working keychain.

Cloudflare uses an independent 800,000-request conservative rolling allocation,
plus 10,000 for debug, leaving headroom under the verified Free 1M monthly
request allowance. This is an application guard, not a provider guarantee.
Free CPU, memory and outbound bandwidth remain independent limits. The
operational model is two aggregate broadcast hours/day at two reply requests/s,
not two hours for each member. Process CPU is diagnostic, not provider billing.

Rollback: restore `REPLIES_ORIGIN` to `https://spacelive.vercel.app` in
`cloudflare/wrangler.jsonc` and deploy Cloudflare. The original Vercel endpoint,
credentials and durable budget are retained. No automatic host rotation occurs
on upstream 429; the existing collector respects Retry-After.

## Service lifecycle

Deno announced on 2026-10-09 that Deploy will shut down after six months:
https://deno.com/blog/cloudflare . This relay is a temporary capacity bridge,
not a permanent hosting commitment. Keep the Vercel rollback path available.
