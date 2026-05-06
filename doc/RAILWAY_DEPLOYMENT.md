# Jaban Universe — Paperclip Ops Portal: Railway Deployment Runbook

**Stack:** Paperclip (Railway) · Caddy reverse proxy (Railway) · Zitadel IdP (shared, `auth.binelek.io`) · ops-portal Next.js 14 login shell (Vercel)
**Live URLs:** `ops.binelek.io` (login) · `app.ops.binelek.io` (app)
**Updated:** 2026-05-05

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Public Internet                                             │
│                                                              │
│  https://ops.binelek.io      →  branded login UI (Vercel)   │
│  https://auth.binelek.io     →  Zitadel (shared IdP)        │
│  https://app.ops.binelek.io  →  Caddy → Paperclip           │
└──────────────────────────────────────────────────────────────┘
                        │                       │
                        ▼                       ▼
        ┌───────────────────────┐   ┌───────────────────────┐
        │  Vercel: ops-portal   │   │  Railway: paperclip-ops│
        │  (Next.js 14)         │   │                       │
        │  - Jaban Universe UI  │   │  ┌─────────────────┐  │
        │  - Auth.js + Zitadel  │   │  │ Service: caddy  │  │
        │  - Mints Caddy JWT    │   │  │ - JWT validation│  │
        │  - Sets .binelek.io   │   │  │ - TLS (ACME)    │  │
        │    HttpOnly cookie    │   │  │ - WS proxy      │  │
        └───────────────────────┘   │  └────────┬────────┘  │
                                    │           │           │
                                    │           ▼           │
                                    │  ┌─────────────────┐  │
                                    │  │ Service: paper- │  │
                                    │  │   clip          │  │
                                    │  │ - local_trusted │  │
                                    │  │ - internal only │  │
                                    │  │ - port 3100     │  │
                                    │  └────────┬────────┘  │
                                    │           │           │
                                    │           ▼           │
                                    │  ┌─────────────────┐  │
                                    │  │ Service: postgres│  │
                                    │  │ (managed, Rail.) │  │
                                    │  └─────────────────┘  │
                                    └───────────────────────┘
```

### Auth flow (step by step)

1. Browser → `ops.binelek.io` → Vercel serves branded login page.
2. User clicks **Sign In** → Auth.js redirects to `auth.binelek.io` (Zitadel OIDC).
3. Zitadel authenticates user (password + 2FA TOTP/WebAuthn).
4. Zitadel → redirect to `ops.binelek.io/api/auth/callback/zitadel`.
5. Auth.js validates code, writes encrypted JWT session cookie for `ops.binelek.io`.
6. Browser → `/launch` → immediately redirected to `/api/session`.
7. `/api/session` checks Auth.js session, verifies `paperclip-ops:operator` role,
   mints a `jaban_session` JWT (HS256, 8 h) signed with `CADDY_SESSION_JWT_SECRET`.
8. `/api/session` sets `jaban_session` HttpOnly cookie on `.binelek.io`, redirects
   browser to `https://app.ops.binelek.io/`.
9. Browser → Caddy with `jaban_session` cookie.
10. Caddy `jwtauth` validates cookie signature + claims; on success proxies to
    `paperclip:3100`. On failure → 401 → redirect to `ops.binelek.io/login`.
11. Paperclip runs in `local_trusted` mode — no second login required.

---

## 2. Prerequisites

Before deploying Paperclip, the shared Zitadel instance **must** be running at
`auth.binelek.io` and Kevin must have an account with 2FA enrolled.

### 2a. Register the Paperclip OIDC client in Zitadel

1. Sign in to `auth.binelek.io` as an admin.
2. Navigate to **Organization** → `tucker-operations` → **Projects** → **New Project**: `paperclip-ops`.
3. Inside `paperclip-ops` → **Applications** → **New Application**.
   - Name: `Paperclip Ops Portal`
   - Application Type: **Web**
   - Auth method: **Code** (enable PKCE)
   - Redirect URI: `https://ops.binelek.io/api/auth/callback/zitadel`
   - Post-logout URI: `https://ops.binelek.io/login`
4. **Save** and copy the **Client ID** and **Client Secret**. Store them in a password manager.
5. Navigate to **Roles** → **Add Role**: `paperclip-ops:operator`.
6. Navigate to **Authorizations** → grant Kevin (`kevin@binelek.io`) the `paperclip-ops:operator` role.

### 2b. Generate shared secrets

