# CRE-626: Technical Deep-Dive — CrewBrief App Codebase, Backend, and App Store Readiness

**Author:** Hunter — CTO  
**Date:** 2026-05-17  
**Audit Scope:** Full-stack (mobile app, backend API, database, iOS configuration, infrastructure)

---

## Executive Summary

CrewBrief is an aviation flight briefing iOS app (Expo/React Native) built within the Paperclip monorepo. The app displays METAR/TAF weather, NOTAMs, route info, and crew alerts, with a feedback system enabling crew ratings and quality scoring.

The codebase is **functionally complete** across three layers (mobile app, backend API, database schema) but has not been merged into `master`. All code resides exclusively on the `fix/crewbrief-live-site` branch. The app has never been published to the App Store and requires significant configuration and infrastructure work before submission.

---

## 1. Architecture Overview

### 1.1 Monorepo Location

```
packages/crewbrief-app/         → Expo/React Native iOS app
packages/react-native-hooks/    → Shared RN hooks & screens (consumed by app)
packages/shared/src/types/       → Briefing type definitions
packages/shared/src/validators/  → Zod validation schemas
packages/db/src/schema/          → Drizzle ORM schema (5 tables)
server/src/routes/               → API route handlers
server/src/services/             → Business logic services
server/src/__tests__/            → Vitest test suites
scripts/                         → Telegram delivery scripts (on master)
doc/crewbrief/                   → Product & ops documentation
```

### 1.2 Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile Framework | Expo SDK 52 / React Native 0.76.7 |
| Navigation | React Navigation 7 (native-stack) |
| iOS Deployment Target | 15.1 (Podfile) / 12.0 (Info.plist — discrepancy) |
| Language | TypeScript 5.7 |
| Backend Runtime | Node.js + Express |
| Database ORM | Drizzle (PostgreSQL) |
| Validation | Zod |
| Testing | Vitest + Supertest |

### 1.3 Data Flow

```
[iOS App] → HTTP API → [Express Server] → [Drizzle ORM] → [PostgreSQL]
                ↑
         [Crew rates briefing]
                ↓
   [Score Adjustment Engine] → [Re-Review Queue] / [Alert Triggers]
```

---

## 2. Mobile App Analysis

### 2.1 App Structure

**Entry Point:** `App.tsx` — NavigationContainer with 3 native-stack screens:
- `HomeScreen` — API URL config, Trip ID / Duty Day ID input
- `BriefingScreen` — Wraps `BriefingDetailScreen` from `@paperclipai/react-native-hooks`
- `DashboardScreen` — Wraps `FeedbackDashboardScreen` from `@paperclipai/react-native-hooks`

**Expo Config (`app.json`):**
- Bundle ID: `com.crewbrief.app`
- Version: `0.1.0` (build 1)
- Orientation: portrait, light mode only
- Splash BG: `#6366f1` (indigo)

### 2.2 Screens & Components

| Screen | Source | Purpose |
|--------|--------|---------|
| HomeScreen | In-app | Input form: API URL, trip/duty IDs |
| BriefingDetailScreen | react-native-hooks | Scrollable briefing with Overview, Weather, NOTAMs, Route, Alerts + Feedback FAB |
| FeedbackDashboardScreen | react-native-hooks | Feedback trends dashboard with ratings breakdown, category breakdown, recent feedback list |
| FeedbackSheet | react-native-hooks | Modal: rate (yes/somewhat/no), select category, optional free text |

### 2.3 UI/UX Observations

| Area | Finding | Severity |
|------|---------|----------|
| Loading states | Full-screen spinner, no skeleton | LOW |
| Error states | Retry button only, no pull-to-refresh on error | LOW |
| Input validation | Minimal on home screen | LOW |
| Dark mode | Light-only (`userInterfaceStyle: "light"`) | LOW |
| iPad support | Supported via `supportsTablet: true`, no multitasking optimization | LOW |
| FAB placement | Overlaps long content on small iPhones | LOW |
| Haptic feedback | None on feedback submission | LOW |

### 2.4 API Integration

