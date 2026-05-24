# CrewBrief Phase 2 — Product & Engineering Roadmap

**Issue:** CRE-641
**Author:** Hunter (CTO)
**Date:** 2026-05-17
**Status:** Roadmap approved. ADR-001 superseded by ADR-002. Phase 0+2 complete.

---

## Executive Summary

Phase 1 delivered a functionally complete three-layer system (mobile app, backend API, database schema) and two production Telegram briefing scripts. All mobile/API code remains on branches — nothing merged to `master` and nothing deployed except the Telegram delivery.

**Phase 2 takes CrewBrief from branch-code to production.** It is organized into 6 sequential phases, each gating the next:

| Phase | Focus | Duration | Delivers |
|-------|-------|----------|----------|
| 0 | Foundation & Merge | 1-2 days | Code on master, migrations, Apple membership confirmed |
| 1 | Authentication | 5-8 days | JWT auth backend + mobile login flow |
| 2 | API Production Deployment | 1-2 days | `crewbrief.avva.aero` live on VPS, nginx configured |
| 3 | App Store Readiness | 5-10 days | TestFlight beta, Apple metadata, code signing |
| 4 | Monitoring & Quality | 3-5 days | Crash reporting, Sentry, fill stubbed quality gates |
| 5 | Launch & Handoff | 2-3 days | App Store submission, operator onboarding, production verification |

**Total estimated duration: 19-33 days** (parallelizable tracks within phases).

---

## Phase 0 — Foundation & Merge

**Goal:** Unblock every downstream phase by getting code onto `master` and confirming external prerequisites.

### Tasks

| # | Task | Owner | Depends On | Deliverable |
|---|------|-------|------------|-------------|
| 0.1 | Apple Developer Program membership confirmed active | Jeff | — | Membership confirmed |
| 0.2 | Merge `fix/cre-536-briefing-timeout` (or `fix/crewbrief-live-site`) into master | Engineering | — | PR merged, all CrewBrief types/schemas/routes/services on master |
| 0.3 | Verify/regenerate Drizzle migration files for 5 CrewBrief tables | Engineering | 0.2 | `packages/db/drizzle/*.sql` with `briefing_feedback`, `briefing_quality`, `briefing_negative_rating_alerts`, `crew_rating_flags`, `re_review_queue` migrations |
| 0.4 | Fix iOS deployment target mismatch (standardize on 15.1) | Engineering | 0.2 | Podfile 15.1, Info.plist 15.1 |
| 0.5 | Run full test suite + typecheck across all CrewBrief packages | Engineering | 0.2 | All 14 existing tests pass, `pnpm -r typecheck` passes |
| 0.6 | Fix `overall_score` type (text → numeric) in `briefing_quality` schema | Engineering | 0.2 | Schema fix + migration |

### Acceptance Criteria

- [ ] `git log --oneline master` includes CrewBrief commits
- [ ] `packages/crewbrief-app/`, `packages/react-native-hooks/`, CrewBrief types/validators/schema/routes/services all present on master
- [ ] Drizzle migrations apply cleanly against a fresh PostgreSQL
- [ ] `pnpm -r typecheck` passes with zero errors
- [ ] `pnpm --filter @paperclipai/server test:run` passes (14 tests)
- [ ] iOS deployment target = 15.1 everywhere
- [x] Apple Developer membership confirmed active (Jeff confirmed)

---

## Phase 1 — Authentication

**Goal:** Secure the API with JWT bearer auth and add login/register screens to the mobile app.

### Tasks