Run these locally (or in any shell with `openssl` available):

```bash
# Auth.js session secret (Vercel)
openssl rand -hex 32

# Shared Caddy ↔ Vercel JWT signing secret
# Same value goes into Vercel (CADDY_SESSION_JWT_SECRET)
# and Railway caddy service (SESSION_JWT_SECRET).
openssl rand -hex 32
```

Keep both values. They will be needed in steps 4 and 5 below.

---

## 3. Railway Project Setup

Create a new Railway project named **`paperclip-ops`**.

### 3a. Postgres (managed plugin)

1. In the project, click **New Service** → **Database** → **PostgreSQL**.
2. Railway provisions the database and injects `DATABASE_URL` automatically when
   other services reference it via `${{Postgres.DATABASE_URL}}`.

### 3b. Paperclip service

1. **New Service** → **GitHub Repo** → select `k5tuck/paperclip`, branch `master`.
2. Railway auto-detects the `Dockerfile` at the repo root.
3. **Do NOT assign a public domain** to this service. Caddy alone reaches it via
   Railway's internal network.
4. Attach a **Volume**: mount path `/paperclip`, size 5 GB.
5. Set the environment variables listed in §4a.

### 3c. Caddy service

1. **New Service** → **GitHub Repo** → select `k5tuck/paperclip`, set **Root Directory** to `docker/caddy`.
   Railway will build `docker/caddy/Dockerfile` (custom Caddy + JWT plugin).
2. Assign the public domain `app.ops.binelek.io`.
3. Set the environment variables listed in §4b.

---

## 4. Environment Variables

**Never commit real values. All secrets live in Railway / Vercel dashboards only.**

### 4a. `paperclip` service

| Variable | Description |
|---|---|
| `DATABASE_URL` | Use Railway variable reference: `${{Postgres.DATABASE_URL}}` |
| `HOST` | `0.0.0.0` |
| `PORT` | `3100` |
| `NODE_ENV` | `production` |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` — disables Paperclip's own auth gate; Caddy is the boundary |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` |
| `PAPERCLIP_HOME` | `/paperclip` |
| `PAPERCLIP_INSTANCE_ID` | `default` |
| `SERVE_UI` | `true` |
| `BETTER_AUTH_SECRET` | Strong random string (generate: `openssl rand -hex 32`); still needed for internal session tokens even in `local_trusted` mode |
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `OPENAI_API_KEY` | Your OpenAI key |

### 4b. `caddy` service

