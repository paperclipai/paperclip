# Staff Engineer Structural Audit — voy-1420-posthog-p2-fixes

**Reviewer**: Staff Engineer (eee825c7)
**Date**: 2026-08-19 ~08:50 UTC
**Branch**: voy-1420-posthog-p2-fixes
**Diff base**: fork/master
**Test status**: 43/43 pass (auth-routes, better-auth, express5-wildcard, posthog, Auth.test.tsx)

---

## Previous findings re-verification

| Finding | Severity | Status | Detail |
|---------|----------|--------|--------|
| F1: `{ prepare: false }` undocumented | P2 | ✅ CTO-accepted | No code comment added, but CTO explicitly accepted for Voyonder's embedded-PG deployment |
| F2: `resolveLoginMethod` URL parsing | Low | ✅ FIXED (96faa1343) | `new URL()` constructor with base + try/catch |
| F3: `await captureMetric` in hooks | Medium | ✅ FIXED (96faa1343) | `captureMetric` returns `void` — no `await` |

---

## Structural analysis

### A1. Auth lifecycle hooks ✅
- `user.create.after` and `session.create.after` are fire-and-forget, try/catch-wrapped
- `resolveLoginMethod` uses `new URL().pathname` for safe path matching (confirmed: base URL `"http://localhost"` is ignored for absolute URLs, used only for relative ones)
- Events use per-actor distinct IDs (`user.id`/`session.userId`) with `login_method` property (google vs email)
- `captureMetric` is synchronous (`void` return in posthog.ts:135) — hooks return immediately; better-auth does not wait for PostHog network I/O

### A2. Google OAuth gating ✅
- Social provider only activated when BOTH `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set
- Warns on partial config → prevents silent misconfiguration
- Falls back to email-only auth when env vars absent — zero regression risk

### A3. Express 5 routing ✅
- `app.all("/api/auth/{*authPath}")` uses correct Express 5 wildcard syntax
- Wildcard test (`express5-auth-wildcard.test.ts`) verifies matching for deep auth sub-paths
- UI calls `/api/auth/sign-in/social` which correctly routes to better-auth handler (no custom route intercepts it)

### A4. `signInWithGoogle` API client ✅
- Uses `extractAuthError` for structured error parsing from better-auth responses
- Error surfaced in UI alert region via `setError` (tested: "surfaces a Google OAuth failure in the alert region")
- Calls better-auth's standard `/api/auth/sign-in/social` endpoint

### A5. Test coverage ✅
- **Server (38 tests)**: better-auth cookie scoping, auth routes (profile CRUD), express5 wildcard, PostHog enable/config/capture/flush/shutdown
- **UI (5 tests)**: Google button render, redirect on success with `window.location.assign`, error surfacing in alert region
- `act()` warnings in UI tests are cosmetic (common React testing.jsdom pattern)

---

## Non-blocking observations

**C1 (carried forward P2):** `packages/db/src/client.ts:50` — `postgres(url, { prepare: false })` has no code comment explaining the deployment topology that requires it. The CTO has accepted this risk. Recommendation for future maintainers: add `// PgBouncer/transaction-pooler compatibility: disable prepared statement caching`.

**C2 (new P3):** `resolveLoginMethod(ctx)` is called outside the `try/catch` in both hooks. The function has internal error handling and never throws, but this is a minor encapsulation concern for future refactors.

---

## Verdict: APPROVED

The branch is structurally sound for shipping. All code changes are safe:

- **No N+1 queries or missing indexes** — hooks are fire-and-forget telemetry, no DB reads
- **No stale reads or race conditions** — `resolveLoginMethod` reads request URL snapshot from better-auth context; hooks don't mutate auth state
- **Proper trust boundaries** — Google OAuth is server-side env-var gated; URL pathname matching vs raw string scan
- **SQL safety maintained** — parameterized queries, correct column aliases (`AS "score"`)
- **PostHog telemetry cannot block auth** — fire-and-forget, try/catch-wrapped, synchronous `captureMetric`
- **Google OAuth activatable via env vars** — no code changes needed when vars are set on vps-1

### Routing

This audit has been committed to the branch as a status document. CTO has final go/no-go for shipping. Release Engineer (7a2a259f) can merge to fork/master upon CTO approval.

### Remaining

- [x] Code review (Staff Engineer) — structural audit complete, APPROVED
- [ ] CTO go/no-go for shipping
- [ ] Release Engineer: merge voy-1420-posthog-p2-fixes → fork/master
- [ ] Notify Support Engineer after merge