- **Unauthenticated.** The `useBriefingFeedback` hook sends `userId: "anonymous"` for feedback. The README explicitly calls out this gap.
- API calls use raw `fetch()` (no Axios/React Query/tanstack).
- No retry logic beyond user-triggered "Retry" button.
- No offline caching or persistence.

### 2.5 Known Limitations (per README)

1. No authentication
2. Demo trip IDs (placeholders)
3. No offline support
4. No push notifications
5. No background fetch
6. iOS-only (Android not tested)
7. No custom fonts (system defaults)

---

## 3. Backend API Analysis

### 3.1 Route Structure

| Endpoint | Method | Handler | Purpose |
|----------|--------|---------|---------|
| `/api/feedback/briefing` | POST | `briefingFeedbackService.submit` | Submit crew feedback + score adjustment |
| `/api/feedback/briefing` | GET | `briefingFeedbackService.listByBriefing` | List feedback for a briefing |
| `/api/feedback/briefing/trends` | GET | `briefingFeedbackService.getTrends` | Aggregate feedback trends |
| `/api/quality/classify` | POST | `briefingQualityService.classifyAndStore` | Classify & store briefing quality |
| `/api/quality/:briefingId` | GET | `briefingQualityService.getByBriefingId` | Get quality classification |
| `/api/quality/summary/all` | GET | `briefingQualityService.getSummary` | Quality dashboard summary |
| `/api/briefings/:tripId/:dutyDayId` | GET | *(assumed existing)* | Fetch briefing data |

### 3.2 Business Logic Quality

**Briefing Quality Classification System** is notably well-architected:
- 13 quality gates across 5 dimensions (accuracy, completeness, timeliness, clarity_presentation, operational_usefulness)
- Each gate is independently evaluated (e.g., `evaluateGateA1` checks flight/date/route fields)
- Dimension scoring: `gates_passed / total_gates * 5.0`
- 4 quality labels: `premium`, `standard`, `degraded`, `failed`
- Score adjustment engine handles crew rating feedback with tier boundaries
- Re-review queue auto-creates items when quality drops
- Negative rating alerting at threshold of 3 "no"/"somewhat" ratings
- Crew rating flags for user-level tracking

**Observations:**
- 4 gates (D2, D3, D4, E2) are **stubbed** — always return `{ passed: true }` with a "default pass" note. These require real-time comparison, cache metadata, and contextual evaluation that is not yet implemented.
- `clarity_presentation` dimension is **estimated** as the average of other dimensions. Actual NLP analysis is deferred.
- `overallScore` stored as `text` in DB (not numeric) — minor type mismatch.

### 3.3 Test Coverage

| Test File | Tests | Quality |
|-----------|-------|---------|
| `briefing-quality-service.test.ts` | 7 tests | Good — covers classify, label assignment, placeholder detection, upsert |
| `briefing-feedback-routes.test.ts` | 7 tests | Good — covers submission (all fields + required-only), validation rejection, listing, empty state |

---

## 4. Database Schema

### 4.1 Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `briefing_feedback` | Crew feedback records | briefing_id, user_id, rating, category, free_text |
| `briefing_quality` | Quality classification results | briefing_id (unique), overall_score, label, dimension_scores (jsonb), gate_results (jsonb) |
| `briefing_negative_rating_alerts` | Alert tracking for negative feedback | briefing_id (unique), negative_count, alerted_at |
| `crew_rating_flags` | User-level rating flagging | user_id, rating_type, count, window_start |
| `re_review_queue` | Queue for manual re-review | briefing_id, user_id, rating, trigger_reason, status, due_at |

### 4.2 Observations

- Schema is clean, uses proper indexes on foreign keys and queried columns
- `briefing_quality.overall_score` is `text` not `numeric` — the `briefingQualityService` parses it with `parseFloat`
- The `scoreAdjustmentEngine` references `qualityScoreAdjustments` table which does NOT appear in the schema files examined — possibly undeclared or in a different schema file
- No row-level security policies configured (consistent with unauthenticated access model)

---

## 5. iOS / App Store Readiness

### 5.1 What Exists

