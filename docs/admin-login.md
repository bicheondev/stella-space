# Operations login

The repository and public chat remain public. `/ops`, `/ops/debug`, and every `/api/admin/*` route require a signed administrator session. GitHub's numeric user ID `44262309` (bicheondev) is the only permitted identity. Changing a GitHub username does not grant access to a different account.

## Production configuration

Create a dedicated GitHub OAuth App with:

- Homepage: `https://spacelive.vercel.app`
- Redirect URI: `https://spacelive.vercel.app/api/auth/github/callback`
- Wildcard redirects and Device Flow disabled

Set these server-only Production variables in Vercel, then deploy:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `ADMIN_SESSION_SECRET`: a separate cryptographically random secret (at least 32 random bytes)

Do not change `OPERATIONS_SECRET` as part of login setup: it encrypts existing integrations. Never commit credentials. With missing OAuth configuration, the console shows a setup message and admin APIs remain inaccessible.

## Security behavior

- OAuth authorization-code flow with random state, S256 PKCE and a fixed production callback.
- No additional GitHub scopes. The access token is used to retrieve `/user` and is not persisted or returned to the browser.
- OAuth state/verifier are encrypted in a ten-minute `__Host-` cookie.
- Administrator session is independently signed, expires after twelve hours and uses an HttpOnly, Secure, SameSite=Lax `__Host-` cookie.
- Legacy `ops` cookies are rejected. Old secret URLs redirect to `/ops` without issuing credentials.
- Logout requires a same-origin POST. It clears browser session cookies. A copied session cookie remains valid until its expiry; rotating `ADMIN_SESSION_SECRET` invalidates all sessions immediately.
- Existing collector machine authentication (`COLLECTOR_SECRET`) is separate and unchanged.

To change the allowed owner, review and update `adminUserId` in `server/admin-auth.js`, update its tests, rotate `ADMIN_SESSION_SECRET` and deploy. Do not use only a username or client-supplied account identity for authorization.