| # | Task | Owner | Depends On | Deliverable |
|---|------|-------|------------|-------------|
| 1.1 | Add `crew_auth_users` Drizzle schema + migration | Engineering | 0.2 | Migration file for new table |
| 1.2 | Implement auth routes (register, login, refresh, me, password) | Engineering | 0.2, 1.1 | `server/src/routes/crew-auth.ts` + service |
| 1.3 | Implement `requireAuth` middleware with role checking | Engineering | 0.2 | `server/src/middleware/crew-auth.ts` |
| 1.4 | Add role-based protection to all existing CrewBrief endpoints | Engineering | 1.3 | All 7 endpoints gated per protection matrix |
| 1.5 | Add rate-limiting to `/api/auth/login` (5/15min per IP/email) | Engineering | 1.2 | Rate limit middleware |
| 1.6 | Install `expo-secure-store` in crewbrief-app | Engineering | 0.2 | Dependency added |
| 1.7 | Create LoginScreen + RegisterScreen in mobile app | Engineering | 1.6 | Two new screens |
| 1.8 | Create `authenticatedFetch` wrapper with 401 → refresh → retry | Engineering | 1.6 | Shared API client module |
| 1.9 | Wire auth flow into navigation (login gate → HomeScreen) | Engineering | 1.7, 1.8 | Navigation container with auth state |
| 1.10 | Add SettingsScreen (change password, logout, app version) | Engineering | 1.7 | Settings screen |
| 1.11 | Write auth endpoint tests | Engineering | 1.2 | Vitest test suite for auth routes |
| 1.12 | Write auth integration test (register → login → access protected endpoint) | Engineering | 1.2, 1.3 | Integration test |

### Acceptance Criteria

- [ ] `POST /api/auth/register` creates user, returns JWT + refresh token
- [ ] `POST /api/auth/login` authenticates, returns JWT + refresh token
- [ ] `POST /api/auth/refresh` rotates refresh token, returns new access token
- [ ] Refresh token reuse detection invalidates both old and new tokens
- [ ] `requireAuth` middleware returns 401 for missing/invalid/expired tokens
- [ ] `requireAuth` middleware returns 403 for insufficient role
- [ ] Rate limiting blocks >5 login attempts per 15min per IP/email
- [ ] iOS app shows LoginScreen on first launch
- [ ] iOS app stores tokens in SecureStore (iOS Keychain)
- [ ] iOS app auto-refreshes expired tokens
- [ ] iOS app navigates to Home on successful login/register
- [ ] iOS app Settings screen allows password change and logout
- [ ] No existing tests broken

### Reference

See `reports/crewbrief-auth-design.md` for full design specification (auth schema, endpoints, middleware, mobile integration, migration plan).

---

## Phase 2 — API Production Deployment

**Goal:** Deploy the CrewBrief API to production with database, monitoring, and operations runbook.

> **Note:** The original plan to deploy a standalone Railway service was superseded.
> See ADR-002 (`doc/adr/crewbrief-deployment-architecture.md`) for the actual
> deployment architecture. CrewBrief runs as a co-located service within the main
> Paperclip server on the Hostinger VPS.

### Tasks

| # | Task | Owner | Depends On | Deliverable |
|---|------|-------|------------|-------------|
| 2.1 | Create `Dockerfile.crewbrief` — slim API-only image | Engineering | 0.2 | `Dockerfile.crewbrief` (for future extraction) |
| 2.2 | Add `/api/health` endpoint (DB connectivity check + uptime) | Engineering | 0.2 | Health endpoint |
| 2.3 | Configure CrewBrief env vars on VPS (`CREWBRIEF_*`) | Ops | 0.2 | Production envars |
| 2.4 | Run Drizzle migrations against production DB | Engineering | 0.2 | All CrewBrief tables created |
| 2.5 | Configure nginx virtual host for `crewbrief.avva.aero` | Ops | 0.2 | nginx config |
| 2.6 | Deploy updated Docker Compose stack to VPS | Engineering | 2.2, 2.3, 2.4 | Server restart |
| 2.7 | Verify production health | Engineering | 2.6 | `GET /api/health` → 200 |
| 2.8 | Verify CrewBrief endpoints on `crewbrief.avva.aero` | Engineering | 2.6 | Landing page, blog, API responsive |
| 2.9 | Update iOS app API URL in `app.json` / env to production | Engineering | 2.6 | Production API endpoint in app |
| 2.10 | Switch Telegram delivery scripts to production API | Engineering | 2.6 | Scripts use `crewbrief.avva.aero` |