| Artifact | Status | Notes |
|----------|--------|-------|
| Xcode project (`project.pbxproj`) | ✅ Complete | Bundle ID configured, schemes defined |
| Info.plist | ✅ Complete | Version 0.1.0, build 1, iOS 12.0+ |
| Entitlements | ✅ Present | Currently empty (no capabilities enabled) |
| App icon assets | ✅ Present | 1024x1024 + standard sizes |
| Splash screen | ✅ Present | Storyboard + colorset |
| Swift bridging header | ✅ Present | Required by Expo |
| Podfile | ✅ Complete | iOS 15.1 target, Expo/RN deps |

### 5.2 What's Missing for App Store Submission

| Requirement | Status | Action Needed |
|-------------|--------|---------------|
| **Fastlane configuration** | ❌ Missing | No Fastfile, Appfile, Matchfile, Deliverfile |
| **App Store Connect API key** | ❌ Missing | Needed for automated metadata/screenshot upload |
| **Code signing team** | ❌ Not set | `DEVELOPMENT_TEAM` not configured in pbxproj |
| **Distribution certificate** | ❌ Not in repo | Must be managed via Apple Developer Portal + Match |
| **Provisioning profile** | ❌ Not in repo | Needs distribution profile via Match/manual |
| **App Store screenshots** | ❌ Missing | 6.5" and 5.5" required for all app versions |
| **App preview video** | ❌ Missing | Optional but recommended |
| **Privacy manifest** | ❌ Missing | Required for API usage descriptions |
| **Export compliance** | ❌ Not documented | Encryption questionnaire for App Store |
| **TestFlight configuration** | ❌ Not set up | Internal/external testing groups |
| **App metadata** | ❌ Not prepared | Description, keywords, support URL, marketing URL |
| **Content privacy labels** | ❌ Not documented | For App Store privacy details |
| **Crash reporting / analytics** | ❌ Not configured | No Crashlytics or Sentry |
| **Push notification entitlements** | ❌ Missing | Would be needed for new-briefing alerts |
| **iPad optimization** | ❌ Not done | Split-view/multitasking not optimized |

### 5.3 Discrepancies

- **iOS Deployment Target mismatch:** Podfile says `15.1`, Info.plist says `12.0` — these should align (15.1 is the practical minimum for Expo SDK 52)
- **No code signing team** — Xcode project has no `DEVELOPMENT_TEAM` setting, which will cause build failures on any device or archive attempt

---

## 6. Delivery Infrastructure

### 6.1 On Master: Telegram Scripts

Two scripts exist on `master` that are currently in use:

| Script | Purpose |
|--------|---------|
| `scripts/send-briefing.sh` | Basic Markdown-format Telegram delivery |
| `scripts/send-briefing-telegram.sh` | Enhanced HTML-format delivery with 4096-char splitting, HTML escaping, issue ID linkification, content validation (section numbering), and Paperclip issue-fallback |

### 6.2 Bleeding Edge Branch (`fix/cre-536-briefing-timeout`)

An additional branch `fix/cre-536-briefing-timeout` contains:
- Timeout handling for brief fetch/curl calls
- Additional docs/changelog commits
- Duplicate of the domain migration fix

---

## 7. Branch Maturity & Merge Status

### 7.1 Commit Graph

```
master ─── ... ─── c445e592 ─── ...
                        \
fix/crewbrief-live-site   └── f377a667 (Merge v2026.512.0) ─── 56acfef7 (domain fix)
```

### 7.2 Branch Delta

The `fix/crewbrief-live-site` branch is **2 commits ahead of its merge base with master**:
1. `f377a667` — Merge v2026.512.0 release (contains ALL CrewBrief code + other release changes)
2. `56acfef7` — fix email/domain migration

### 7.3 Risk Assessment

| Factor | Assessment |
|--------|-----------|
| Merge conflicts with master | Low — no other code touches CrewBrief paths |
| Divergence from master | Medium — `f377a667` is a large merge commit containing the entire release |
| DB migration compatibility | Unknown — no formal migration files found in the Drizzle migrations directory |
| Test suite on master | Code not present on master to test |

---

## 8. Issues & Recommendations

### Blockers