| Variable | Description |
|---|---|
| `ACME_EMAIL` | `kevin@binelek.io` — for Let's Encrypt notifications |
| `PAPERCLIP_UPSTREAM` | `paperclip.railway.internal:3100` |
| `SESSION_JWT_SECRET` | The shared 32-byte hex secret (same value as Vercel's `CADDY_SESSION_JWT_SECRET`) |

### 4c. Vercel `ops-portal` environment variables

| Variable | Description |
|---|---|
| `AUTH_SECRET` | 32-byte hex, used by Auth.js to encrypt session cookies |
| `AUTH_ZITADEL_ISSUER` | `https://auth.binelek.io` |
| `AUTH_ZITADEL_ID` | Zitadel client ID from §2a |
| `AUTH_ZITADEL_SECRET` | Zitadel client secret from §2a |
| `CADDY_SESSION_JWT_SECRET` | Same value as Railway caddy's `SESSION_JWT_SECRET` |
| `APP_URL` | `https://app.ops.binelek.io` |
| `NEXTAUTH_URL` | `https://ops.binelek.io` |

---

## 5. DNS Configuration (Vercel DNS)

Log in to Vercel DNS for `binelek.io`. Add or verify these records:

| Name | Type | Value | Proxy |
|---|---|---|---|
| `ops` | CNAME | `cname.vercel-dns.com` | — (Vercel manages TLS) |
| `app.ops` | CNAME | `<Railway-provided CNAME for caddy service>` | off (Caddy manages TLS via ACME) |

Find the Railway CNAME under the caddy service → **Settings** → **Networking** →
**Custom Domain** → copy the target hostname.

Caddy auto-provisions a Let's Encrypt cert for `app.ops.binelek.io` on first
HTTPS request. Allow up to 60 seconds on first hit.

---

## 6. Vercel App Deployment

The `ops-portal/` directory in this repo contains the Vercel app. For its own
deployments, it is best treated as a separate Vercel project rooted at that
subdirectory (Vercel supports monorepo root directories).

1. In Vercel dashboard → **New Project** → import `k5tuck/paperclip`.
2. Set **Root Directory** to `ops-portal`.
3. Vercel auto-detects Next.js; leave build settings as default.
4. Set the environment variables from §4c for the **Production** environment.
5. Add `ops.binelek.io` as a custom domain. Vercel will validate via DNS.

---

## 7. First Deployment & Smoke Test

Deploy all services (Railway redeploys paperclip and caddy; Vercel deploys ops-portal).

Smoke test in a private/incognito window:

```
1. https://ops.binelek.io
   → Branded Jaban Universe login page appears

2. Click "Sign In"
   → Redirected to https://auth.binelek.io (Zitadel)
   → Authenticate with Kevin's credentials + TOTP

3. Zitadel redirects back to ops.binelek.io/api/auth/callback/zitadel
   → Auth.js establishes session
   → Browser lands on /launch, immediately redirects to /api/session

4. /api/session mints Caddy JWT, sets jaban_session cookie on .binelek.io
   → Redirects to https://app.ops.binelek.io/

5. Caddy validates jaban_session JWT → proxies to Paperclip
   → Paperclip UI loads
```

Verify session security:
```bash
# Should redirect to ops.binelek.io/login (no valid cookie)
curl -I https://app.ops.binelek.io/
```

---

## 8. Locking Down

After successful first deployment:

1. **Disable Railway auto-generated public URLs** for the `paperclip` service:
   Railway dashboard → paperclip → Settings → Networking → disable the
   `*.up.railway.app` public URL.

2. **Verify isolation:** attempt to reach the Railway-generated URL directly —
   it should return a connection error.

3. **Test Caddy's JWT enforcement:** visit `https://app.ops.binelek.io/` in a
   fresh incognito window without signing in — Caddy must redirect to
   `https://ops.binelek.io/login`.

4. **Test role enforcement:** in Zitadel temporarily revoke Kevin's
   `paperclip-ops:operator` role → try accessing → `/api/session` should return
   403. Re-grant the role.

5. **Configure Railway healthchecks** for both `paperclip` and `caddy` services
   under Settings → Health Checks. Set alerts via Railway's notification
   integrations (email / webhook to a Slack channel).

---

## 9. Adding a New User

1. In Zitadel (`auth.binelek.io`) → Organization → tucker-operations → Users →
   **New User**: enter name, email, set a temporary password.
2. Navigate to `paperclip-ops` project → Authorizations → **New Authorization**
   → select the new user → grant role `paperclip-ops:operator`.
3. Share the login URL (`https://ops.binelek.io`) and the temporary password.
4. On first login the user sets a permanent password and enrolls TOTP (enforced
   by Zitadel's MFA policy; configure this in Zitadel under **Login Policy**).

To add with read-only access (viewer):
- Create a separate `paperclip-ops:viewer` role in Zitadel.
- Update `src/lib/auth.ts` `requireOperatorSession` to also accept `viewer`
  for read-only routes (future work).

---

## 10. Rolling Back a Bad Deploy

### Paperclip service

```
Railway dashboard → paperclip → Deployments → find the last good deploy → Redeploy
```

Paperclip's data lives in the Railway Volume at `/paperclip`, which is
unaffected by redeployments. Database state is in Postgres, also unaffected.

### Caddy service

Caddy has no persistent state (certs are re-issued on first request if lost).
Roll back via Railway Deployments in the same way.

### Vercel ops-portal

```
Vercel dashboard → ops-portal → Deployments → locate last good deployment → Promote to Production
```

---

## 11. Recovering from Lockout

If Zitadel (`auth.binelek.io`) goes down, `ops.binelek.io/login` will show the
Jaban Universe page but "Sign In" will fail — the Zitadel OAuth server is
unreachable.

**Break-glass procedure (access Paperclip directly while Zitadel is down):**

1. In Railway, temporarily add a public domain to the `paperclip` service
   (Settings → Networking → Public Domain).
2. Set a strong `BETTER_AUTH_SECRET` and connect directly to
   `https://<temp-paperclip-domain>/` — Paperclip is in `local_trusted` mode
   so it will load without auth.
3. Once Zitadel is restored, remove the temporary public domain immediately.

**Prevention:** Railway's managed services (Postgres, Redis) have SLAs. Host
Zitadel in a separate Railway service with auto-restart enabled and set up
uptime monitoring (e.g., BetterUptime ping on `auth.binelek.io/healthz`).

---

## 12. JWT Secret Rotation

When rotating `CADDY_SESSION_JWT_SECRET` / `SESSION_JWT_SECRET`:

1. Generate a new secret: `openssl rand -hex 32`
2. Update the Vercel env var `CADDY_SESSION_JWT_SECRET` (new value).
3. Redeploy Vercel — new sessions will use the new secret.
4. Update the Railway caddy service env var `SESSION_JWT_SECRET`.
5. Redeploy Caddy — it will only accept JWTs signed with the new secret.

All existing sessions (`jaban_session` cookies) are immediately invalidated.
Users will be redirected to login automatically. This is the correct behavior.
Schedule rotations during low-traffic periods.

---

## 13. Backup Strategy

### Paperclip Postgres

Railway's managed Postgres includes point-in-time restore (PITR) retention
(check your Railway plan for the exact retention window — typically 7 days on
the Pro plan).

For an additional manual backup:

```bash
# Run from your local machine with Railway CLI authenticated
railway run --service paperclip-ops-postgres \
  pg_dump --no-owner --no-privileges paperclip \
  | gzip > paperclip-$(date +%Y%m%d).sql.gz
```

Schedule weekly via a Railway Cron job or a local cron + Railway CLI.

### Zitadel (separate project)

Zitadel at `auth.binelek.io` is a shared service. Back it up using the same
pg_dump pattern against Zitadel's Postgres. Losing Zitadel without a backup
means losing all user accounts across every product. Treat Zitadel backups as
critical.

### Railway Volume (Paperclip workspace)

The 5 GB volume at `/paperclip` holds agent memory, task files, and uploaded
assets. Volumes are not automatically backed up. Add a daily backup job:

```bash
# Example: run inside the paperclip service via Railway's exec or a sidecar
tar -czf /tmp/paperclip-vol-$(date +%Y%m%d).tar.gz /paperclip
# Then upload to S3 / B2 / R2 using rclone or aws-cli
```

---

## 14. Troubleshooting

### Caddy can't obtain a TLS cert

- Ensure `app.ops.binelek.io` DNS CNAME points to the Railway caddy service's
  hostname and the record has propagated (`dig CNAME app.ops.binelek.io`).
- Check Railway caddy logs: look for `certificate obtained successfully` or
  ACME error messages.
- Let's Encrypt rate-limits: if you hit limits during testing, temporarily
  switch Caddy to the staging ACME server by adding `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` inside the global `{}` block.

### Authelia redirect loop (N/A — no Authelia in this setup)

This deployment uses Zitadel, not Authelia. If you see unexpected redirects,
check Auth.js logs in the Vercel Function logs tab.

### Paperclip WebSockets disconnecting

Caddy proxies WebSocket upgrades in the dedicated `@websocket` matcher. If
WebSockets disconnect:

1. Check Caddy logs for `EOF` or `upstream connection error`.
2. Verify `paperclip.railway.internal:3100` is reachable from the Caddy service
   (Railway private networking — both services must be in the same project).
3. Railway does not time out idle TCP connections on private networking, so
   long-lived WebSockets should be stable. If Paperclip's client-side code
   reconnects automatically, a brief disconnect on redeploy is expected and safe.

### Vercel proxy returning 502

Not applicable — this deployment does not use a Vercel proxy for Paperclip
traffic. Vercel only serves the login shell. If `ops.binelek.io` returns 502,
check Vercel Function logs for startup errors (likely a missing env var; the
`auth.ts` module throws `OIDCConfigurationError` at boot if vars are absent).

### User can't complete TOTP enrollment

TOTP enrollment happens in Zitadel, not in the ops-portal. Direct the user to
`auth.binelek.io` and walk them through Zitadel's MFA setup flow. Zitadel's
TOTP uses standard RFC 6238 — any authenticator app (Authy, Google Authenticator,
1Password) works.

### `/api/session` returns 403

The logged-in user lacks the `paperclip-ops:operator` role in Zitadel.
Grant it via Zitadel Console → `paperclip-ops` project → Authorizations.

### `jaban_session` cookie not set on `app.ops.binelek.io`

The cookie is set with `Domain=.binelek.io` — it applies to all subdomains.
Check browser DevTools → Application → Cookies. If missing, confirm that
`/api/session` redirected (HTTP 302) rather than erroring. Common cause:
`CADDY_SESSION_JWT_SECRET` is not set in Vercel.

---

## 15. Cost Estimate

| Service | Monthly cost (approx.) |
|---|---|
| Railway: paperclip (512 MB RAM, 0.5 vCPU) | $5–15 |
| Railway: caddy | $5 |
| Railway: Postgres (managed) | $5–10 |
| Railway: Volume (5 GB) | $0.50 |
| **Railway subtotal** | **$15–30/mo** |
| Vercel: ops-portal (Hobby tier) | $0 |
| Vercel DNS | $0 |
| **Total** | **~$15–30/mo** |

LLM provider costs (Anthropic, OpenAI) depend entirely on agent activity and
are capped per-agent inside Paperclip's budget settings.

---

## 16. Migrating to More Users

The current Zitadel setup manages users via Zitadel's own user database.
This scales comfortably to tens of users with no changes.

When you reach 20+ users or want SSO federation (e.g., Google Workspace or
GitHub org):

1. In Zitadel → **Identity Providers** → add a social/enterprise provider.
2. Users log in via that provider; Zitadel still enforces MFA and role grants.
3. No changes required to ops-portal or Paperclip.

---

## 17. Connecting Future Projects (HarmonyLab, NKF, etc.)

- Each new project gets its own OIDC client registered in Zitadel under a new
  project (e.g., `harmonylab-admin`).
- Grant users the relevant roles in Zitadel once. Existing accounts carry over.
- Paperclip agents acting on other projects use **scoped service tokens**
  (GitHub PATs, Railway API tokens) configured per-agent in Paperclip's secrets
  — not Zitadel identity.
- Cross-project traffic uses public HTTPS + tokens, not private networking.
  Railway projects are isolated from each other by default.

---

## Self-Critique: Phase 1 (Fork Sanity Check)

**Brittle:** The Dockerfile's final `CMD` calls `tsx` as a loader
(`--import ./server/node_modules/tsx/dist/loader.mjs`). If the tsx version in
`server/node_modules` diverges from what was tested, the server silently fails.
Mitigation: pin tsx in `server/package.json` and lock with `pnpm-lock.yaml`.

**Secret-leak risk:** None specific to this phase — no secrets are in the repo.

**Recovery:** If the production build fails, Railway will show the build log.
Fix the build locally (`pnpm build`) before pushing.

## Self-Critique: Phase 2 (Railway & Caddy)

**Brittle:** `ggicci/caddy-jwt` is a community plugin; its `jwtauth` directive
config syntax could change between patch versions. Pin the xcaddy build to a
specific tag: `--with github.com/ggicci/caddy-jwt/v3@v3.x.y`. Check the
plugin's release page before each Caddy upgrade.

**Secret-leak risk:** `SESSION_JWT_SECRET` in Railway env vars — Railway
encrypts these at rest. Risk is low but rotate quarterly.

**Auth enforced?** Test with `curl -I https://app.ops.binelek.io/` — Caddy must
return `HTTP/2 302` to `ops.binelek.io/login`, not 200.

**If Caddy's JWT validation fails open (bug):** All traffic reaches Paperclip
unauthenticated. Paperclip is in `local_trusted` mode — it does not
authenticate requests. This would be a full exposure. Mitigation: run the
lock-down smoke test in §8 after every Caddy config change.

## Self-Critique: Phase 3 (Vercel ops-portal)

**Brittle:** Next.js 14 App Router + next-auth v5 beta — the beta status means
breaking changes are possible. Lock next-auth to an exact beta version in
`package.json` and test on every dependency update.

**Secret-leak risk:** `CADDY_SESSION_JWT_SECRET` in Vercel env vars. If a
Vercel Function's response body accidentally includes a `console.log` dump of
`process.env`, the secret leaks in Vercel's function logs. The current code does
not log env vars. Keep it that way.

**Session state disagreement:** If Zitadel invalidates a user (e.g., account
disabled) but the `jaban_session` cookie is still valid (up to 8 h), Caddy
continues to grant access until the cookie expires. Mitigation: keep the JWT
TTL at 8 h (not longer) and implement a Zitadel webhook → Railway endpoint to
revoke specific cookies on account suspension (future work).

**WebSocket reliability:** Auth happens at the cookie level. Once Caddy
accepts the cookie, WebSocket connections to Paperclip are long-lived and not
re-checked. If the cookie expires during an active WebSocket session, the
connection persists until the browser closes it or reconnects. This is
acceptable behavior — Paperclip's client reconnects automatically.