### Acceptance Criteria

- [x] `Dockerfile.crewbrief` exists (reference only, not actively used)
- [x] `GET /api/health` returns `{ status: "ok", db: "connected", uptime: <n> }`
- [ ] CrewBrief env vars configured on VPS
- [ ] Drizzle migrations applied, all tables queryable
- [x] `crewbrief.avva.aero` resolves via DNS and serves HTTPS (nginx)
- [ ] Server responds to CrewBrief API calls
- [ ] iOS app connects to production API
- [ ] Telegram scripts deliver briefings via production API

### Reference

See `doc/adr/crewbrief-deployment-architecture.md` (ADR-002) for the actual production deployment architecture.

---

## Phase 3 — App Store Readiness

**Goal:** Configure code signing, Fastlane automation, App Store metadata, privacy documentation, and TestFlight distribution for the iOS app.

### Tasks

| # | Task | Owner | Depends On | Deliverable |
|---|------|-------|------------|-------------|
| 3.1 | Verify/complete Apple Developer Program membership | Ops/Jeff | — | Membership confirmed |
| 3.2 | Generate iOS Distribution certificate | Ops | 3.1 | Distribution cert in Apple Portal |
| 3.3 | Generate iOS Development certificate | Ops | 3.1 | Development cert in Apple Portal |
| 3.4 | Create App Store Connect API key (`.p8`) for CI/CD | Ops | 3.1 | `.p8` key file |
| 3.5 | Set `DEVELOPMENT_TEAM` in `project.pbxproj` | Engineering | 0.2 | Team ID configured |
| 3.6 | Configure Fastlane (Fastfile, Appfile, Matchfile, Deliverfile) | Engineering | 0.2 | Fastlane lanes: build, testflight, appstore, screenshots |
| 3.7 | Run `fastlane match development` + `fastlane match appstore` | Engineering | 3.2, 3.3, 3.6 | Code signing assets downloaded |
| 3.8 | Create App Store Connect record (bundle ID `com.crewbrief.app`) | Ops | 3.1 | App Store Connect app record |
| 3.9 | Populate App Store metadata (name, subtitle, description, keywords, category, age rating, support/privacy URLs) | Product | 3.8 | Full App Store listing draft |
| 3.10 | Create PrivacyInfo.xcprivacy and add to Xcode project | Engineering | 0.2 | Privacy manifest |
| 3.11 | Host Privacy Policy + Terms of Service at public URLs | Ops | — | `crewbrief.app/privacy`, `crewbrief.app/terms` |
| 3.12 | Complete App Store privacy nutrition labels | Product | 3.8 | Privacy questionnaire submitted |
| 3.13 | Take 6.5" and 5.5" iPhone screenshots (Home, Briefing, Weather, Dashboard, Feedback) | Product | 0.2 | Screenshot assets |
| 3.14 | Upload first build via Fastlane: `fastlane build_and_upload` | Engineering | 3.6, 3.7 | Build in App Store Connect |
| 3.15 | Enable TestFlight, configure internal testers (Jeff, Hunter, QA) | Engineering | 3.14 | TestFlight active |
| 3.16 | Add external testers (pilot beta group), submit for Beta App Review | Product | 3.15 | External testing via TestFlight |
| 3.17 | Verify testers can install + launch the app via TestFlight | Engineering + QA | 3.16 | Verified on physical devices |

### Acceptance Criteria

- [ ] `fastlane build` produces a valid `.ipa` archive
- [ ] `fastlane build_and_upload` uploads build to App Store Connect
- [ ] Code signing works for both Debug and Release configurations
- [ ] App Store Connect record exists with bundle ID `com.crewbrief.app`
- [ ] Privacy manifest (`PrivacyInfo.xcprivacy`) included in build
- [ ] Privacy policy at `https://crewbrief.app/privacy`
- [ ] Terms of Service at `https://crewbrief.app/terms`
- [ ] All required screenshot sizes uploaded to App Store Connect
- [ ] TestFlight build processing completes and is distributed to internal testers
- [ ] External beta group created and Beta App Review submitted
- [ ] App launches and functions correctly on physical iOS device via TestFlight