| # | Issue | Severity | Recommendation |
|---|-------|----------|----------------|
| 1 | Code only on feature branch, not master | CRITICAL | Merge `fix/crewbrief-live-site` into master after verification or rebase |
| 2 | No authentication | HIGH | Integrate with Paperclip auth or implement simple token-based API auth |
| 3 | No App Store publishing infra | HIGH | Set up fastlane, code signing, TestFlight |
| 4 | No push notifications | MEDIUM | Implement APNs via Expo push plugin or native module |
| 5 | Stubbed quality gates (D2-D4, E2) | MEDIUM | Implement real-time comparison and cache staleness checks |
| 6 | `clarity_presentation` estimated from other dimensions | LOW | Replace with actual NLP analysis or structured clarity rubric |
| 7 | iOS deployment target mismatch (12.0 vs 15.1) | LOW | Align on 15.1 minimum |

### Recommendations

1. **Merge to master** — The codebase is too substantial to remain on a branch. Create a PR from `fix/crewbrief-live-site` to master with appropriate testing.
2. **Run DB migrations** — Ensure Drizzle migration files exist for the 5 new tables and can be applied cleanly.
3. **Code signing** — Set `DEVELOPMENT_TEAM` in pbxproj, configure fastlane match for certificate management.
4. **App Store prep** — Create fastlane lane for beta/Release builds, generate screenshots, prepare metadata.
5. **Auth integration** — At minimum for MVP: token-based auth tied to Paperclip's existing auth system.
6. **Monitoring** — Add crash reporting (Sentry/Crashlytics) before any user-facing deployment.

---

## 9. Current Production State

- `scripts/send-briefing.sh` and `scripts/send-briefing-telegram.sh` are on `master` and actively used for delivering daily briefings via Telegram to Jeff.
- The mobile app has never been deployed to any device beyond local dev builds.
- `api.crewbrief.app` domain is registered and referenced in code but there is no evidence of a production deployment.

---

## 10. Appendix: File Inventory

### Mobile App (`packages/crewbrief-app/`)
- `App.tsx`, `app.json`, `package.json`, `tsconfig.json`, `babel.config.js`, `metro.config.js`, `.gitignore`
- `src/screens/HomeScreen.tsx`, `BriefingScreen.tsx`, `DashboardScreen.tsx`
- `assets/` (icon, splash, adaptive-icon, favicon)
- `ios/` (full Xcode project: pbxproj, Info.plist, entitlements, AppDelegate, Podfile, assets)

### React Native Hooks (`packages/react-native-hooks/`)
- `src/index.ts`, `src/useBriefingDetail.ts`, `src/useBriefingFeedback.ts`, `src/useFeedbackTrends.ts`
- `src/screens/BriefingDetailScreen.tsx`, `FeedbackDashboardScreen.tsx`, `FeedbackSheet.tsx`

### Backend (`server/src/`)
- `routes/briefing-feedback.ts`, `routes/briefing-quality.ts`
- `services/briefing-feedback.ts`, `services/briefing-quality.ts`, `services/briefing-feedback-alerts.ts`, `services/score-adjustment-engine.ts`, `services/re-review-queue.ts`, `services/crew-rating-flags.ts`
- `__tests__/briefing-feedback-routes.test.ts`, `__tests__/briefing-quality-service.test.ts`

### Shared (`packages/shared/src/`)
- `types/briefing.ts`, `types/briefing-feedback.ts`, `types/briefing-quality.ts`
- `validators/briefing-feedback.ts`, `validators/briefing-quality.ts`

### Database (`packages/db/src/schema/`)
- `briefing_feedback.ts`, `briefing_quality.ts`, `briefing_negative_rating_alerts.ts`, `crew_rating_flags.ts`, `re_review_queue.ts`

### Scripts (on `master`)
- `scripts/send-briefing.sh`, `scripts/send-briefing-telegram.sh`

### Documentation (`doc/crewbrief/`)
- 12 files: landing copy, onboarding guides, beta flow, help center, support escalation, waitlist mechanics, operator recruitment, HubSpot setup, PostHog tracking, 3 blog posts
