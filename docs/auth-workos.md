# UsingOpen identity — WorkOS AuthKit

UsingOpen accounts are managed by [WorkOS AuthKit](https://workos.com/docs/authkit) on the free tier. The credential authorizes UsingOpen services (for example `usingopen stream` / `usingopen clip` on `live.usingopen.com`); it is **not** a model-provider credential. Two `/login` entries share one credential row:

- **`UsingOpen`** — browser authorization-code flow with PKCE (default).
- **`UsingOpen (device code)`** — the [WorkOS CLI Auth](https://workos.com/docs/authkit/cli-auth) device flow, for machines no browser can reach (`usingopen login usingopen --device`).

The previous Stencil issuer (`auth.usingopen.com`) is deprecated; its login entry remains during the transition so existing Stencil credentials keep refreshing.

## Client id (`USINGOPEN_CLIENT_ID`)

AuthKit identifies the CLI as a **public client**: there is no client secret, and PKCE is what binds the authorization code to the machine that started the flow. The client id is read from the environment rather than baked into the binary, so the AuthKit application can be rotated without a client release:

| Variable                | Used for                                              | Notes                                                                 |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `USINGOPEN_CLIENT_ID`   | WorkOS public client id for both login flows          | Required. From the WorkOS dashboard: your app → **Client ID** (`client_…`). A missing value fails the login with a configuration error instead of an opaque WorkOS `400`. |
| `USINGOPEN_REDIRECT_URI`| Overrides the loopback callback URI                  | See below; also honored by `usingopen auth-broker login --via=…` forwarding. |
| `USINGOPEN_API_KEY`     | Static bearer override for scripts and local dev      | Bypasses the stored credential entirely (like `STENCIL_API_KEY`).      |

```sh
export USINGOPEN_CLIENT_ID="client_01H…"
usingopen login usingopen
```

## Redirect URIs

The browser flow starts a loopback callback server and registers the redirect URI with WorkOS. The default, to add under **Redirects** in the WorkOS dashboard, is:

```
http://127.0.0.1:54551/callback
```

`127.0.0.1` is used deliberately: it binds exactly, while `localhost` may resolve to `::1` first on dual-stack hosts. Set `USINGOPEN_REDIRECT_URI` to re-base the callback (for example a fixed local port or an `https://` URI behind a TLS terminator); the value is advertised verbatim, and HTTP loopback overrides bind the listener to the URI's host/port/path. Port `54551` is also the entry `usingopen auth-broker login usingopen --via=user@host` forwards, so remote logins work unchanged.

When the browser cannot open the callback — SSH sessions, containers, firewalls — paste the final redirect URL when prompted; the flow completes from the URL's `code` parameter. For fully headless machines use the device flow instead.

## Device flow (`--device`)

Per the WorkOS CLI Auth flow (RFC 8628):

1. The CLI POSTs `client_id` to `https://api.workos.com/user_management/authorize/device` and receives `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `interval`, and `expires_in` (300 s).
2. The terminal shows the `user_code` and the verification URI (the complete URI is opened in the browser when one is available). The `device_code` is never displayed.
3. The CLI polls `https://api.workos.com/user_management/authenticate` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, and `client_id`:
   - waits the server-provided `interval` between polls (5 s by default);
   - `authorization_pending` keeps polling;
   - `slow_down` increases the polling interval (clock drift in WSL/VM environments commonly triggers it — sync the clock if the flow stalls);
   - `access_denied` and `expired_token` end the flow with an error;
   - `expires_in` bounds the total wait, so an abandoned login cannot poll forever.

```sh
usingopen login usingopen --device     # or: /login → "UsingOpen (device code)"
```

## Backend services (`WORKOS_API_KEY`)

Backend services act on the staging environment with the WorkOS API key. The
key is read from exactly one file —
`/teamspace/studios/this_studio/.secrets/workos_staging.key`, outside the
checkout with mode `0600` — never from the environment, a log line, or a
commit; the value is never printed. `packages/ai/src/auth/workos-backend.ts`
(`WorkOSBackend`, `loadWorkosApiKey`) wires it up:

| Capability        | Call                                                                                                   | Auth                          |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Token verify      | `verifyAccessToken(token, clientId)` — RS256 signature against `GET /sso/jwks/{clientId}`, then `exp`/`iat` skew and the per-client issuer | the presented user token      |
| User read         | `readUser(userId)` / `listUsers()`                                                                      | API key                       |
| Org read          | `readOrganization(id)` / `listOrganizations()` — the AuthKit `user_management/organizations` routes are not served in staging; the platform `/organizations` API answers there | API key                       |
| Refresh rotation  | `refreshTokenGrant(clientId, refreshToken)` — the reply's refresh token wins when rotated                | API key as the client secret  |
| Ads beacon auth   | `authenticateAdsBeacon({ installId, adId })` — install-id attribution under both header names plus the key as bearer | API key                       |

The staging app is first-party, so its token grants take the API key as the
client secret; the CLI-side public flows (PKCE, device code) stay secret-free.

Live verification burst against staging (reads the key file only; the report
carries statuses and ids, never secret values):

```sh
USINGOPEN_CLIENT_ID=client_… WORKOS_VERIFY_EMAIL=… WORKOS_VERIFY_PASSWORD=… \
  bun --cwd packages/ai run workos:burst
```

Token minting uses a password grant, so the staging user must be created with
`email_verified: true` (`POST /user_management/users`). Set
`WORKOS_VERIFY_USER_ID` / `WORKOS_VERIFY_ORG_ID` to pin read targets;
otherwise the first listed user/organization is used.

Staging observations from the 2026-10 verification run: refresh grants return a
new access token but do **not** rotate the refresh token in this environment
(docs above describe rotation as WorkOS' default; the store adopts whatever the
reply carries either way), and `ads.usingopen.com` has no DNS record yet, so
beacon auth fails at resolution until the ad network is deployed.

## Token storage and refresh rotation

Both flows write the same OAuth row (`usingopen`; the device login aliases its storage onto it) into the local credential store at `~/.usingopen/agent.db`. The database file is `chmod 0600` (owner read/write only) on open, alongside the other stored logins.

WorkOS rotates the refresh token on every exchange: each response carries a **new** `refresh_token`, and the store replaces the previous one with it. Access tokens are JWTs whose `exp` sets the refresh deadline; when a refresh returns `invalid_grant` (revoked or already-rotated token), the row is disabled and a fresh login is required — run either flow again.

With the auth broker configured (`USINGOPEN_AUTH_BROKER_URL`), the row lives on the broker host instead; the broker performs refreshes and never hands out the refresh token. See [auth broker / auth gateway](./auth-broker-gateway.md).

## Free-tier scope: no SSO connections, no custom domain

The free tier constrains what the login URL can express:

- **No SSO connections.** Enterprise connections (SAML/OIDC per customer) require a paid plan, so the authorize URL does not accept a `connection`/`organization` selector. Every sign-in goes through AuthKit itself — social providers, email + password, or Magic Auth, as enabled in the dashboard. The `provider=authkit` authorize parameter selects that handling.
- **No custom AuthKit domain.** Verification URIs and hosted pages are served from the WorkOS-provided domain; `api.workos.com` is the API host for authorize, device, and token endpoints. There is no `auth.usingopen.com` issuer for this provider, and no JWKS endpoint is configured for it.

If the account later moves to a plan with SSO or a custom domain, the endpoints in `packages/catalog/src/compat/rules/auth/usingopen.kdl` are the only values that change.

## Source

`packages/catalog/src/compat/rules/auth/usingopen.kdl`, `packages/catalog/src/compat/rules/auth/usingopen-device.kdl`, `packages/ai/src/registry/oauth/usingopen.ts`, `packages/ai/src/registry/engine/`, `packages/ai/src/auth/`.
