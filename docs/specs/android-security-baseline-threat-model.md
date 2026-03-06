# Paperclip Android Security Baseline and Threat Model

Date: 2026-03-05  
Owner: Security-1 (`OTTAA-49`)  
Scope: Android app surface in `mobile/` and server auth/session/token paths used by mobile clients.

## 1) Current Security Reality (Repo-Grounded)

- Android app is currently scaffold-only (`mobile/App.tsx`), with no auth/session/token logic yet.
- Android project dependencies currently do not include secure credential storage libraries (`mobile/package.json`).
- Server auth supports:
  - board user auth via Better Auth session/cookies (`server/src/middleware/auth.ts`)
  - agent auth via bearer token/API key (`server/src/middleware/auth.ts`, `docs/api/authentication.md`)
- WebSocket auth accepts bearer token OR `token` query parameter (`server/src/realtime/live-events-ws.ts`).
- Better Auth secret currently falls back to a hardcoded development default (`server/src/auth/better-auth.ts`).
- `local_trusted` mode grants implicit board identity with no human login (`server/src/middleware/auth.ts`, `doc/DEPLOYMENT-MODES.md`).

## 2) Threat Model (Auth / Session / Token Handling)

### Assets to Protect

- Human board account/session
- Agent/API credentials
- Company-scoped data (issues, comments, approvals, costs, secrets metadata)
- Real-time event stream (`/api/companies/:companyId/events/ws`)

### Entry Points

- `POST /api/auth/sign-in/email`, `POST /api/auth/sign-up/email`, `POST /api/auth/sign-out`
- `GET /api/auth/get-session`
- API endpoints under `/api/*` protected by actor middleware
- WebSocket upgrades at `/api/companies/:companyId/events/ws`

### Trust Boundaries

- Android device storage <-> app process
- App network stack <-> internet/private network
- API gateway <-> auth/session middleware
- Authenticated user boundary <-> company-scoped resources

### Primary Attack Paths

1. Credential/token extraction from device (backup, rooted device, debug logs).
2. Token leakage in URL/query strings (proxies, logs, crash reports, browser history).
3. Session theft/replay if long-lived credentials are stored or reused improperly.
4. MITM interception on non-pinned TLS paths, especially private-network deployments.
5. Abuse of weak default secrets in authenticated deployments.
6. Credential stuffing/brute-force against email/password auth endpoints.

## 3) Findings and Must-Fix Controls Before Beta

## CRITICAL

### F-01: Auth secret fallback to a known static default
- Evidence: `server/src/auth/better-auth.ts` sets `secret` with fallback `"paperclip-dev-secret"`.
- Impact: if misconfigured in authenticated deployments, session signing can be predictable and forgeable.
- Must-fix control:
  - In `authenticated` mode, fail startup unless `BETTER_AUTH_SECRET` is explicitly set and high entropy.
  - Do not silently fall back to development secrets outside `local_trusted`.

## HIGH

### F-02: WebSocket accepts token in query parameter
- Evidence: `server/src/realtime/live-events-ws.ts` reads `url.searchParams.get("token")`.
- Impact: token exposure via logs, reverse proxies, analytics, crash traces.
- Must-fix control:
  - Remove query token authentication for WebSocket.
  - Accept only `Authorization: Bearer ...` header (or short-lived signed WS ticket from authenticated API).

### F-03: No mobile auth contract yet for human board users
- Evidence: mobile app has no auth implementation (`mobile/App.tsx`), while server currently expects browser-session behavior for board users (`server/src/middleware/auth.ts`, `server/src/middleware/board-mutation-guard.ts`).
- Impact: high risk of ad-hoc credential strategy (for example using agent API keys in app), causing credential sprawl and excessive blast radius.
- Must-fix control:
  - Define and implement dedicated mobile human auth: short-lived access token + rotating refresh token + device binding.
  - Explicitly prohibit agent API keys in mobile app code and config.

### F-04: `local_trusted` mode is inherently unsafe for remote/mobile use
- Evidence: implicit board actor in `local_trusted` (`server/src/middleware/auth.ts`), mode definition in `doc/DEPLOYMENT-MODES.md`.
- Impact: if a device points to a `local_trusted` instance exposed beyond loopback by mistake, unauthorized board-level access risk.
- Must-fix control:
  - Mobile client must refuse non-authenticated deployment targets.
  - Beta environments for mobile testing must run `authenticated` mode only.

## MEDIUM

### F-05: Missing explicit auth rate-limiting/lockout controls
- Evidence: no auth rate-limit middleware present in `server/src`.
- Impact: password endpoint brute-force/credential stuffing risk.
- Must-fix control:
  - Add per-IP + per-account throttling and temporary lockouts on auth endpoints.
  - Log auth abuse events and surface to monitoring.

## 4) Android Secure Storage Checklist (Required)

- Do not store plaintext credentials, API keys, or refresh tokens in AsyncStorage.
- Store refresh token only in hardware-backed secure storage (Android Keystore via secure-store abstraction).
- Keep access token in memory only; short TTL (target <= 15 minutes).
- Rotate refresh token on each refresh; revoke old token server-side.
- Wipe all local auth artifacts on logout, company switch, or auth error requiring re-login.
- Prevent sensitive data in logs/crash reports (tokens, cookies, authorization headers).
- Disable screenshots on sensitive screens (auth/session/account pages) for beta builds.

## 5) Android Network Transport Checklist (Required)

- Enforce HTTPS only for authenticated/public deployments.
- Set `android:usesCleartextTraffic="false"` for production builds.
- Use a strict Android network security config (deny user-added CAs for prod unless explicitly required).
- Implement certificate pinning for production API host.
- Never send tokens in URL path/query, including WebSocket URLs.
- Set strict request timeouts/retries to avoid leaking stale auth state.
- Validate host allowlist in app config to prevent connecting to rogue endpoints.

## 6) Beta Security Exit Criteria (Go/No-Go)

Beta is blocked until all below are complete:

1. `F-01` through `F-04` fixed and verified in code review.
2. Mobile auth flow documented and implemented with short-lived access + rotating refresh strategy.
3. Query-token WebSocket auth removed.
4. Secure storage + network checklist items implemented and tested on Android release build.
5. Authentication abuse protections (rate limits + lockout telemetry) active.

## 7) Evidence Paths

- `mobile/App.tsx`
- `mobile/package.json`
- `docs/api/authentication.md`
- `server/src/auth/better-auth.ts`
- `server/src/middleware/auth.ts`
- `server/src/middleware/board-mutation-guard.ts`
- `server/src/realtime/live-events-ws.ts`
- `doc/DEPLOYMENT-MODES.md`