### Reference

See `doc/plans/crewbrief-apple-testflight-readiness.md` for the full 15-phase checklist (Apple Developer account → code signing → App Store Connect → metadata → build config → icons/screenshots → privacy/legal → TestFlight → capabilities → Fastlane → CI/CD → crash reporting → app review → submission → post-launch).

---

## Phase 4 — Monitoring & Quality

**Goal:** Add crash reporting, performance monitoring, and fill the stubbed quality gates for aviation-grade reliability.

### Tasks

| # | Task | Owner | Depends On | Deliverable |
|---|------|-------|------------|-------------|
| 4.1 | Integrate Sentry in mobile app (`npx sentry-wizard -i reactNative`) | Engineering | 0.2 | `@sentry/react-native` dependency, DSN configured |
| 4.2 | Integrate Sentry in Express API | Engineering | 2.11 | `@sentry/node` middleware, DSN configured |
| 4.3 | Configure source maps upload for symbolication | Engineering | 4.1 | Sentry source maps upload in Fastlane |
| 4.4 | Set up crash alerting (Slack) | Engineering | 4.1, 4.2 | Sentry Slack integration |
| 4.5 | Set up Better Stack / Grafana uptime monitoring for `api.crewbrief.app` | Ops | 2.11 | Uptime dashboard + status page |
| 4.6 | Implement stubbed quality gates D2-D4 (real-time comparison, cache staleness) | Engineering | 0.2 | Gate logic filled, not stub |
| 4.7 | Implement stubbed quality gate E2 (contextual evaluation) | Engineering | 0.2 | Gate logic filled |
| 4.8 | Replace `clarity_presentation` estimation with structured rubric | Engineering | 0.2 | Actual analysis, not average |

### Acceptance Criteria

- [ ] Sentry captures unhandled errors in both mobile app and API
- [ ] Test crash appears in Sentry dashboard
- [ ] Source maps uploaded, stack traces symbolicated
- [ ] Slack channel receives crash alerts
- [ ] Uptime dashboard shows API as healthy
- [ ] Gates D2, D3, D4 return meaningful pass/fail (not default pass)
- [ ] Gate E2 returns contextual evaluation (not default pass)
- [ ] `clarity_presentation` scored from rubric analysis (not average of other dimensions)
- [ ] All 6 quality services unit tests updated and passing

---

## Phase 5 — Launch & Handoff

**Goal:** Submit to App Store, onboard beta operators, hand off to Quinn for QA sign-off and operations.

### Tasks

| # | Task | Owner | Depends On | Deliverable |
|---|------|-------|------------|-------------|
| 5.1 | Create App Review Notes (demo API URL, trip ID, duty day ID for reviewer) | Product | 3.8 | Review notes in App Store Connect |
| 5.2 | Pre-submission acceptance test (physical device checklist) | QA | 3.16 | Signed-off acceptance test |
| 5.3 | Submit for App Store Review | Engineering | 5.1, 5.2 | App in "Waiting for Review" |
| 5.4 | Monitor review status, handle rejection (if any) | Engineering | 5.3 | App approved or rejection resolved |
| 5.5 | Release to App Store (manual release on approval) | Engineering | 5.4 | App live on App Store |
| 5.6 | Verify production App Store download + functionality | Engineering + QA | 5.5 | Confirmed on fresh device install |
| 5.7 | Execute operator beta onboarding (email invites, support channel) | Product | 5.5 | First 3-5 operators active |
| 5.8 | Document operations runbook + release checklist in repo | Engineering | All above | `doc/ops/crewbrief-runbook.md` |
| 5.9 | Handoff to Quinn for QA sign-off | Hunter | All above | Quinn QA gate cleared |

### Acceptance Criteria

- [ ] App passes App Store Review (no rejections)
- [ ] App live on App Store and downloadable
- [ ] Fresh install → register → login → view briefing → submit feedback works end-to-end
- [ ] At least 3 operators actively using the app
- [ ] Operations runbook committed to `doc/ops/crewbrief-runbook.md`
- [ ] Release checklist committed to repo
- [ ] Quinn confirms production quality gates passed

---

## Dependency Graph

```
Phase 0 (Foundation)
  ├──→ Phase 1 (Auth)
  │     └──→ Phase 2 (API Deployment)
  │           └──→ Phase 4 (Monitoring)
  └──→ Phase 3 (App Store Readiness)
        └──→ Phase 5 (Launch)
```

Phases 1 (auth) and 3 (App Store) can run in **partial parallel** after Phase 0 is complete, since auth is backend-focused and App Store readiness is primarily iOS/mobile-focused. However, Phase 2 (API deployment) gates Phase 4 (monitoring), and Phase 3 gates Phase 5 (launch).

---

## Timeline Estimate

| Phase | Best Case | Worst Case | Parallelizable |
|-------|-----------|------------|----------------|
| 0 — Foundation | 1 day | 2 days | No |
| 1 — Auth | 5 days | 8 days | Partial with Phase 3 |
| 2 — API Deployment | 1 day | 2 days | Partial (co-located in main server) |
| 3 — App Store Readiness | 5 days | 10 days | Partial with Phase 1 |
| 4 — Monitoring & Quality | 3 days | 5 days | No (depends on Phase 2) |
| 5 — Launch & Handoff | 2 days | 3 days | No (depends on Phase 3, 4) |
| **Total** | **19 days** | **33 days** | With parallelism: ~15-25 calendar days |

### Critical Path

The critical path runs through: **0 → 1 → 2 → 4 → 5** (18-23 days worst case). Phase 3 runs partially in parallel with Phase 1 but does not extend the critical path.

### Risk Factors

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Apple Developer membership not active/expired | Blocks Phase 3 entirely | Medium | Verify in Phase 0, have Jeff renew immediately |
| Drizzle migration conflicts with existing schema | Delays Phase 0 | Low | Run migration generation against clean DB first |
| PostgreSQL connection issues | Delays Phase 2 | Low | Test with local Postgres first, have Supabase fallback |
| App Store rejection (privacy, incomplete app) | Delays Phase 5 | Medium | Pre-review against guidelines in Phase 3, prepare demo account |
| Code signing certificate issues (team ID, provisioning) | Blocks Phase 3 | Medium | Set `DEVELOPMENT_TEAM` in Phase 0, Fastlane match handles rest |
| iOS deployment target conflicts with Expo SDK | Blocks Phase 3 build | Low | Standardize on 15.1 in Phase 0, verify with `expo build:ios` |

---

## Delivery Verification Gates

### Gate 1: Code on Master (Phase 0)
- PR merged, types/schema/routes/services/tests all on master
- All tests pass
- Typecheck passes
- Drizzle migrations generated

### Gate 2: Auth Working (Phase 1)
- Auth endpoints integrated in server routes
- Auth endpoints tested with Vitest
- Mobile login/register flow working in Expo dev build
- No existing tests broken

### Gate 3: API Live (Phase 2)
- `crewbrief.avva.aero` responds with health check (or future `api.crewbrief.app`)
- Database connected
- Auth flow works end-to-end against production
- nginx virtual host configured for CrewBrief domain

### Gate 4: App Store Ready (Phase 3)
- Fastlane build produces valid IPA
- TestFlight build distributed
- Privacy manifest + policy URLs live
- Screenshots + metadata uploaded

### Gate 5: Monitoring Live (Phase 4)
- Sentry ingesting errors from API + mobile
- Uptime monitoring active
- Stubbed quality gates replaced with real logic

### Gate 6: Launched (Phase 5)
- App live on App Store
- Production verification completed
- Operations runbook committed
- Quinn QA gate cleared
