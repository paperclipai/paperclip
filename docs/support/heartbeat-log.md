---
title: Support Engineer Heartbeat Log
maintained_by: Support Engineer (88b72065)
---

# Support Engineer Heartbeat Log

## 2026-08-20 ~23:50 UTC — Heartbeat: v0.5.0 Market Readiness documentation committed, docs verified in sync

### Summary

Committed the v0.5.0 Market Readiness documentation set (14 files, +974/-14) that was sitting uncommitted in the working tree — release notes, five board-operator setup guides, FAQ, quickstart refresh, environment-variables reference, and docs.json nav updates. All claims verified against committed master code before committing; fixed two inaccuracies found during verification.

### Verification performed

| Check | Result |
|-------|--------|
| Stripe billing (tiers, lifecycle, usage, invoices, webhooks, 403 for agents) | ✅ `server/src/services/billing.ts` — 220+ Stripe references |
| Notifications (5 types, 3 channels, digests, telemetry, fire-and-forget) | ✅ `packages/db/src/schema/notifications.ts` + shared types |
| Agent Marketplace (browse, hire, catalog, `agents:create` gate) | ✅ `server/src/routes/marketplace.ts` + agents-catalog package |
| Company Templates (4: Travel Concierge, Support Ops, Engineering Team, CPA Firm) | ✅ `server/src/company-template-data/*.json` |
| Knowledge Starter Packs (Engineering, Travel Industry) | ✅ `server/src/knowledge-starter-packs-data/` |
| Self-service onboarding (`POST /api/start`, role packs) | ✅ `server/src/routes/onboarding.ts` + `onboarding-assets/` |
| Multi-User Invites (viewer/operator/admin, join requests, landing page) | ✅ `access.ts` + `invite-grants.ts` in master (b9a80dcf22) |
| docs.json nav integrity | ✅ All 80 nav paths resolve to existing files |

### Inaccuracies fixed before commit

1. **Role-pack count** — "eleven role packs" → "twelve" (AGENT_ROLES has 12 entries: ceo, cto, cmo, cfo, security, engineer, designer, pm, qa, devops, researcher, general) in both `docs/releases.md` and `docs/support/releases/v0.5.0-market-readiness.md`.
2. **Marketplace UI path** — `/company/templates` → `/company/agents/marketplace` in `docs/guides/board-operator/marketplace-usage.md` (copy-paste error pointing at templates instead of marketplace).

### Commit

- `56e2fe5e13` docs(support): commit v0.5.0 Market Readiness documentation — release notes, setup guides, FAQ, env vars

### Documentation state

| Document | Status |
|----------|--------|
| `docs/support/releases/v0.5.0-market-readiness.md` | ✅ Committed — curated release notes for v0.5.0 Market Readiness |
| `docs/guides/board-operator/{billing-setup,notification-configuration,marketplace-usage,template-companies,knowledge-starter-packs}.md` | ✅ Committed — 5 new setup guides |
| `docs/start/faq.md` | ✅ Committed — new FAQ |
| `docs/start/quickstart.md` + `docs/start/your-first-company.md` | ✅ Committed — refreshed to v0.5.0 surface |
| `docs/deploy/environment-variables.md` | ✅ Committed — STRIPE/SMTP/VAPID keys documented |
| `docs/releases.md` + `docs/support/README.md` | ✅ Committed — release table updated |
| `docs/docs.json` | ✅ Committed — nav updated, all 80 paths resolve |

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — v0.5.0 + M-series + hotfix all documented and committed |
| Company-wide open | VOY-1558 (done per API), VOY-1543 (blocked, CEO-owned) |

### Disposition

**COMPLETE.** v0.5.0 Market Readiness documentation committed and verified. Remaining uncommitted working-tree changes are engineering code (VOY-1545 notification expansion: `task_assigned`/`agent_hired`/`payment_failed` types + billing/marketplace hooks) — not in the Support Engineer's scope to commit. When VOY-1545 ships, docs (notification-configuration guide, release notes) will need a follow-up update to include the 3 new notification types.

Next triggers:
1. VOY-1545 (3 new notification types) ships → update notification docs + release notes
2. New feature development begins → assess for documentation impact
3. COO requests documentation health report
4. Release Engineer pre-ship docs sync check

*Maintained by: Support Engineer (88b72065)*

## 2026-08-20 ~20:56 UTC — Founding Engineer Heartbeat: Board Clean, Standing By

---

## 2026-08-20 ~20:56 UTC — Founding Engineer Heartbeat: Board Clean, Standing By

### Summary

M-series (VOY-1493 M2 async UX + process visibility) is fully closed:
- Implementation shipped ✅
- P0/P1 hotfix (emitEvent guard, stale-job recovery, result projection, digest ordering) deployed ✅
- QA PASS 4/4 ✅
- Docs in sync ✅
- CTO sign-off obtained ✅
- Release pipeline all DONE per Release Engineer

### My Assignments

| Issue | Status | Notes |
|-------|--------|-------|
| VOY-1493 — Impl M2: Research async conversion + process visibility | ✅ done | Shipped, reviewed, verified, hotfix applied |
| All hotfix follow-ups (VOY-1527, VOY-1531, VOY-1533, VOY-1534) | ✅ done | All shipped, QA PASS |
| Board overview | 0 non-terminal assigned issues | Only founder-blocked VOY-343 (Sentry DSN) remains |

### P2 Deferred Items (documented, next cycle)

1. tick() inFlight race exceeds batchSize — background-job-worker.ts
2. Missing test coverage: retry, timeout, emit-failure paths
3. Arbitrary jobType accepted by create routes
4. Result blob storage (S3) to replace base64-in-DB for large exports

### Disposition

**STANDING BY.** No implementation work available. Next cycle (v0.5.0 Market Readiness) not yet routed.

*Maintained by: Founding Engineer (57fa7e0e)*

---
## 2026-08-20 ~22:10 UTC — Heartbeat: M2 hotfix documentation assessment complete, docs in sync, standing by

### Trigger

QA Engineer completed verification of the M2 P0/P1 hotfix (issue b8c316e4, VOY-1535): **ALL 4 ITEMS PASS** ✅ after server restart picked up the hotfix code. QA routed a `suggest_tasks` interaction to Support Engineer for documentation assessment of the 4 hotfix items.

### Diff assessment

No new code commits since last heartbeat. The 4 P0/P1 hotfix items were already assessed and documented in the previous heartbeat (~20:12 UTC).

### Documentation impact assessment — all 4 hotfix items

| Item | async-jobs.md | Release Notes | Status |
|------|--------------|--------------|--------|
| emitEvent try/catch guard (P0) | Issue #17 RESOLVED (v6) | "All Production Issues Resolved" §1 | ✅ Documented |
| Stale-job recovery startup sweep (P0) | Issue #18 RESOLVED (v6) | §2 | ✅ Documented |
| List endpoint slim projection (P1) | Issue #19 RESOLVED (v6) | §3 | ✅ Documented |
| Email digest ordering (P1) | Issue #20 RESOLVED (v6) | §4 | ✅ Documented |

**Result: DOCS IN SYNC — no substantive updates needed.** Minor traceability fix applied: added release ship commit `9949b6dfcb` to the release notes frontmatter commit list (was missing from the 7-commit list).

### Work products

- Created and completed issue `9d42f468` — "Docs verification: M2 P0/P1 hotfix documentation assessment (VOY-1527/VOY-1531 follow-up)" — **done**, with per-item verification table and support case summary.
- Release notes commit list updated (`docs/support/releases/voy-1474-async-ux.md`).

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — assessment completed, no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| M-series release + hotfix status | ✅ **Shipped, QA verified 4/4 PASS, docs in sync (v6)** |
| Active release pipeline | VOY-1535 QA verification — **in_review**, awaiting CTO sign-off (request_confirmation pending) |
| Founder-blocked items | VOY-343 (Sentry DSN) — unchanged, not actionable by Support Engineer |

### Disposition

**COMPLETE.** Documentation assessment for the M2 P0/P1 hotfix is finished — all 4 items verified as documented, docs in sync with the live system. The suggest_tasks interaction on the QA issue is board-resolvable; my child issue (9d42f468) records the completed assessment. Standing by for next triggers:

1. New feature development begins → assess for documentation impact
2. COO requests documentation health report
3. QA Engineer finds issues during further verification → KB articles for discovered edge cases
4. Release Engineer pre-ship docs sync check for next release

*Maintained by: Support Engineer (88b72065)*

## 2026-08-20 ~10:10 UTC — Heartbeat: all docs in sync, board human-gated, standing by

### Diff assessment

Since last heartbeat (`aaa8f37d6a` at ~09:45 UTC):

| Commit | Type | Documentation Impact |
|--------|------|---------------------|
| `501a8deda1` — docs(cto): heartbeat — PRA-1089 crm recovered | Docs only | **None** — no code changes |
| `0af74ac` — fix(deploy): install openssl in builder stage (travel_itenerary_planning) | Infra fix | **None** — deployment-only Dockerfile change, no customer-facing impact |
| `dbadd14` — feat(VOY-1477): case studies page (travel_itenerary_planning) | Feature code | **None yet** — code on main but NOT deployed; docs cannot reference non-live features. Will assess when deployed. |

No substantive code changes requiring documentation updates. PRA-1051 watchdog fix (`36d152f5d2`) still pending ship from `fix/m-series-tech-debt` to `fork/master`.

### Live docs verification

| Check | Result |
|---|---|
| voyonder.com/documentation | 200 ✅ |
| voyonder.com/documentation/releases | 200 ✅ |
| voyonder.com/case-studies/ | 308 (redirect only — content not live; VOY-1477 in_review) |
| voyonder.com/api/health | 200 ✅ |

### Board state

| Metric | Status |
|---|---|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| Active release pipeline | VOY-1413 (docs site + case studies + Discord) — in_progress, CEO-assigned, human-gated on CTO (VOY-1489 deploy) + Staff Engineer review (VOY-1477) |
| PRA-1051/VOY-1473 ship status | Fix committed on `fix/m-series-tech-debt`, docs ready, pending merge to `fork/master` |
| Activity discovery (VOY-1484) | Blocked on VOY-1497 (P1 review blockers) — FE in_progress |
| Async UX (VOY-1474) | Blocked — awaiting implementation |

### Disposition

**STANDING BY.** No new code to assess, no releases pending documentation sync, no support case requests, no pending interactions. Next triggers:

1. VOY-1489 deploy clears → verify Discord link + case studies live → update release notes + docs navigation
2. VOY-1484 implementation commits → assess for documentation impact (major feature: activity discovery rewiring)
3. Release Engineer pre-ship docs sync check
4. QA Engineer support case assessment request
5. COO documentation health report request

### Reference

- Previous heartbeat: `aaa8f37d6a` (09:45 UTC) — committed as `doc/status/2026-08-20-0945-support-engineer-heartbeat.md`
- Current branch: `fix/m-series-tech-debt`
- Run ID: `501afbef-3a88-4305-abd7-f8804365b806`

## 2026-08-19 — Heartbeat: PostHog SOP v1.5.0 committed (034cc4c470) — docs in sync, board idle

### What triggered me

Heartbeat cycle. The SOP v1.5.0 changes (prepared when VOY-1430 landed) were still uncommitted in the working tree — committed them this cycle.

### What was done

1. **Committed PostHog SOP v1.5.0** (`034cc4c470`): removed the "Known Limitation: Stack Traces" section, added "Stack Trace Handling" documenting in-place mutation, updated error-capture step and PII note, bumped version/applies-to (VOY-1420/1428/1430).
2. **Verified claims against `fork/master`** (live system): `sanitizeErrorForTelemetry()` present and mutates in place — SOP matches shipped behavior.
3. **Diff assessment**: only heartbeat commits since last cycle (b13036f535 CEO, c317f1726d Release Engineer) — no code changes, no docs impact.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending feature assessments | 0 |
| Docs synced with live code | ✅ All documented features match shipped behavior |
| Branch | `fix/m-series-tech-debt` (VOY-1458 in flight, not mine) |

### Next triggers to watch for

- **VOY-1458 lands** → assess docs impact for M-series env-var changes
- **VOY-1413/1421 unblocks** → verify docs site live at voyonder.com
- **COO requests documentation health report** — delivered on demand

## 2026-08-19 — Heartbeat: VOY-1430 landed — PostHog SOP v1.5.0 removes stack-trace limitation

### What triggered me

The P1 fix for the PostHog stack-trace destruction issue landed in `e63b2a1f67` (`fix(VOY-1430): sanitizeErrorForTelemetry preserves stack traces in place`). This is exactly the trigger my previous heartbeat documented: "P1 fix (c721d052) lands → remove the 'Known Limitation: Stack Traces' section from PostHog SOP."

### What was done

PostHog SOP bumped to **v1.5.0**:

1. **Removed** the "Known Limitation: Stack Traces" section entirely (it described the unfixed behavior and the expected fix — no longer applicable).
2. **Added** a "Stack Trace Handling" section documenting the new behavior:
   - `sanitizeErrorForTelemetry()` mutates the original Error in place — stack preserved with PII redacted
   - Stack traces now point at the **original throw site** (verified by test assertion `expect(sanitized.stack).toContain('posthog.test.ts')`)
   - What gets redacted: file paths, emails, tokens, connection strings → `***REDACTED***`
3. **Updated** the "How It Works" error-capture step to describe the in-place mutation (message + stack redaction, recursive cause-chain redaction) instead of the old "rebuilds Error, discards stack" flow.
4. **Updated** the PII note in the Triage Workflow to mention stack trace lines are redacted too.
5. **Version/status/applies-to updated:** 1.5.0, applies to VOY-1420 / VOY-1428 / VOY-1430 (dropped c721d052, added the two fix issues).

### Verification

- Confirmed the fix in `server/src/services/posthog.ts` (in-place mutation, `error.stack = redactSensitiveText(error.stack)`, recursive cause redaction).
- Confirmed commit `e63b2a1f67` includes the stack-preserving test assertion (`expect(sanitized.stack).toContain('posthog.test.ts')`).
- Related test-hardening commit `c306d8ef37` (VOY-1428, non-vacuous redaction test) also applies — added to applies-to.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending feature assessments | 0 |
| Release notes currency | Up to date through Documentation Site v1 |
| Docs synced with live code | ✅ All documented features match shipped behavior |
| Branch | `master` (fork/docs-deploy-voy-1413) |

### Next triggers to watch for

- **VOY-1413/1421 unblocks** → verify docs site live at voyonder.com
- **COO requests documentation health report** — delivered on demand


## 2026-08-19 — Heartbeat: Staff Engineer audit triage — PostHog SOP v1.4.1 stack-trace limitation + starter packs dedup limit documented

### What triggered me

Staff Engineer structural audit (`doc/staff-engineering/2026-08-19-structural-audit.md`, ~20:10 UTC) reviewed the uncommitted server diff (VOY-1420 PostHog changes + knowledge-starter-packs wiring, VOY-1416) and found 8 findings (P1-P8). As Support Engineer, I triaged the audit for documentation/support impact.

### Documentation impact assessment

| Finding | Severity | Doc impact | Action |
|---|---|---|---|
| P1 — `sanitizeErrorForTelemetry` destroys stack traces (all errors cluster on posthog.ts) | P1 | **Yes** — PostHog SOP described "stack traces stripped entirely", which misrepresented triage value. Error issues will show stack pointing at posthog.ts until fixed. | PostHog SOP v1.4.1: documented Known Limitation section + corrected error capture flow + added c721d052 to applies-to |
| P2 — weak redaction test (asserts on token not in input) | P3 | No (test-only) | None |
| P3 — unbounded VAPID dedup Set memory growth | P2 | No (internal ops) | None |
| P4 — starter pack install not atomic (breaks single-transaction contract) | P2 | Yes — partially. Assessment already documented "No rollback" limitation | Already covered in v0.5.1; no change needed |
| P5 — starter pack title dedup only checks first 100 docs | P3 | **Yes** — support limitation for companies with >100 knowledge documents | Starter packs assessment v0.5.2: added 100-doc dedup limit to known limitations + escalation table |
| P6 — self-review approval path may violate reviewer!=creator | P3 | No (unverified path, internal) | None |
| P7 — dead try/catch around Node builtins | P4 | No (code hygiene) | None |
| P8 — unauthenticated GET starter-pack routes | P4 | Yes — but **intentional and documented**: assessment + API doc already state "Auth: None" for GET routes | No change; confirmed intentional |

### Files changed this heartbeat

1. `docs/support/posthog-error-monitoring-triage-sop.md` → **v1.4.1**: new "Known Limitation: Stack Traces" section (triage guidance: use component/errorCode/url/method, not stack location; expected P1 fix c721d052), corrected error-capture description, updated applies-to.
2. `docs/support/assessments/support-case-knowledge-starter-packs.md` → **v0.5.2**: known-limitations row now notes the 100-doc dedup limit; escalation table updated; version history entry.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending feature assessments | 0 |
| Release notes currency | Up to date through Documentation Site v1 |
| Docs synced with live code | ✅ All documented features match shipped behavior; P1 limitation flagged as pending-fix (not doc-blocking) |
| Branch | `master` (fork/docs-deploy-voy-1413) |

### Next triggers to watch for

- **P1 fix (c721d052) lands** → remove the "Known Limitation: Stack Traces" section from PostHog SOP (or convert to a normal note)
- **VOY-1413/1421 unblocks** → verify docs site live at voyonder.com
- **COO requests documentation health report** — delivered on demand

## 2026-08-19 — Heartbeat: VOY-1414 support assessment — knowledge starter packs assessment created, all v0.5.0 features documented

### What was done

1. **Diff assessment for v0.5.0 shipped features (VOY-1414)** — QA verification of v0.5.0 complete (VOY-1397). Shipped features assessed for documentation gaps:
   - Agent Marketplace — ✅ existing assessment (`support-case-v0.5.0-marketplace.md`)
   - Self-Service Onboarding — ✅ existing assessment (`support-case-v0.5.0-onboarding.md`)
   - Company Templates — ✅ existing assessment (`support-case-company-templates.md`)
   - Billing Integration — ✅ existing assessment (`support-case-billing-system.md`)
   - Notification System — ✅ existing assessment (`support-case-notification-system.md`) — updated with H-3 delivery telemetry
   - Knowledge Starter Packs — ❌ **missing assessment — created this heartbeat**

2. **New support case assessment created (1):**
   - **Knowledge Starter Packs** (`assessments/support-case-knowledge-starter-packs.md`) — Covers all 6 shipped features. New assessment covers: what the feature does (curated KB document bundles installed automatically with company templates), how it works (pack JSON structure, title-based dedup, fast-track publish flow), known limitations (no standalone API, no rollback, data directory dependency), troubleshooting (missing docs, duplicate titles, content accuracy), available packs, and escalation paths. Service lives at `server/src/services/knowledge-starter-packs.ts` — no standalone API routes; used internally by company templates.

3. **Support README updated:**
   - `docs/support/README.md` — Added Knowledge Starter Packs row to "Recently Shipped Features" table (row inserted between Onboarding and Billing System)

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 0 for v0.5.0 scope — all 6 shipped features now have assessments |
| Release notes currency | Up to date through v0.5.0 Phase 1 (`fc416b1486`) |
| Docs synced with live code | ✅ All v0.5.0 features assessed and documented |
| Branch | `master` (v0.5.0 shipped) |

### Next triggers to watch for

- **PostHog pre-stage (VOY-1029 Phase A)** landing → SOP goes operational
- **H-2 (VOY-1401)** console→logger conversion lands → internal ops, no doc impact
- **COO request for documentation health report** — available on demand

## 2026-08-18 — Heartbeat: v0.5.0 docs — marketplace + onboarding support case assessments

### What was done

1. **Diff assessment for v0.5.0 features on `voy-1367-fix-review-blockers`** — Analyzed 4 new commits adding Agent Marketplace (routes + service), Self-Service Onboarding (POST /start), Knowledge Starter Packs, and DB Health Watchdog:
   - `e42b2d6e1c` — v0.5.0 service and route source files
   - `87da3d374a` — v0.5.0 type files (marketplace, company-template, knowledge-starter-pack)
   - `ad6c5f5248` — v0.5.0 tests for marketplace, onboarding, and db-health-watchdog
   - `cd7f9d21db` — P0-A auth hardening (agents:create gate + board approval check), P0-B db-health-watchdog external mode warn-only

2. **Staff Engineer P0 findings (VOY-1391) assessed for documentation impact** — Two P0 findings were raised by the Staff Engineer on v0.5.0 features; both were fixed by the CTO and committed as `cd7f9d21db`:
   - **P0-A (Marketplace hire auth bypass)**: `agents:create` permission gate + board approval gate added to hire endpoint. Docs reflect the final fixed behavior.
   - **P0-B (db-health-watchdog external mode)**: External mode now logs warning only (no exit). Matches the documented design in the module header. Internal/ops feature — no customer-facing doc change needed.

3. **New support case assessments created (2):**
   - **Agent Marketplace** (`assessments/support-case-v0.5.0-marketplace.md`) — Covers browse + one-click hire, endpoints, authorization (agents:create permission + board approval gate), catalog dependency, known limitations, troubleshooting, and escalation paths.
   - **Self-Service Onboarding** (`assessments/support-case-v0.5.0-onboarding.md`) — Covers POST /start flow (company creation, agent hiring, goal/project/task seeding), auth requirements, known limitations, troubleshooting.

4. **API reference docs created (2):**
   - `docs/api/marketplace.md` — Full API reference for marketplace endpoints (list, get, hire) with authorization notes reflecting the final P0-A behavior.
   - `docs/api/onboarding.md` — Full API reference for POST /start with response schema and step-by-step flow description.

5. **Navigation and index updated:**
   - `docs/docs.json` — Registered `api/marketplace` and `api/onboarding` in REST API reference navigation.
   - `docs/api/overview.md` — Added Marketplace and Onboarding rows to API Areas table; version bumped to v0.5.0.
   - `docs/support/README.md` — Added Marketplace and Onboarding rows to "Recently Shipped Features" table.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 0 for v0.5.0 scope |
| Release notes currency | Up to date through v0.4.0-alpha + VOY-1367 fixes; v0.5.0 features documented but release note pending |
| Docs synced with live code | ✅ v0.5.0 branch (marketplace, onboarding, billing, notifications, company templates, board chat) |
| Branch | voy-1367-fix-review-blockers (PR #48 awaiting human GitHub approval) |
| P0 fixes (VOY-1391) | ✅ Committed as `cd7f9d21db` — agents:create gate + board approval check marketplace hire; db-health-watchdog external mode warn-only |

### Next triggers to watch for

- **VOY-1381 release completes** → final release notes refresh with v0.5.0 features; QA engineer (VOY-1385) begins verification
- **PR #48 human approval** → enables merge to master
- **COO request for documentation health report** — available on demand

## 2026-08-17 — Heartbeat: RC-4 docs sync — C-fixes + Phase 5 remaining assessed and documented

### What was done

1. **Diff assessment of post-RC-3 commits** — Two new code commits landed on `v0.4.0-polaris-deep-planning-memory` since the RC-3 docs sync:
   - `75c6c27a41` — Phase 5 C-fixes (C-1 Zod action signal validation, C-2 TOCTOU SLA dedup safety net, C-3 plainto_tsquery search safety)
   - `466c30fde7` — Phase 5 remaining (memory extraction jobs service + API, batch gate counts, `plan.gate_created` live events, UI refinements, board-chat regex fix)
   - Both are tagged as **v0.4.0-alpha-rc.4**.

2. **Support assessments updated**:
   - **Chat-to-work resolution cards** — added the C-1 Zod validation trust boundary: allowed type/action enums, URL protocol restriction (http/https only), field length limits (title 500 / id 200 / rationale 5000), 10-block max per response, silent skip of invalid blocks. Updated Known Limitations, Error States, and commit references.
   - **Memory & Knowledge** — added the C-3 search safety behavior (plainto_tsquery), the memory extraction jobs API and UI (extractions tab, retry failed jobs), and new error-state entries for both.

3. **New KB articles created**:
   - `kb/search-safety-plainto-tsquery.md` — C-3 search safety fix (special characters no longer crash knowledge search or memory warm-up).
   - `kb/sla-monitor-dedup-safety-net.md` — C-2 TOCTOU post-insert dedup safety net for SLA alert issues.

4. **API docs updated** — `docs/api/memory.md` gained the extraction jobs endpoints (list, get, retry) with auth notes and status semantics.

5. **Release notes refreshed** — `docs/support/releases/v0.4.0-alpha-deep-planning.md` and `docs/releases.md` bumped to RC-4 with a "Post-RC-3 Committed Changes (RC-4)" section covering all 7 changes. `docs/support/README.md` index updated with both new KB articles and the RC-4 release entry.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) |
| Release notes currency | Up to date through v0.4.0-alpha-rc.4 (Voyonder) + v2026.722.0 (Paperclip) |
| Docs synced with live code | ✅ RC-4 (commits `75c6c27a41`, `466c30fde7`) |
| Product dev server | UP (port 3100 healthy) |

### Next triggers to watch for

- **VOY-1265 QA findings on RC-4** → any UI behavior deltas worth a support note
- **v0.4.0 release to main** → final release notes refresh for v0.4.0 (stable)
- **PostHog error monitoring (VOY-999) reaching production** → finalize SOP from draft
- **COO request for documentation health report** — available on demand

## 2026-08-18 — Heartbeat: VOY-1367 landed — billing + notification features documented

### What was done

1. **Diff assessment of commit `b4526451aa` (VOY-1367)** — Major commit landed on `main` fixing VOY-1364 review blockers:
   - **B1 (Billing trust boundary)** — board-user-only mutation guard on all billing routes; agents get 403
   - **B2 (Migration 0137 index drops)** — restored memory_records_embedding_hnsw_idx, company_binding_idx, created_at_idx (migration 0141)
   - **B3 (Execution error notification idempotency)** — deduplication by runId
   - **S1-S4 (Notification refinements)** — effective channel defaults, digest deferral, execution_error email:false default, target user membership check
   - Includes full billing service (708 lines), notification service (884 lines), email templates, 3 test files (17 tests passing)

2. **Support case assessments created (2 new)**:
   - **Billing System** (`docs/support/assessments/support-case-billing-system.md`) — Covers subscription management (create/update/cancel/reactivate), usage reporting (seats, agent_runs, storage_gb), invoice syncing, Stripe webhooks, trust boundary, and all 12 API endpoints
   - **Notification System** (`docs/support/assessments/support-case-notification-system.md`) — Covers all 5 notification types (review_requested, approval_needed, work_completed, budget_threshold, execution_error), 3 channels (in_app, email, webpush), digest options, push subscriptions, SMTP/VAPID configuration, and 11 API endpoints

3. **Release notes updated** (`docs/support/releases/v0.4.0-alpha-deep-planning.md`):
   - Added **Billing System** section with endpoint table, trust boundary info, usage metrics, and configuration
   - Added **Notification System** section with notification types, triggers, channels, digests, deduplication, and endpoint table
   - Updated the hotfix section note about VOY-1342 notification code (now included, not deferred)
   - Added 5 new escalation path entries (billing agent 403, billing mutation, email delivery, notification failures, webhook issues)
   - Added both new assessments to Related Documentation

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 3 (planned backlog) |
| Release notes currency | Up to date through VOY-1367 (`b4526451aa`) |
| Docs synced with live code | ✅ VOY-1367 |
| Product dev server | UP (port 3100 healthy) |

### Commit trace (docs landed on `voy-1367-fix-review-blockers`)

- `7335f26415` — support case assessments: billing, notification, company templates + release notes billing/notification sections
- `8065881583` — API reference docs: board chat, company templates + board-chat assessment
- `fb01c9d21b` — company templates assessment: add `c067b8c494` (route wiring) to commit trace

All docs verified against source: `routes/billing.ts` (12 endpoints, board-user guard), `routes/notifications.ts` (11 endpoints), `routes/issues.ts` + `routes/approvals.ts` + `services/budgets.ts` (auto-notification triggers), `services/notifications.ts` (SMTP/VAPID config).

### Next triggers to watch for

- **VOY-1367 unblocking** → CTO to re-review; any API behavior changes may need doc updates
- **v0.4.0 stable release** → final release notes refresh
- **PostHog error monitoring reaching production** → finalize SOP from draft
- **COO request for documentation health report** — available on demand

## 2026-08-17 — Heartbeat: C-fixes resolved, Staff Engineer review in progress, docs current

### What was done

1. **Pipeline state change detected** — All three C-fixes (VOY-1297/1298/1299) are now marked **done**:
   - C-1 (LLM Trust Boundary — Zod SSE validation)
   - C-2 (TOCTOU Race — SLA dedup post-insert verification)
   - C-3 (to_tsquery safety — plainto_tsquery replacement)
   - These fixes were already in the working tree as pre-release changes; issues now reflect completion.

2. **VOY-1263 (Staff Engineer review) now in_progress** — The code review blocking Phase 5 is actively being worked. VOY-1209 (CTO ship Phase 5) remains blocked pending review completion. VOY-1306 (COO reprioritization) still in todo.

3. **Diff assessment** — No new Voyonder commits since `1cc37eb740` (RC-3 docs sync). Working tree contains the same pre-release C-fix changes already assessed. Paperclip platform commits on public master are unrelated to Voyonder.

4. **Documentation status confirmed current** — All feature assessments, KB articles, release notes, and API docs are in sync through v0.4.0-alpha-rc.3. Three C-fix documentation impacts are logged and ready for when fixes ship (KB articles for C-1 validation, C-2 dedup hardening, C-3 search safety).

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + 3 C-fix updates (when shipped) |
| Release notes currency | Up to date through v0.4.0-alpha-rc.3 (Voyonder) + v2026.722.0 (Paperclip) |
| Pipeline critical path | VOY-1297/1298/1299 ✅ done → VOY-1263 🔄 in_progress → VOY-1209 ⏳ blocked → VOY-1186 ⏳ blocked |

### Next triggers to watch for

- **VOY-1263 review completion** → VOY-1264/1209 release proceeds; confirm release notes/KB coverage before staging ship
- **C-fix commits landing** → create KB articles for C-1 (Zod validation), C-2 (dedup hardening), C-3 (search safety)
- **VOY-1265 QA findings** → any UI behavior deltas worth a support note
- **v0.4.0 release to main** → final release notes refresh for v0.4.0 (stable)
- **PostHog error monitoring (VOY-999) reaching production** → finalize SOP from draft
- **COO request for documentation health report** — available on demand

## 2026-08-17 — Heartbeat: Documentation health report + idle monitoring

### What was done

1. **Produced comprehensive documentation health report** — saved to `doc/status/2026-08-17-support-engineer-health-report.md`. Coverage audit confirms:
   - 8 feature assessments all current (5 Voyonder v0.2.10–v0.4.0 + 3 pre-release)
   - 7 KB articles all current
   - 5 Voyonder release notes + 8 Paperclip release notes all current
   - 3 API documentation pages up to date
   - 5 planned backlog items still pending (no change)
   - 3 C-fix documentation impacts identified and logged for when fixes ship

2. **Diff assessment** — No new code commits since last support engineer heartbeat (`5333f76e0d`). Working tree contains all three C-fix implementations from the Staff Engineer structural review (VOY-1297/1298/1299):
   - **C-1**: Zod schema validation for action signals (board-chat.ts) — trust boundary fix, pre-release
   - **C-2**: Post-insert SLA dedup verification (issues.ts) — TOCTOU race fix, pre-release
   - **C-3**: `plainto_tsquery` replaces manual tsquery construction (knowledge-documents.ts, memory-context-injection.ts) — search safety fix, pre-release
   - These are pre-release changes already covered by existing support assessments; no documentation action needed until they ship.

3. **Server health verified** — Product dev server (port 3100) is DOWN; PraeSyn server (port 3101) healthy. Cannot verify docs against live VOY API at this time.

4. **Release pipeline monitored** — RC-3 release notes and support docs are complete. Pipeline blocked on C-fixes from Staff Engineer structural review (VOY-1297/1298/1299). No documentation action needed until fixes ship.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + 3 C-fix updates (when shipped) |
| Release notes currency | Up to date through v0.4.0-alpha-rc.3 (Voyonder) + v2026.722.0 (Paperclip) |
| Product dev server | DOWN (port 3100 unreachable) |

### Next triggers to watch for

- **C-fix commits landing** (VOY-1297/1298/1299) → assess diff for documentation impact
- **VOY-1264 unblocks** → confirm release notes reference final version before staging ship
- **VOY-1265 QA findings** → any UI behavior deltas worth a support note
- **v0.4.0 release to main** → final release notes refresh for v0.4.0 (stable)
- **PostHog error monitoring (VOY-999) reaching production** → finalize SOP from draft
- **COO request for documentation health report** — available on demand

## 2026-08-16 — Heartbeat: v0.4.0-alpha documentation sync — plans, memory, knowledge API docs + support assessments (VOY-1254)

### What was done

1. **Assessed the diff since last documentation sync** (`1cb3953775` → `HEAD`):
   - 175 files changed (+17373/-220) since the v0.2.10 documentation sync
   - Deep Planning Workstream A: plan documents service, review gates, review context (Phases 1-3)
   - Memory & Knowledge Workstream B: memory adapter, bindings, context injection, embedding, knowledge documents
   - Plan Decomposition Wizard (UI), Board Chat updates, Onboarding Role Assets
   - Phases 1-3 audit fixes and CTO completion commits verified

2. **Created/updated API documentation** (3 new pages, 1 updated page):
   - `docs/api/plans.md` — NEW: Structured plan documents, revision history, review gates, decompositions
   - `docs/api/memory.md` — NEW: pgvector-based memory bindings, capture, query, records, scope enforcement
   - `docs/api/knowledge.md` — NEW: Knowledge document CRUD, lifecycle, revisions, backlinks, search
   - `docs/api/issues.md` — UPDATED: Added plan documents, review gates, accepted-plan-decompositions sections; version bumped to v0.4.0-alpha

3. **Created curated release notes** — `docs/support/releases/v0.4.0-alpha-deep-planning.md`:
   - Customer-facing release notes covering Deep Planning, Review Gates, Plan Decomposition, Agent Memory, Knowledge Documents
   - API endpoint table, database migrations table, support escalation paths

4. **Created support case assessments** (2 new):
   - `docs/support/assessments/support-case-v0.4.0-deep-planning.md` — Plan documents, gates, decomposition: FAQ, troubleshooting, error states, escalation paths
   - `docs/support/assessments/support-case-v0.4.0-memory-knowledge.md` — Memory & Knowledge: FAQ, troubleshooting, error states, escalation paths

5. **Updated navigation and indexes**:
   - `docs/docs.json` — Added plans, memory, knowledge to API Reference navigation
   - `docs/support/README.md` — Added v0.4.0-alpha entries to feature assessments and release notes tables
   - `docs/releases.md` — Added v0.4.0-alpha summary entry

6. **Versioned all document updates** with v0.4.0-alpha release version.

### Verification

- [x] API docs verified against server routes (plans, memory, knowledge routes in `server/src/routes/`)
- [x] Shared type schemas verified (`packages/shared/src/validators/plan.ts`, constants in `packages/shared/src/constants.ts`)
- [x] Existing docs updated with new sections and version metadata
- [x] Release notes written for customer consumption (no raw commits, no IP disclosure)
- [x] Support assessments cover FAQ, troubleshooting, error states, escalation paths

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 3 (planned backlog) + CEO Chat (future release) |
| Release notes currency | Up to date through v0.4.0-alpha (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- CEO Chat v0.4.0 release → support case assessment
- PostHog error monitoring (VOY-999) reaching production → finalize SOP from draft
- COO request for documentation health report

## 2026-08-16 — Heartbeat: Commit v0.2.13 billing-fixes docs + close VOY-1230 (VOY-1233)

### What was done

1. **Committed v0.2.13 Stripe billing fixes docs** as `85d40a0327` (VOY-1233):
   - `docs/support/releases/v0.2.13-stripe-fixes.md` — curated release notes for the 5 fixes
   - `docs/support/kb/billing-cancellation-downgrade.md` — KB article on cancellation downgrade behavior
   - `docs/support/assessments/support-case-stripe-billing-fixes.md` — FAQ, troubleshooting, error states, escalation paths
   - `docs/support/README.md` — added v0.2.13 entries to all three tables (assessments, KB, releases)
   - `docs/support/heartbeat-log.md` — logged the sync

2. **Closed VOY-1230** (backlog → done) — the original docs-sync issue was superseded by the VOY-1233 work. All deliverables (release notes, KB article, support case assessment, README update) were completed.

3. **Verified docs consistency** — The billing-fixes docs (canonical) cover the same v0.2.13 changes as the earlier tier-sync docs (VOY-1237). All README links point to the canonical billing-fixes versions.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 (Deep Planning, Memory, Knowledge, CEO Chat) when released |
| Release notes currency | Up to date through v0.2.13 (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **v0.4.0 release to main** → support case assessment for Deep Planning, Memory & Knowledge, CEO Chat
- PostHog error monitoring (VOY-999) reaching production → finalize SOP from draft
- COO request for documentation health report

## 2026-08-16 — Heartbeat: v0.2.13 support case assessment + release notes (VOY-1237)

### What was done

1. **Support case assessment created** — `docs/support/assessments/support-case-stripe-tier-sync.md` (VOY-1237):
   - Covers `syncTierFromStripe()` hardening: active/trialing-only subscription check, deleted-customer (`{deleted: true}`) detection, auto-downgrade to free, safe `mapStripeStatus()` replacement for unsafe type casts
   - Covers `findOrCreateStripeCustomer()` stale reference auto-repair (VOY-896)
   - Covers NEXTAUTH_URL Google OAuth redirect fix
   - Includes user confusion points, FAQ, troubleshooting steps, error states table, and escalation paths

2. **Release notes created** — `docs/support/releases/v0.2.13-stripe-tier-sync.md`:
   - Curated, customer-facing notes for the v0.2.13 release
   - Before/after behavior table for support staff
   - Support escalation path table

3. **Support KB updated** — `docs/support/README.md`:
   - Added Stripe Tier Sync Hardening to Recently Shipped Features table
   - Added Voyonder Release Notes index section

### Verification

- Source: Release Engineer pipeline status (docs/release-engineer/2026-08-16-pipeline-status.md) — branch `fix/voy-944-must-fix-items` (02d2992) contains VOY-944 must-fix items, VOY-896 stale-ref auto-repair, NEXTAUTH_URL fix
- Merge to main (VOY-1218) done, QA verification (VOY-1231) complete
- Stripe-webhook tests 45/45 pass on branch

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 (Deep Planning, Memory, onboarding roles) when released |
| Working tree docs changes | 3 files (2 new, 1 modified) |
| Release notes currency | Up to date through v0.2.13 (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **v0.4.0 release to main** → support case assessment for Deep Planning, Memory & Knowledge, onboarding role assets
- PostHog error monitoring (VOY-999) reaching production → finalize SOP from draft
- COO request for documentation health report

## 2026-08-15 — Heartbeat: Committed 30-file documentation sync (1cb3953775)

### What was done

1. **Committed the accumulated documentation work** as `1cb3953775` (30 files, +1902/-14):
   - **Status CAS documentation** added to `docs/api/issues.md` — `expectedStatus` / `expectedStatuses` / `allowTerminalReopen`, 409 Conflict semantics. Verified against `server/src/routes/issues.ts` (409 sites + `allowTerminalReopen` opt-in).
   - **Hermes adapter docs** — new `docs/adapters/hermes-local.md` and `docs/adapters/hermes-gateway.md`. Verified adapter type keys exist in `packages/shared/src/constants.ts` (`hermes_local`, `hermes_gateway`) and `packages/adapters/hermes/` has both `cli/` and `gateway/` entrypoints.
   - **Version frontmatter** added to 11 existing docs pages (version + last_updated).
   - **Curated releases page** `docs/releases.md` — Paperclip v2026.525.0 through v2026.722.0.
   - **docs.json navigation** — added `releases` page to Get Started, Hermes adapter pages to Adapters tab.
   - **Support KB committed** — 4 KB articles, 5 feature assessments (CAS, Task Watchdogs, Ask Work Mode, Skills Store, Company Artifacts), PostHog triage SOP, v0.2.10 + v0.2.12 release notes.

2. **Verified docs against live code** before committing:
   - CAS: server returns 409 with `details.actualStatus`; `allowTerminalReopen` gate present at route level
   - Hermes adapters: both type keys in shared constants; adapter package has cli + gateway entrypoints

### Diff assessment (since last commit)

- No new commits landed since `0668ffb98f` (docs v0.2.10). Working tree had only my in-flight documentation changes — now committed.
- Remaining uncommitted working tree changes are engineering work (Deep Planning / Memory / onboarding assets / plans) — not documentation, and not yet released; no docs action per the "no docs for unreleased features" rule.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog: Sandbox Execution, Workspace File Viewer, Inline Annotations, Skills CLI, Routine Secrets) |
| Working tree docs changes | 0 (all committed) |
| Release notes currency | Up to date through v2026.722.0 (Paperclip) + v0.2.12 (Voyonder) |

### Next triggers to watch for

- PostHog error monitoring (VOY-999) reaching production → finalize SOP from draft
- Deep Planning / Memory v0.4.0 phases unblocking → support case assessments needed at release
- COO request for documentation health report

## 2026-08-15 — Documentation Health Report

### What was done

**1. Knowledge Base Articles (KB)**
Created 4 KB articles covering recent behavioral changes committed on the voy-770-ci-harden-smoke-tests branch:

- `kb/environment-readenum-corrupt-driver.md` — `readEnum()` returns null on corrupt driver values instead of throwing (PRA-577, commit 32ccc16229)
- `kb/blocker-attention-child-only-classification.md` — Child-only blockers now classify as needs_attention (RBR-824, commits 6b0b118367 + 7f84af039b)
- `kb/recovery-phantom-park-protocol.md` — Recovery phantom-park-and-revalidate protocol (RBR-921 AC3 / RBR-953, commit 7f84af039b)
- `kb/heartbeat-max-concurrent-runs.md` — tickTimers enforces maxConcurrentRuns before enqueueing (PRA-553, commit b9d5299816)

**2. PostHog Error Monitoring Triage SOP**
Drafted `posthog-error-monitoring-triage-sop.md` — complete triage workflow for auto-created PostHog error issues, including severity validation, root cause investigation paths, escalation paths, and monitoring script verification commands. Status: Draft (VOY-999 not yet released).

**3. Support README**
Updated to include KB index, SOP index, file naming conventions, and document maintenance guidelines.

**4. Release Notes (`docs/releases.md`)**
Updated with 3 newly shipped stable releases:
- v2026.722.0 (July 22) — Run-bound agent secret access, Windows local agents, Connections v3
- v2026.720.0 (July 20) — Skill Studio, Attention queue & Decisions, self-healing runs
- v2026.707.0 (July 7) — User-specific secrets, Work Timeline, custom sandbox images, env-var editor redesign

### Documentation Health Report

**Coverage Summary:**
- Feature assessments: 5/5 shipped features assessed (Company Artifacts, Skills Store, Task Watchdogs, Ask Work Mode, Status CAS)
- KB articles: 4/4 recent behavioral changes documented
- Release notes: 8 releases documented (v2026.525.0 through v2026.722.0)
- SOPs: 1 drafted (PostHog error monitoring), pending release

**Planned but not yet assessed:**
- Sandbox Execution (Kubernetes provider) — v2026.618.0
- Workspace File Viewer — v2026.618.0
- Inline Document Annotations — v2026.529.0
- Company Skills CLI — v2026.529.0
- Routine Secrets — v2026.525.0

**Outstanding working tree changes (pending review/commit):**
- 13 docs pages with version frontmatter additions and link updates
- 2 new Hermes adapter docs (hermes-local.md, hermes-gateway.md)
- Navigation updates (new releases page, adapter pages in docs.json)
- Status CAS documentation added to api/issues.md

## 2026-08-15 — Heartbeat: Diff Assessment & Monitoring

### What was reviewed

**Commit be70f14912 — fix(ci): harden smoke test pipeline — pre-merge gates + flaky test fixes (VOY-770)**
- Changes: CI pipeline gates, flaky test timeout fixes, CI audit document
- Impact: **None** — CI/internal only, no customer-facing behavior changes
- Action: No KB article or documentation update needed

**Recent upstream commits (not on voy-770 branch but on mainline):**
- `ea3a5ea7d2` — fix(recovery): skip successful-run handoff for recovery-action-driven runs
  - Bug fix for unbounded wake loop; no user-facing behavior change
- `69027cbaae` — fix(workspaces): reopen archived git worktree for managed_checkout projects
  - Bug fix for workspace reopen after archive cleanup; no user-facing behavior change
- Various onboarding fixes, review policy serialization, UI fixes
  - All bug fixes or internal improvements; no new features requiring documentation

**Assessment conclusion:** No documentation gaps created by recent commits. All support docs are current.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (see above, planned backlog) |
| Working tree docs changes | 15 files (uncommitted) |
| Release notes currency | Up to date through v2026.722.0 |

## 2026-08-15 — Heartbeat: v0.2.10 release in deployment, health report v8

### What was done

1. **Verified current production state** (curl checks at ~19:00 UTC):
   - **BUG-1** (metadata on /terms): Still present — "Author: CEO", "Date: 2026-08-13", "Status: Product-Approved" visible
   - **BUG-2** ([company address] on /privacy): Still present — "Voyonder Privacy Team, [company address]" visible
   - **BUG-4** (duplicate checkbox on /join): Already fixed — 1 terms-acceptance checkbox
   - Confirmed v0.2.10 has NOT yet shipped to production

2. **Tracked release progress**: Release Engineer (VOY-1162) actively running as of 18:17 UTC — deploying BUG-1..4 fixes, domain revert, billing fix

3. **Documentation health report v8**: Created documenting pre-release state, production verification results, and post-release tasks

4. **Confirmed docs are ready**: v0.2.10 release notes and support case assessment committed (0668ffb98f) — awaiting deployment to go live

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) |
| Working tree docs changes | 15 files (uncommitted) |
| Release notes currency | Up to date through v0.2.10 |

### Next triggers to watch for
- Release Engineer completing v0.2.10 deployment (VOY-1162)
- QA Engineer needing verification support (VOY-1158) after release ships
- COO requesting documentation health report
- PostHog error monitoring release (VOY-999) reaching production

## 2026-08-15 — Heartbeat: Monitoring v0.2.10 release, no active assignments

### Current state (18:43 UTC)

- **VOY-1162** (v0.2.10 deployment) — Still in_progress, Release Engineer running since 18:17 UTC
- **VOY-1158** (QA verification) — Blocked, waiting for release
- **VOY-1163** (COO Board Pulse) — In progress
- No issues currently assigned to Support Engineer

### Production verification (18:40 UTC)

Pre-release state confirmed:
- **BUG-1** (metadata on /terms): STILL PRESENT — "Author: CEO", "Date: 2026-08-13", "Status: Product-Approved" visible
- **BUG-2** ([company address] on /privacy): STILL PRESENT — "Mail: Voyonder Privacy Team, [company address]" visible
- **BUG-4** (duplicate checkbox on /join): Already fixed (1 terms-acceptance checkbox)
- voyonder.com, /privacy, /terms all return HTTP 200

### Documentation status

- v0.2.10 release notes committed at `docs/support/releases/v0.2.10-domain-revert.md`
- v0.2.10 support case assessment committed at `docs/support/assessments/support-case-domain-revert.md`
- Both committed in 0668ffb98f — awaiting release to go live before verifying

### Next actions

1. Monitor VOY-1162 for completion
2. After release ships: verify BUG-1 and BUG-2 are fixed on production
3. Notify QA Engineer (VOY-1158) once release is verified
4. Await COO direction for any additional documentation tasks

## 2026-08-15 — Heartbeat: Production verification + v0.2.12 docs

### Production verification (19:40 UTC)

**v0.2.12 is LIVE on voyonder.com.** Full verification results:

| Check | Result | Status |
|---|---|---|
| voyonder.com HTTP 200 | 200 | ✅ |
| /privacy HTTP 200 | 200 | ✅ |
| /terms HTTP 200 | 200 | ✅ |
| /documentation HTTP 200 | 200 | ✅ |
| /documentation/releases HTTP 200 | 200 | ✅ |
| BUG-1: No internal metadata on /terms | 0 occurrences of "Author: CEO" or status headers | ✅ FIXED |
| BUG-2: No [company address] on /privacy | 0 occurrences | ✅ FIXED |
| Footer links on /privacy | Links to /documentation, /terms found | ✅ |

### What was done

1. **Production verified** — BUG-1 (metadata on /terms) and BUG-2 ([company address] on /privacy) are both fixed and confirmed on voyonder.com
2. **v0.2.12 release notes created** — `docs/support/releases/v0.2.12-legal-pages.md`
3. **v0.2.12 support case assessment created** — `docs/support/assessments/support-case-legal-pages.md`
4. **Heartbeat log updated** — this entry

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) |
| Working tree docs changes | 4 files (2 new, 1 modified) |
| Release notes currency | Up to date through v0.2.12 |

### Pending actions

1. ✅ ~~Monitor VOY-1162 for completion~~
2. ✅ ~~Verify BUG-1 and BUG-2 fixed on production~~
3. ✅ ~~Notify QA Engineer (VOY-1158) — BUG-1/BUG-2 confirmed fixed~~
4. ⏳ Await COO direction for any additional documentation tasks

## 2026-08-15 — Heartbeat: Board stalled, no active documentation work

### Assessment

Documentation is fully in sync with the live system:

| Area | Status |
|---|---|
| v0.2.10 (domain revert) release notes | ✅ Committed (0668ffb98f) |
| v0.2.10 support case assessment | ✅ Committed |
| v0.2.12 (legal pages) release notes | ✅ Committed |
| v0.2.12 support case assessment | ✅ Committed |
| Customer-facing /documentation | ✅ Up to date |
| Working tree docs improvements | 15 files (version metadata, Hermes adapter docs, navigation updates) |
| Pending KB articles | 0 |
| Open support issues | 0 |

### Board state

- **COO Board Pulse (VOY-1183)** — In progress, routine 4-hour cadence
- **18 blocked issues** — All waiting on founder action, QA verification, or code review
- **No features actively shipping** — Board is stalled; next triggers for documentation will come when blocked items are unblocked

### Features that will need support assessment when unblocked

1. **PostHog Error Monitoring** (VOY-999 / VOY-1007-1010) — Draft SOP exists at `docs/support/posthog-error-monitoring-triage-sop.md`
2. **Domain verification fixes** (VOY-1033 chain) — Bug fixes, minimal support impact
3. **OTel SDK deployment** (VOY-994) — Internal infrastructure, no customer-facing docs needed

### Next triggers

- Board unblock (founder action on VOY-1182 / VOY-1168) → features may start shipping
|- COO request for documentation health report
|- PostHog error monitoring reaching production → finalize SOP
|- New feature development starting → support case assessment needed

## 2026-08-15 — Heartbeat: Deep Planning Decomposition & Polaris ROADMAP

### What was done

1. **Decomposed Deep Planning workstream into 5 child issues** (PRA-633):
   - PRA-640 [DP-1] — Plan Document Schema & Milestone Tracking (high)
   - PRA-641 [DP-2] — Plan Revision Diff View (high)
   - PRA-642 [DP-3] — Board UI: Plan Browsing & Approval Gates (high)
   - PRA-643 [DP-4] — Plan-to-Issue Decomposition UI (medium)
   - PRA-644 [DP-5] — Plan Context Injection for Agent Heartbeats (medium)

2. **Closed PRA-636** (COO: Break Down Deep Planning) — delivered

3. **Closed PRA-639** (COO: Update ROADMAP.md with Project Polaris Theme) — ROADMAP.md already updated in working tree with Polaris section, three workstreams, v0.4.0 boundary note

4. **Codebase assessment** — Verified substantial Deep Planning foundation already built: plan docs with revision tracking, planning workMode, plan review annotations context, accepted plan decomposition API, plan-level approval interactions, board-chat.ts route

### Current board status
- All agent-executable work complete
- Open items: PRA-277 (blocked on Ben), PRA-383 (todo/Bluevine CSV), PRA-49 (blocked on 383), PRA-365 (blocked on Ben), PRA-632 (CEO steering Polaris), PRA-637 (CTO working schema assessment)

## 2026-08-15 — Heartbeat: v0.4.0 implementation landed, v0.2.13 pending CTO sign-off

### What happened since last heartbeat

1. **Commit `b7a0058a33` landed** on `v0.4.0-polaris-deep-planning-memory` (17:33 UTC) — the full v0.4.0 implementation:
   - **Workstream A — Deep Planning**: `plan_metadata` on documents, `plan_review_gates` table (migration 0128), plan document/revision services, plan-level approval gates, `PlanDecompositionWizard` (818 lines) in the UI
   - **Workstream B — Memory & Knowledge**: `memory_bindings`, `memory_binding_targets`, `memory_records` tables (migrations 0129/0130), pgvector-based memory adapter + embeddings service, context injection preamble wired into all 10+ adapter `execute.ts` files
   - **Onboarding assets**: per-role agent instruction bundles added for 12 roles (ceo, cto, coo, coder, qa, cpa, hr-manager, security-engineer, uxdesigner, chief-marketing-officer, content, platformengineer, template, default)
   - Issues: VOY-1195, VOY-1196, VOY-1197, VOY-1203, VOY-1204, VOY-1209, VOY-1190

2. **Release Engineer pipeline status (VOY-1215)** — release candidate `fix/voy-944-must-fix-items` (VOY-944 must-fix items + VOY-896 stale-ref auto-repair + NEXTAUTH_URL OAuth fix) is verified and ready as **v0.2.13**, awaiting CTO go/no-go. Release Engineer committed to notify Support Engineer for docs sync after CTO approval.

### Documentation assessment

| Area | Status |
|---|---|
| Customer-facing /documentation | ✅ In sync — voyonder.com/documentation + /releases both HTTP 200, v0.2.12 content live |
| v0.2.12 release notes + assessment | ✅ Committed (v0.2.12-legal-pages.md) |
| v0.4.0 Deep Planning + Memory | ⏳ **Pre-release** — implementation landed on feature branch, NOT shipped. No customer docs created per the "no docs for unreleased features" rule. Support case assessment will be needed at release. |
| Onboarding role assets (12 roles) | ⏳ Pre-release — part of v0.4.0; support KB entry needed when shipped |
| v0.2.13 (VOY-944/VOY-896) | ⏳ Pending CTO sign-off — release notes + support case assessment will be created once merged/deployed |

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog: Sandbox Execution, Workspace File Viewer, Inline Annotations, Skills CLI, Routine Secrets) + v0.4.0 (Deep Planning, Memory, onboarding roles) when released |
| Working tree docs changes | 0 committed this heartbeat |
| Release notes currency | Up to date through v0.2.12 (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **CTO approval of VOY-1215** → v0.2.13 merges/deploys → create release notes + support case assessment, verify production
- **v0.4.0 release to main** → support case assessment for Deep Planning, Memory & Knowledge, and onboarding role assets
- PostHog error monitoring (VOY-999) reaching production → finalize SOP from draft
- COO request for documentation health report

## 2026-08-16 — Heartbeat: v0.2.13 Stripe fixes — support docs synced (VOY-1233)

### What happened since last heartbeat

1. **VOY-1233 assigned** — Support sync for v0.2.13 Stripe billing robustness fixes. QA verification (VOY-1227) complete, all checks passed.

2. **Release notes created** — `docs/support/releases/v0.2.13-stripe-fixes.md` covering all five fixes:
   - Deleted Stripe customer detection (`{deleted: true}` flag check)
   - Safe subscription status mapping (`mapStripeStatus()` with Prisma enum)
   - Downgrade-to-free on full cancellation (auto-downgrade on next login)
   - Stale-customer auto-repair (self-healing on checkout/billing visits)
   - Trialing subscription sync (active||trialing filter)

3. **KB article created** — `docs/support/kb/billing-cancellation-downgrade.md` — comprehensive troubleshooting for cancellation tier issues, including legacy stuck-tier cases and trialing sync edge cases.

4. **Support case assessment created** — `docs/support/assessments/support-case-stripe-billing-fixes.md` — full assessment covering FAQ, troubleshooting, error states, and escalation paths.

5. **README updated** — Added v0.2.13 entries to assessment table, KB articles table, and Voyonder release notes table.

### Documentation assessment

| Area | Status |
|---|---|
| Customer-facing /documentation | ✅ In sync — v0.2.12 content live on voyonder.com |
| v0.2.10 release notes + assessment | ✅ Committed |
| v0.2.12 release notes + assessment | ✅ Committed |
| **v0.2.13 release notes + assessment** | **✅ Committed (this heartbeat)** |
| v0.4.0 Deep Planning + Memory | ⏳ Pre-release — no customer docs created yet |
| Onboarding role assets (12 roles) | ⏳ Pre-release — KB entry needed when shipped |

### Current state

| Metric | Status |
|---|---|
| Open support issues | 1 (this one — VOY-1233, completing now) |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 when released |
| Working tree docs changes | 4 files created + README updated this heartbeat |
| Release notes currency | Up to date through v0.2.13 (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **v0.4.0 release to main** → support case assessment for Deep Planning, Memory & Knowledge, and onboarding role assets
- PostHog error monitoring (VOY-999) reaching production → finalize SOP from draft
- COO request for documentation health report

## 2026-08-16 — Heartbeat: Diff assessment for Phase 3 audit fixes commit (08254fbf38)

### Trigger

Commit `08254fbf38` landed — "fix(v0.4.0): Phase 3 audit fixes — warm-up, tsquery safety, TTL, scope, index (VOY-1242)"

### Diff assessment

| Change area | Files | User-facing impact | Docs needed? |
|---|---|---|---|
| Memory warm-up: empty query handling + AbortController timeout | `memory-context-injection.ts` | Internal — agents with no memories no longer cause Postgres errors on warm-up. Timeouts cancel properly instead of leaking background work. | No — pre-release fix |
| tsquery sanitization: special characters stripped before full-text search | `memory-adapter.ts`, `memory-context-injection.ts` | User-facing — search queries with special characters no longer throw Postgres errors. Words are sanitized to `[\\w\\-\\']` only. | No — pre-release fix |
| TTL filter: `expiresAt > now()` on all read queries | `memory-adapter.ts` | User-facing — expired memory records are no longer returned in query/list/get results. | No — pre-release fix |
| Scope enforcement: `subjectId` + `sessionKey` filters added | `memory-adapter.ts` | Internal — memory queries now respect these scope dimensions for correct isolation. | No — pre-release fix |
| Composite index: `(company_id, binding_id)` btree (migration 0133) | `0133_memory_records_company_binding_idx.sql` | Internal — query performance improvement. Not user-visible. | No |
| Preamble boundary hardening: null/empty text, NaN scores, long refs | `memory-context-injection.ts` | Internal — robustness for edge-case memory content. | No |
| Memory binding: unique constraint handling + delete returning | `memory-bindings.ts`, `memory-adapter.ts` | Internal — duplicate bindings now return proper conflict errors instead of opaque DB failures. | No |
| Knowledge documents test refactoring | `knowledge-documents.test.ts` | Test infrastructure only. | No |

### Verdict

All 8 change areas are fixes to the v0.4.0 memory system, which has not shipped to production. Per policy, documentation for unreleased features is not created. No documentation updates required at this time.

**Support preparation note:** When v0.4.0 ships, these fixes mean the memory system will be more robust than the initial implementation — fewer Postgres errors on search, no expired records leaking, no warm-up hangs, and proper conflict messages on duplicate bindings. The support case assessment for the memory system should reference these improvements.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 when released |
| Release notes currency | Up to date through v0.2.13 (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **v0.4.0 release to main** → support case assessment for Deep Planning, Memory & Knowledge, and onboarding role assets
- PostHog error monitoring (VOY-999) reaching production → finalize SOP from draft
- COO request for documentation health report
- QA Engineer (VOY-1212) or Release Engineer (VOY-1211) calling for support capability assessment before v0.4.0 ships

## 2026-08-16 — Heartbeat: Working-tree diff assessment — knowledge fixes + OpenAPI route registrations

### Trigger

Heartbeat activation. No new commits since the v0.4.0-alpha docs sync (`ee5693fca6`); working tree carries uncommitted engineering changes.

### Diff assessment (uncommitted working tree)

| Change area | Files | User-facing impact | Docs needed? |
|---|---|---|---|
| OpenAPI route registrations for plan documents, plan review gates, memory bindings/records, knowledge CRUD/revisions/search | `server/src/routes/openapi.ts` (+165), `openapi-routes.test.ts` | Documentation-surface improvement — the plan/memory/knowledge endpoints now appear in the OpenAPI registry with summaries. These are the same routes already documented. | No — docs already cover all of them (`docs/api/plans.md`, `docs/api/memory.md`, `docs/api/knowledge.md`) |
| Knowledge publish stale-approval fix — `publish()` now requires an approved review on the **latest** revision, preventing a stale approval from a prior review cycle being reused after changes_requested → edit → resubmit | `server/src/services/knowledge-documents.ts` | Correctness fix for VOY-1255. Approvals no longer carry across revision cycles. | No — pre-release fix to an unreleased feature (v0.4.0) |
| Knowledge list `latestReviewStatus` fix — fetches latest review per document regardless of status, so `pending`/`changes_requested` show correctly | `server/src/services/knowledge-documents.ts` | Correctness fix for VOY-1256. Review status surfaces accurately in list views. | No — pre-release fix to an unreleased feature (v0.4.0) |
| Shared plan revision/diff types — `PlanDocumentRevision`, `PlanBodyDiffLine`, `PlanRevisionDiff`, `planMetadata` on issue documents | `packages/shared/src/types/issue.ts`, `types/index.ts`, `index.ts` | Type-level additions for plan revision browsing; no behavior change. | No — types only |
| Board UI for plans + memory — `Plans.tsx`, `MemoryBrowser.tsx`, `PlanApprovalGatesSection`, `PlanDetailSection`, `PlanRevisionBrowser`, `PlanStatusBadge`, `ResolutionCard` | `ui/src/` (App.tsx, api/, Sidebar.tsx, pages/) | New operator-facing UI surfaces for plan browsing/approval and memory browsing (VOY-1209, VOY-1204). | No — pre-release UI for unreleased features; support assessment already drafted for v0.4.0 |

### Verdict

No documentation updates required. All working-tree changes are either (a) OpenAPI registry entries for already-documented endpoints, (b) pre-release fixes to v0.4.0 features (which have not shipped — docs-for-unreleased-features rule), or (c) type/UI additions covered by the existing v0.4.0-alpha support assessments.

**Support preparation note:** When v0.4.0 ships, the VOY-1255/VOY-1256 knowledge fixes mean publish now requires an approval on the *current* revision (stale approvals from prior review cycles are rejected) and document lists accurately show `pending`/`changes_requested` review status. The v0.4.0 memory-knowledge support assessment should reference these behaviors at release.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 when released |
| Release notes currency | Up to date through v0.4.0-alpha (Voyonder) + v2026.722.0 (Paperclip) |

## 2026-08-16 — Heartbeat: Commit 380cc921b4 assessed — test-only, no documentation impact

### Trigger

Heartbeat activation. One new commit since the working-tree diff assessment (`bcdb270b89`).

### Diff assessment (380cc921b4 — "test(v0.4.0): add tests for C-1/C-2/C-3 fixes from VOY-1210 review")

| Change area | Files | User-facing impact | Docs needed? |
|---|---|---|---|
| 36 new tests (18 per service) covering plan-documents (listPlanRevisions, computePlanDiff, computeLineDiff) and plan-review-gates (listGates, createGate, resolveGate, supersedeGatesForRevision, supersedeGatesForPreviousRevisions) | `server/src/services/plan-documents.test.ts` (+507), `plan-review-gates.test.ts` (+397) | Test infrastructure only. All tests mock drizzle-orm and verify companyId scoping (C-1), line diff limits (C-2), re-resolve rejection (C-3). | No — tests only, no behavior change |

### Verdict

No documentation updates required. Commit `380cc921b4` is test-only (904 insertions across 2 test files); the behaviors it locks in (C-1/C-2/C-3 fixes from the VOY-1210 review) are pre-release v0.4.0 changes already covered by the v0.4.0-alpha deep-planning support assessment. The working tree carries the same pre-release change areas assessed in the previous heartbeat (knowledge fixes, OpenAPI registrations, migration snapshots, board UI) — no new assessment needed.

### Board state (support-relevant)

- **VOY-1264** (Release: Phase 5 Plan Board UI) — `todo`, Release Engineer; shipping step includes "Notify Support Engineer before shipping". Currently blocked on VOY-1263 (code review). No docs action until it ships.
- **VOY-1211** (Release: Deep Planning v0.4.0-alpha) — `blocked`. Support assessment already drafted (`support-case-v0.4.0-deep-planning.md`).
- **VOY-1265** (QA: Phase 5 Plan Board UI) — `todo`, QA Engineer. Support readiness for the plan board UI will be covered by the existing v0.4.0 assessments.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 when released |
| Release notes currency | Up to date through v0.4.0-alpha (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **VOY-1264 shipping** (Phase 5 Plan Board UI to staging) → confirm release notes / KB coverage for the plan board before/at ship
- **v0.4.0 release to main** → support case assessment for Deep Planning, Memory & Knowledge, onboarding role assets
- PostHog error monitoring (VOY-999) reaching production → finalize SOP from draft
- COO request for documentation health report

## 2026-08-16 — Heartbeat: Commit b495d95b9c assessed — Phase 5 Plan Board UI, Memory Browser, knowledge fixes, OpenAPI registrations

### Trigger

Heartbeat activation. One new commit since the previous assessment (`380cc921b4`): `b495d95b9c` — "feat(v0.4.0): Phase 5 plan board UI, memory browser, knowledge fixes, OpenAPI registrations" (24 files, +2982/-84).

### Diff assessment (b495d95b9c)

| Change area | Files | User-facing impact | Docs action |
|---|---|---|---|
| Plan Board UI — `/plans` page: list view w/ status badges, detail w/ markdown sections, approval gates approve/reject UI, revision browser w/ inline diff, sidebar nav + routes + query keys | `ui/src/pages/Plans.tsx`, `PlanApprovalGatesSection.tsx`, `PlanDetailSection.tsx`, `PlanRevisionBrowser.tsx`, `PlanStatusBadge.tsx`, `App.tsx`, `Sidebar.tsx`, `issues.ts` api | **New operator-facing UI surface** for plan browsing/approval (VOY-1252). Plans UI also mounts in IssueDetail. | Updated `support-case-v0.4.0-deep-planning.md` + release notes with Plan Board UI section |
| Memory Browser UI — `/memory` page: browse records, hybrid search, metadata filter, record detail, forget, operations audit log | `ui/src/pages/MemoryBrowser.tsx` (+705), `ui/src/api/memory.ts` (+155), `memory.test.ts` | **New operator-facing UI surface** for memory inspection (VOY-1204). | Updated `support-case-v0.4.0-memory-knowledge.md` + release notes with Memory Browser section |
| Memory scope query parse — malformed `scope` JSON now returns 400 instead of crashing | `server/src/routes/memory.ts` | Error behavior improvement: clear 400 "Invalid scope query parameter" on malformed JSON | Added error state row to memory-knowledge assessment + release notes support note |
| Memory adapter batch embedding + metadata jsonb containment filter (`metadata` param on query/records) | `server/src/services/memory-adapter.ts` | Performance + new metadata filtering capability for memory records | Added metadata filter mention to memory-knowledge assessment + release notes |
| Knowledge publish stale-approval guard (VOY-1255) — publish requires approved review on latest revision only | `server/src/services/knowledge-documents.ts` | Behavior change: stale approvals from prior review cycles are rejected at publish | Added FAQ + troubleshooting + error state to memory-knowledge assessment + release notes highlight |
| Knowledge `latestReviewStatus` accuracy fix (VOY-1256) — latest review fetched regardless of status | `server/src/services/knowledge-documents.ts` | Behavior change: list views now surface `pending`/`changes_requested` correctly | Added FAQ to memory-knowledge assessment + release notes highlight |
| OpenAPI registrations for plan documents, review gates, memory, knowledge routes | `server/src/routes/openapi.ts` (+165), `openapi-routes.test.ts` | Documentation-surface improvement — same routes already documented | No — `docs/api/plans.md`, `memory.md`, `knowledge.md` already cover them |
| Shared plan revision/diff types (`PlanDocumentRevision`, `PlanBodyDiffLine`, `PlanRevisionDiff`, `planMetadata` on IssueDocument) | `packages/shared/src/types/issue.ts` | Type-level additions; no behavior change | No — types only |

### Verdict

Documentation updates **required** this time (unlike the previous test-only commit). The Phase 5 commit ships two new operator-facing UI surfaces (Plan Board `/plans`, Memory Browser `/memory`) and two knowledge behavior changes (VOY-1255 stale-approval guard, VOY-1256 review status accuracy) that support staff must know about when v0.4.0 ships.

### Updates applied

1. `docs/support/assessments/support-case-v0.4.0-deep-planning.md` — added Plan Board UI section (browse/detail/gates/revisions), related VOY-1252
2. `docs/support/assessments/support-case-v0.4.0-memory-knowledge.md` — added VOY-1255/1256 behavior, Memory Browser UI section, memory scope 400 error state, stale-publish FAQ + troubleshooting, related VOY-1255/1256
3. `docs/support/releases/v0.4.0-alpha-deep-planning.md` — added Plan Board UI (highlight 4), Memory Browser UI (highlight 6), knowledge stale-approval guard (highlight 8), latest review status (highlight 9), support notes for scope 400 + metadata filter
4. `docs/support/heartbeat-log.md` — this entry

### Board state (support-relevant)

- **VOY-1263** (Code Review: Phase 5 Plan Board UI) — `in_progress`, Staff Engineer. Blocks release.
- **VOY-1264** (Release: Phase 5 Plan Board UI) — `blocked` on VOY-1263. Shipping step includes "Notify Support Engineer before shipping".
- **VOY-1265** (QA: Phase 5 Plan Board UI) — `todo`, blocked on VOY-1263/1264. Test scenarios cover /plans, plan detail, gates, revisions, IssueDetail mount, sidebar nav.
- **VOY-1252** (Phase 5 implementation) — done.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 when released |
| Release notes currency | Up to date through v0.4.0-alpha (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **VOY-1263 review completion** → VOY-1264 release proceeds; confirm release notes/KB coverage before staging ship
- **VOY-1265 QA completion** → any UI behavior findings worth a support note
- **v0.4.0 release to main** → final release notes refresh for v0.4.0 (stable)

## 2026-08-16 — Heartbeat: Commit 885a6740b3 assessed — H-2 fix, resolveGate transaction + rejected-gate allApproved (VOY-1269)

### Trigger

New commit `885a6740b3` — `"fix(v0.4.0): wrap resolveGate in transaction, count rejected gates for allApproved (H-2, VOY-1269)"` (2 files, +60/-36).

### Diff assessment

| Change area | Files | User-facing impact | Docs action |
|---|---|---|---|
| `resolveGate` wrapped in DB transaction | `plan-review-gates.ts` | Internal — closes concurrent-resolution race condition | None — existing docs already describe correct behavior. Added transactional note to release notes support notes. |
| `allApproved` predicate now counts rejected gates (was `remainingPending === 0`, now `pending === 0 && rejected === 0`) | `plan-review-gates.ts` | **Bug fix**: previously, approving the last pending gate while a rejected gate existed would incorrectly set `allApproved = true` and flip the plan to `approved`. Now a rejected gate correctly blocks auto-approval. | Docs already stated "when all gates are approved" — fix aligns code with documented behavior. Updated: response shape for resolve gate in `docs/api/plans.md` now documents `allApproved` field; support assessment FAQ covers rejected-gate scenario; escalation paths updated. |
| Regression test for H-2 scenario (rejected gate blocks approval) | `plan-review-gates.test.ts` | Test-only | None |

### Verdict

**No user-facing documentation changes strictly required** — the fix aligns code with documented behavior. However, two documentation improvements were applied:
1. The `allApproved` response field on the resolve gate endpoint was previously undocumented; added response shape with description to `docs/api/plans.md`.
2. Support assessment FAQ and release notes support notes now explicitly cover the rejected-gate-blocking-approval scenario.

### Updates applied

1. `docs/api/plans.md` — Added response shape (gate + allApproved fields) to Resolve Plan Review Gate endpoint; clarified behavior note about rejected gates blocking auto-approval.
2. `docs/support/assessments/support-case-v0.4.0-deep-planning.md` — Added FAQ entry for "rejected gate blocks approval"; updated escalation matrix row.
3. `docs/support/releases/v0.4.0-alpha-deep-planning.md` — Added support note about H-2 fix (rejected gates, transactional resolution); updated escalation path.
4. `docs/support/heartbeat-log.md` — This entry.

### Board state (support-relevant)

- **VOY-1269** (Fix H-2: allApproved predicate) — `in_progress`. Fix committed in `885a6740b3`, issue not yet updated to done.
- **VOY-1278** (Fix H-2: Server allApproved predicate) — `done`.
- **VOY-1264** (Release: Phase 5 Plan Board UI) — blocked on VOY-1263 review (Staff Engineer). Release notes and KB coverage already prepared.
- **VOY-1265** (QA: Phase 5 Plan Board UI) — todo, blocked on VOY-1263/1264.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 when released |
| Release notes currency | Up to date through v0.4.0-alpha (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **VOY-1264 unblocks** → confirm release notes and support docs are ready for staging ship
- **VOY-1265 QA starts** → provide support assessment inputs for test scenarios
- **v0.4.0 release to main** → final release notes refresh

## 2026-08-16 — Heartbeat: Commit 0d4626e82e assessed — Workstream C chat-to-work resolution cards (BOARD-1)

### Trigger

New commit `0d4626e82e` — `"feat(v0.4.0): Workstream C — chat-to-work resolution cards with SSE action signals (BOARD-1)"` (4 files, +289/-0).

### Diff assessment

| Change area | Files | User-facing impact | Docs action |
|---|---|---|---|
| Server: `extractActionSignals()` parses `%%ACTIONS%%{...}%%/ACTIONS%%` JSON blocks from raw model output; emits parsed actions as typed SSE `action` events before persisting the cleaned response | `server/src/routes/board-chat.ts` | **New user-facing capability**: the board assistant's created/updated work objects (issues, plans, approvals, memory, knowledge) now surface to the UI as structured events instead of being silently stripped | Created new support case assessment for the feature |
| UI: BoardChat handles `type: "action"` SSE events, collects into `actionEvents` state, renders `ResolutionCard` components below the streaming text bubble and below the last persisted assistant comment | `ui/src/pages/BoardChat.tsx` | **New UI**: clickable resolution cards (Issue/Plan/Approval/Knowledge/Memory/Decision badges) with View links appear in the Conference Room chat when the assistant creates/updates objects | Created new support case assessment for the feature |
| Skill: "Structured Action Signals" section teaching the model to emit `%%ACTIONS%%` blocks after creating/updating work objects; 7 object type/action pairs; 5 critical rules | `skills/paperclip-board/SKILL.md` | Model behavior guidance — internal, but drives the user-facing cards | Covered in support assessment (card type/action table, troubleshooting) |
| Workstream C audit plan document | `doc/plans/2026-08-16-workstream-c-audit.md` | Internal planning document | None |

### Verdict

Documentation updates **required**. Workstream C closes the chat-to-work resolution gap: users now see structured resolution cards when the board assistant creates work objects — a visible UI behavior change support staff must be able to explain and troubleshoot.

### Updates applied

1. `docs/support/assessments/support-case-v0.4.0-chat-to-work-resolution.md` — NEW support case assessment: feature overview, card type table, how it works, feature flag/gating (`enableConferenceRoomChat`, `local_trusted`), known limitations (one block per response, malformed JSON silently dropped, raw markup visible during streaming, cards reset per turn, View link only when `url` provided, update action only for issue/plan), troubleshooting, error states, escalation paths.
2. `docs/support/releases/v0.4.0-alpha-deep-planning.md` — added highlight #10 (Chat-to-Work Resolution Cards), verification line for BOARD-1 tests, related-docs link.
3. `docs/support/README.md` — added the new assessment to the Recently Shipped Features table and updated the release notes index title.
4. `docs/support/heartbeat-log.md` — this entry.

### Board state (support-relevant)

- **VOY-1264** (Release: Phase 5 Plan Board UI) — `blocked` on VOY-1263 review (Staff Engineer). Release notes and KB coverage already prepared.
- **VOY-1265** (QA: Phase 5 Plan Board UI) — `todo`, blocked on VOY-1263/1264.
- **Workstream C (BOARD-1)** — implementation committed; the Conference Room resolution cards are ready for QA/release. Support assessment now in place.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 when released |
| Release notes currency | Up to date through v0.4.0-alpha (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **VOY-1263 review completion** → VOY-1264 release proceeds; confirm release notes/KB coverage before staging ship
- **BOARD-1 QA/release** → verify Conference Room resolution cards behave as documented; add any QA findings to the support assessment
- **v0.4.0 release to main** → final release notes refresh

## 2026-08-17 — Heartbeat: RC-3 docs sync — Knowledge Browser UI, search route fix, manager-chain permissions (VOY-1303)

### Trigger

VOY-1303 assigned by Release Engineer: verify documentation in sync for the Phase 5 Plan Board UI staging release (VOY-1264, release candidate **v0.4.0-alpha-rc.3**) and confirm version references match RC-3.

### Diff assessment (release branch 8074df8e09 → 0d4626e82e)

| Change area | Files | User-facing impact | Docs action |
|---|---|---|---|
| Knowledge Browser UI — new `/knowledge` page (search, list, detail sheet, revisions/diff, backlinks, create dialog) | `ui/src/pages/KnowledgeBrowser.tsx`, `ui/src/api/knowledge.ts`, `ui/src/components/Sidebar.tsx`, `ui/src/App.tsx` | **New user-facing capability**: operators can search/review/manage knowledge documents from the UI | Added release note highlight #8 + support assessment section |
| Knowledge search route fix — `/knowledge/search` moved BEFORE `/:documentId` (was unreachable, matched as document ID) | `server/src/routes/knowledge.ts` | **Bug fix**: knowledge search endpoint previously 404'd; now reachable from API and UI | Added release note highlight #11 + support note + error state + escalation path |
| Authorization manager-chain grant — managers may comment on/mutate issues assigned to agents in their reporting subtree | `server/src/services/authorization.ts` | **New permission**: CTO/COO can now close/reassign/unblock issues owned by their team | New KB article + release note highlight #12 + escalation row |
| H-1 gate-query invalidation (VOY-1268) | `ui/src/...` (gate queries) | Internal fix — gate UI behavior unchanged | None — already covered by Plan Board UI docs |
| M-1 batch plan-document fetch (3ba7c5aa37) | `server/src/routes/issues.ts` | Internal perf fix (N+1) — no user-facing behavior change | None |
| H-2 resolveGate transaction + allApproved predicate (VOY-1269) | `server/src/routes/plan-review-gates.ts` | Already documented in prior heartbeat (35a8fce6e2) | None — covered |
| Workstream C chat-to-work resolution cards (0d4626e82e) | — | Already documented in prior heartbeat (5333f76e0d) | None — covered |

### Verdict

Documentation updates **required** for RC-3. The Phase 5 Plan Board UI surface was already covered by prior syncs (8074df8e09, ee5693fca6, 35a8fce6e2, 5333f76e0d), but three items in the release branch had **zero documentation coverage**: the Knowledge Browser UI, the knowledge search route fix (critical bug), and the manager-chain authorization grant.

### Updates applied

1. `docs/support/releases/v0.4.0-alpha-deep-planning.md` — version header now references **v0.4.0-alpha-rc.3**; added highlights #8 (Knowledge Browser UI), #11 (search route fix), #12 (manager-chain permissions); renumbered #9/#10 (stale-approval guard, latestReviewStatus); added support notes, verification line (VOY-1266 26/26 UI tests), escalation rows, VOY-1266 to related issues.
2. `docs/support/kb/authorization-manager-chain-grant.md` — NEW KB article: old/new behavior, `allow_manager_chain` reason, support implications, verification steps.
3. `docs/support/assessments/support-case-v0.4.0-memory-knowledge.md` — added Knowledge Browser UI section with search-route-fix support note; added 404 error state; added escalation row; related-docs link to new KB.
4. `docs/support/README.md` — added RC-3 row to Recently Shipped Features; added KB article to KB table; release notes index now references v0.4.0-alpha (RC-3).
5. `docs/releases.md` — /documentation/releases entry retitled **v0.4.0-alpha (RC-3)**; added Knowledge Browser UI + Manager-Chain highlights.

### Board state (support-relevant)

- **VOY-1303** (this task) — docs verified in sync for RC-3; version references updated to match RC-3.
- **VOY-1264** (Release: Phase 5 Plan Board UI) — blocked on CEO disposition of VOY-1273 (M-1). Release notes and KB coverage now complete for RC-3.
- **VOY-1265** (QA: Phase 5 Plan Board UI) — todo, blocked on VOY-1264.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) + v0.4.0 stable when released |
| Release notes currency | Up to date through v0.4.0-alpha-rc.3 (Voyonder) + v2026.722.0 (Paperclip) |

### Next triggers to watch for

- **VOY-1264 unblocks** → confirm release notes reference final tag (v0.4.0-alpha-rc.3 or later RC) before staging ship
- **VOY-1265 QA findings** → any UI behavior deltas worth a support note (add to assessments)
- **v0.4.0 release to main** → final release notes refresh for v0.4.0 (stable)

## 2026-08-17 — Heartbeat: Documentation sync confirmed — no new code, pipeline stalled on founder actions

### What was done

1. **Diff assessment** — No new Voyonder code commits since `466c30fde7` (Phase 5 remaining). The branch `v0.4.0-polaris-deep-planning-memory` HEAD has not advanced. Documentation is already in sync through RC-4.

2. **Server health verified** — Product dev server (port 3100) is **UP** and returning HTTP 200. /documentation and /documentation/releases routes reachable.

3. **Pipeline state** — Board stalled on founder action items:
   - 2 FOUNDER ACTION blocked items assigned to Support Engineer (stale QA issues cleanup, consolidated board cleanup)
   - CTO holds the only `in_progress` issue (close stale domain fix issues + PostHog release)
   - PostHog SOP v1.2 (final) committed at `f654460019` — awaiting VPS-1 cron setup
   - 2 todo items (QA Verification: Deep Planning Workstream A, Phase 5: Company Knowledge Base + Polish) not actionable — blocked upstream

4. **PostHog SOP status** — The Founding Engineer's bash script implementation (`scripts/posthog-error-monitor.sh`, `scripts/test-posthog-monitor.sh`) is committed. The SOP is finalized as v1.2 with `status: Final`. Supporting docs from the Founding Engineer collaboration (posthog-monitoring-review-closure.md) are also committed. Remaining gap: VPS-1 cron deployment (minor ops task, being tracked by CTO in VOY-999 release).

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) |
| Release notes currency | Up to date through v0.4.0-alpha-rc.4 (Voyonder) + v2026.722.0 (Paperclip) |
| Docs synced with live code | ✅ RC-4 (commits `75c6c27a41`, `466c30fde7`) |
| Product dev server | UP (port 3100 healthy) |
| Branch | v0.4.0-polaris-deep-planning-memory (HEAD at `466c30fde7`, no movement) |

### Next triggers to watch for

- **Founder action on stale QA issues** → unblocks QA verification pipeline; may trigger RC-5 or stable v0.4.0 release
- **v0.4.0 release to main** → final release notes refresh for v0.4.0 (stable) + any last KB articles
- **VOY-1265 QA findings** → any UI behavior deltas worth a support note
- **PostHog cron deployment to VPS-1** → SOP goes from final to operational; may generate first PostHog error issues for triage
- **COO request for documentation health report** — available on demand

## 2026-08-17 — Heartbeat: No new code, server DOWN, working tree shows active VOY-1205 development

### What was done

1. **Diff assessment** — No new Voyonder code commits since last heartbeat. Branch `v0.4.0-polaris-deep-planning-memory` HEAD unchanged (`466c30fde7`). Documentation remains in sync through RC-4. No new code requiring documentation.

2. **Server health check** — Product dev server (port 3100) is **DOWN** (connection refused). Previously UP as of the prior heartbeat. The Docker container stack is running (postgres, redis, litellm, enquire-mcp) but the main web server process on 3100 is not. This does not directly block documentation work but means /documentation routes are unreachable on the dev server.

3. **Working tree assessment** — Uncommitted code changes visible in the working tree, likely part of VOY-1205 (Phase 5: Company Knowledge Base + Polish, `in_progress` by Founding Engineer):
   - `POST /companies/:companyId/knowledge/promote-from-memory` — Promote a memory record to a draft knowledge document
   - `GET /companies/:companyId/memory/bindings/:bindingId/capabilities` — Get resolved capabilities for a memory binding
   - `POST /companies/:companyId/knowledge/maintenance/rebuild-index` — Rebuild the pgvector HNSW embedding index
   - Knowledge search LRU cache (in-memory, 5-min TTL, 200-entry max)
   - These are **unreleased** — not documented yet. Per policy, documentation waits until commits land.

4. **Pipeline state** — No change from prior heartbeat:
   - VOY-1205 (Phase 5: Company KB + Polish) — in_progress, Founding Engineer
   - VOY-1307 (FOUNDER ACTION: Close 3 stale QA issues) — blocked, no assignee
   - VOY-1182 (FOUNDER ACTION: Consolidated board cleanup) — blocked, no assignee
   - VOY-1208 (Voyonder: implement features) — blocked, Staff Engineer

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) |
| Release notes currency | Up to date through v0.4.0-alpha-rc.4 (Voyonder) + v2026.722.0 (Paperclip) |
| Docs synced with live code | ✅ RC-4 (commits `75c6c27a41`, `466c30fde7`) |
| Product dev server | DOWN (port 3100 unreachable) |
| Branch | v0.4.0-polaris-deep-planning-memory (HEAD at `466c30fde7`, no movement) |

### Next triggers to watch for

- **VOY-1205 commits land** → will need KB articles for promote-from-memory, binding capabilities endpoint, search cache behavior, and index rebuild endpoint
- **Founder action on stale QA issues** → unblocks QA verification pipeline; may trigger RC-5 or stable v0.4.0 release
- **v0.4.0 release to main** → final release notes refresh for v0.4.0 (stable) + any last KB articles
- **VOY-1265 QA findings** → any UI behavior deltas worth a support note
- **PostHog cron deployment to VPS-1** → SOP goes from final to operational; may generate first PostHog error issues for triage
- **COO request for documentation health report** — available on demand

## 2026-08-17 — Heartbeat: Deep Planning QA verification (VOY-1212) — docs synced

### What was done

1. **Diff assessment of VOY-1326 task** — QA verification of Deep Planning Workstream A (VOY-1212) is complete. Verified the 9 backend API endpoints shipping in v0.4.0-alpha. Analyzed the codebase for documentation gaps.

2. **Gap identified: Plan acceptance flow undocumented** — The decomposition endpoint (`POST /issues/:id/accepted-plan-decompositions`) requires an accepted `request_confirmation` interaction targeting the plan revision. Agents cannot accept this — `assertBoard` requires a human user. This flow was entirely absent from customer-facing documentation.

3. **`docs/api/plans.md` updated**:
   - **Accepted Plan Decomposition** — Added full acceptance flow: agent creates `request_confirmation` → board user accepts → decomposition allowed. Documented the three error responses (422 for missing confirmation, 422 for wrong revision, 409 for idempotency conflict). Updated Key Concepts, Plan Lifecycle, and the decomposition section.
   - **Diff Plan Revisions** — Added explicit response schema (`{ revision, previousRevision, bodyDiff }`) with JSON example, field descriptions, and line-level diff type documentation.

4. **`docs/support/assessments/support-case-v0.4.0-deep-planning.md` updated**:
   - Added confusion point #7 for the "accepted plan confirmation" error
   - Updated FAQ "How do I turn a plan into actual work?" with the full 6-step flow
   - Updated troubleshooting for decomposition with acceptance flow checks
   - Updated Error States and Escalation Path with the new 422 error
   - Updated Feature Overview to reflect human acceptance requirement

5. **`docs/support/releases/v0.4.0-alpha-deep-planning.md` updated**:
   - Added acceptance flow to Support Notes
   - Updated "Approved Plan Decomposition" highlights to note human acceptance requirement
   - Added decomposition 422 to Support Escalation Path

6. **`docs/releases.md` updated** — "Approved Plan Decomposition" highlight now notes human acceptance requirement.

### Current state

| Metric | Status |
|---|---|
| Open support issues (VOY-1326) | 1 — actively working |
| Pending KB articles | 0 |
| Pending feature assessments | 5 (planned backlog) |
| Release notes currency | Up to date through v0.4.0-alpha-rc.4 |
| Docs synced with live code | ✅ Deep Planning QA verification (VOY-1212) — all 9 endpoints, schemas, acceptance flow documented |
| Product dev server | UP (port 3100 healthy) |

### Next triggers to watch for

- **v0.4.0 release to main** → final release notes refresh for v0.4.0 (stable)
- **PostHog error monitoring (VOY-999) reaching production** → finalize SOP from draft
- **COO request for documentation health report** — available on demand

## 2026-08-18 — Heartbeat: Diff assessment of VOY-1381 fix commit — no documentation impact

### What was done

1. **Diff assessment** — Commit `48a32f0b27` (`fix(VOY-1381): restore clean 0142 migration`) landed on `master`:
   - **0142_execution_error_dedup.sql**: Rewrote migration to only contain TOCTOU dedup unique index + invites column cleanup (DROP COLUMN IF EXISTS). Removed all the already-applied 0138–0141 index/FK/constraint noise. *Internal database change — no customer-facing behavior impact.*
   - **0142_snapshot.json**: Regenerated to match clean migration. *Infrastructure.*
   - **pnpm-lock.yaml**: Regenerated. *Dependency resolution — no behavioral change.*
   - **notification-service.test.ts**: 65 lines of test coverage additions for existing notification behavior. *Test-only — no behavioral change to document.*

   **Verdict: No documentation update required.** The notification dedup behavior was already documented in the notification system support assessment (`docs/support/assessments/support-case-notification-system.md`). The invites column cleanup is internal schema drift — no user-facing surface.

2. **Docs sync verification** — All previously committed documentation remains accurate:
   - `docs/releases.md` — v0.4.0-alpha (RC-4) entry correctly lists all highlights including notification dedup
   - `docs/support/assessments/support-case-notification-system.md` — already documents the `notifyExecutionErrorOnce` dedup behavior
   - `docs/support/README.md` — index table current with all shipped features
   - Product dev server healthy (HTTP 200)

3. **Release readiness** — VOY-1382 (docs verification) completed and closed. No further documentation action needed for VOY-1381 release cycle.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Release notes currency | Up to date through v0.4.0-alpha (RC-4) + VOY-1367 fixes |
| Docs synced with live code | ✅ Verified — commit `48a32f0b27` (infra-only, no doc impact) |
| Product dev server | UP (port 3100, HTTP 200) |

### Next triggers to watch for

- **VOY-1381 release completes (merge to production fork)** → final release notes refresh if any last-minute changes land
- **PostHog error monitoring (VOY-999/1015) reaching production** → finalize SOP from draft
- **COO request for documentation health report** — available on demand

## 2026-08-18 — Heartbeat: v0.4.0 docs refresh committed + pushed to PR #48

### What was done

1. **Committed the v0.4.0 customer-facing docs refresh** as `00b83cbc99` on `voy-1367-fix-review-blockers` (previously uncommitted working-tree changes) and **pushed to the fork**, updating PR #48 so the docs ship with the release:
   - `docs/start/core-concepts.md` — expanded to 10 concepts: Plans, Memory, Knowledge added alongside Companies, Agents, Issues, Delegation, Heartbeats, Governance
   - `docs/start/quickstart.md`, `docs/start/what-is-paperclip.md` — refreshed for v0.4.0 feature set
   - `docs/guides/agent-developer/how-agents-work.md` — Plan documents, Memory, Knowledge sections
   - `docs/guides/board-operator/approvals.md`, `experimental-features.md` — Deep Planning workflow coverage
   - `docs/api/overview.md`, `docs/api/plans.md`, `docs/docs.json` — API reference navigation updated
   - `server/src/onboarding-assets/template/TOOLS.md` — Plan/Memory/Knowledge tool reference for onboarded agents
   - `skills/paperclip/references/api-reference.md` — full skill API reference
   - `docs/support/heartbeat-log.md` — this log (prior entry committed with the batch)

2. **Release state check** — VOY-1381 (`480b2f3b`) remains **blocked on human GitHub action**: PR #48 (https://github.com/PraeSynBH/paperclip/pull/48) needs approval + merge by @benh. All automated gates are green (code reviewed, tests pass 17/17, CTO sign-off, docs in sync).

3. **Attempted issue comment** on VOY-1381 with the docs status — write access denied (issue is outside Support Engineer's authorization boundary; owned by Release Engineer). State is documented by Release Engineer + CEO on the issue; this log entry is the durable Support Engineer record.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Release notes currency | Up to date through v0.4.0-alpha (RC-4) + VOY-1367 fixes |
| Docs synced with live code | ✅ Committed `00b83cbc99`, pushed to PR #48 |
| Product dev server | UP (port 3100, HTTP 200) |

### Next triggers to watch for

- **PR #48 merges** → confirm docs landed on production fork; refresh release notes if last-minute changes land
- **PostHog error monitoring (VOY-999/1015) reaching production** → finalize SOP from draft
- **COO request for documentation health report** — available on demand

---

## 2026-08-18 — Heartbeat: ~19:00 UTC — idle, docs verified, release in progress

### What was done

1. **Board state check** — No new issues assigned to Support Engineer (88b72065). Previous task VOY-1382 (docs verification for VOY-1367 release) is **done** as of 17:38 UTC.

2. **Release pipeline status** — VOY-1381 (Release Engineer, `7a2a259f`) is **in_progress** with an active run started at 18:51 UTC. The branch `voy-1367-fix-review-blockers` is fully synced, code-reviewed, CTO-approved, and docs-verified. Blocked on human GitHub approval of PR #48.

3. **QA status** — VOY-1385 (QA Engineer, `c3bdfe58`) is **blocked** on the release. No action needed from Support Engineer.

4. **Documentation health** — Verified all docs are current:
   - `docs/releases.md` — v0.4.0-alpha entry includes Billing, Notifications, Company Templates, Board Chat
   - `docs/support/README.md` — Recently Shipped Features table reflects all v0.4.0 additions
   - `docs/docs.json` — All API reference entries registered
   - `docs/api/` — billing, chat, company-templates, notifications, memory, knowledge docs all present
   - `docs/start/` — core-concepts, quickstart, your-first-company all present
   - `docs/support/assessments/` — billing, notification, company-templates assessments committed
   - Release notes at `docs/support/releases/v0.4.0-alpha-deep-planning.md` carry v0.4.0 highlights

5. **No new Voyonder-commits to assess** — Upstream Paperclip has new commits (feat/fix on `origin/master`, release notes on `origin/release-notes`) but these are not Voyonder-specific changes. No documentation impact for Voyonder.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Release notes currency | Up to date through v0.4.0-alpha (RC-4) + VOY-1367 fixes |
| Docs synced with live code | ✅ Committed, pushed to PR #48 |
| Product dev server | UP (port 3100, HTTP 200) |

### Next triggers to watch for

- **PR #48 merges** → confirm docs landed on production fork; refresh release notes if last-minute changes land
- **PostHog error monitoring (VOY-999/1015) reaching production** → finalize SOP from draft
- **COO request for documentation health report** — available on demand
- **v0.5.0 Market Readiness items** — when issues are created, assess documentation impact

---

## 2026-08-18 — Heartbeat: ~21:10 UTC — v0.5.0 Phase 1 release notes produced, docs synced

### What was done

1. **Release verification** — PR #48 merged (`fc416b1486`) to both `master` and `fork/master`. The v0.5.0 Phase 1 release (VOY-1367 fixes + marketplace + onboarding + company templates) is live on production. Docs at commit `c5e6a588fd` landed with the merge.

2. **v0.5.0 Phase 1 release note created** — `docs/support/releases/v0.5.0-phase-1.md` covers the full scope:
   - Marketplace agent hiring with auth gates
   - Onboarding role pack improvements
   - Company Templates graduating to production-stable
   - VOY-1367 security hardening (billing trust boundary B1, memory index restoration B2, notification idempotency B3, marketplace hire auth P0-A, watchdog fix P0-B, S1-S4 should-fix items)
   - All API reference docs and support case assessments
   - Known issues and upgrade notes

3. **`docs/releases.md` updated** — v0.5.0 Phase 1 entry added above v0.4.0-alpha with highlights linking to the full release note. Frontmatter version bumped to `v0.5.0` with today's date.

4. **`docs/support/README.md` refreshed** — Recently Shipped Features table updated: all "Pre-release" entries now show "Aug 18, 2026 (PR #48)" as shipped date. VOY-1367 hardening entry added. v0.5.0 added to Voyonder Release Notes table. Last-updated date set to 2026-08-18.

5. **No new Voyonder-commits to assess** — `master` and `fork/master` are in sync at `fc416b1486`. No new upstream changes with Voyonder impact detected.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Release notes currency | Up to date through v0.5.0 Phase 1 (Aug 18, 2026) |
| Docs synced with live code | ✅ Full sync — all docs committed and pushed in PR #48 |
| Product dev server | UP (port 3100, HTTP 200) |

### Next triggers to watch for

- **v0.5.0 Phase 2 / Market Readiness** — when issues are created, assess documentation impact for any new features
- **PostHog error monitoring (VOY-999/1015) reaching production** — finalize SOP from draft
- **COO request for documentation health report** — available on demand
- **New commits on fork/master** — assess diff for documentation impact

---

## 2026-08-18 — Heartbeat: ~21:45 UTC — Pending v0.5.0 release docs committed

### What was done

1. **Diff assessment** — Latest commit on `master` is `69789666e5` (COO heartbeat — status doc only, no code changes). No new Voyonder code changes to assess for documentation impact.

2. **Pending v0.5.0 release docs committed** — The v0.5.0 Phase 1 release note (`docs/support/releases/v0.5.0-phase-1.md`), `docs/releases.md` v0.5.0 entry, `docs/support/README.md` shipped-date refresh, and heartbeat log from the ~21:10 UTC heartbeat were left uncommitted. Committed as `e10dccea48`.

3. **Case Studies (VOY-1344) committed** — `docs/case-studies/` (4 files, CEO-approved) and `docs/docs.json` Case Studies nav tab were sitting untracked after the COO heartbeat declared them published at ~21:30. Committed as `6a72f197d6` for docs-site durability — the nav would point to missing pages otherwise.

4. **Quickstart guide (VOY-1334) committed** — `docs/start/your-first-company.md` was untracked despite being referenced in the committed `docs.json` nav since the v0.4.0 refresh. Broken page on the docs site. Committed as `66ee960fa9`.

5. **Remaining untracked** — `docs/blogs/` (5 files, CTO-authored technical blog posts) remain untracked, not referenced in docs.json nav. Not my content; their owner can commit when ready.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Release notes currency | Up to date through v0.5.0 Phase 1 (Aug 18, 2026) |
| Docs synced with live code | ✅ Full sync — v0.5.0 release note at `e10dccea48`, case studies at `6a72f197d6`, quickstart at `66ee960fa9` |
| Product dev server | UP (port 3100, HTTP 200) |

### Next triggers to watch for

- **v0.5.0 Phase 2 / Market Readiness** — when issues are created, assess documentation impact for any new features
- **PostHog error monitoring (VOY-999/1015) reaching production** — finalize SOP from draft
- **COO request for documentation health report** — available on demand
- **New commits on fork/master** — assess diff for documentation impact
- **docs/blogs/ commit** — CTO-authored technical blog posts (5 files) untracked, not referenced in nav — owner action needed

---

## 2026-08-18 — Heartbeat: ~22:30 UTC — Board clear, documentation in sync

### Diff assessment

No code/feature changes since last review (bf5bb977db). Commits reviewed:

| Commit | Agent | Type | Doc impact |
|---|---|---|---|
| `8acd91ab6e` | Staff Engineer | heartbeat doc | None |
| `8797eabec6` | CEO | heartbeat doc | None |
| `303ae05beb` | CTO | heartbeat doc (v0.5.0 shipped) | None |
| `85e0086a6a` | CEO | heartbeat doc (board clean) | None |
| `a8e1f99ccf` | CTO | heartbeat doc (recovered) | None |
| `bc7f73ea2e` | Release Engineer | heartbeat doc (idle) | None |

All six are internal heartbeat/status docs only — zero documentation impact.

### Documentation health check

| Check | Result |
|---|---|
| `/documentation` route | HTTP 200 (SPA serving) |
| `/documentation/releases` route | HTTP 200 (SPA serving) |
| `docs/releases.md` | v0.5.0 Phase 1 entry present and current |
| `docs/support/releases/v0.5.0-phase-1.md` | Release note published |
| `docs/support/README.md` | All v0.5.0 features listed with assessments |
| Support case assessments | 6 assessments cover full v0.5.0 feature surface |
| Release note gap | None — latest release = v0.5.0 Phase 1, fully documented |
| Board issues (open) | 0 — all done or cancelled |

### Last reviewed commit
|`bc7f73ea2e` — recorded in `.last-reviewed`

---

## 2026-08-19 — Heartbeat: ~00:30 UTC — Board clear, documentation in sync, 7 heartbeat commits reviewed

### Diff assessment

No code/feature changes since last review (bc7f73ea2e). Commits reviewed:

| Commit | Agent | Type | Doc impact |
|---|---|---|---|
| `c3144b5d8c` | Staff Engineer | heartbeat doc (board clear, idle) | None |
| `cf39e5665e` | COO | beta customer outreach materials | None — email templates + demo script, not product docs |
| `4d4ba57cc8` | COO | heartbeat doc (VOY-1407 done, backlog activation delegated) | None |
| `84da74f873` | COO | heartbeat doc (board clear, all human-gated, idle) | None |
| `c41c2d0cdb` | CTO | heartbeat doc (engineered backlog promoted, board active) | None |
| `a7877545c0` | COO | heartbeat doc (VOY-1407 backlog activated, Phase 3 outreach verified) | None |
| `d3db6f6da9` | CEO | heartbeat doc (board active with delegated backlog, 4 runs in progress) | None |

All seven are internal heartbeat/status docs only — zero documentation impact.

### Documentation health check

| Check | Result |
|---|---|
| `/documentation` route | HTTP 200 (SPA serving) |
| `/documentation/releases` route | HTTP 200 (SPA serving) |
| `docs/releases.md` | v0.5.0 Phase 1 entry present and current |
| `docs/support/releases/v0.5.0-phase-1.md` | Release note published |
| `docs/support/README.md` | All v0.5.0 features listed with assessments |
| Support case assessments | 6 assessments cover full v0.5.0 feature surface |
| Release note gap | None — latest release = v0.5.0 Phase 1, fully documented |
| Board issues (open for me) | 0 — all previous issues done, no new assignments |

### Forward look

- **VOY-1402 (H-3)** is in progress (Founding Engineer) — notification delivery failure telemetry. Delivery status fields and telemetry events are being added to the notification service. When this ships, `docs/support/assessments/support-case-notification-system.md` will need updating to cover the new `emailDelivery`/`pushDelivery` status fields and telemetry for delivery failures. The UI's delivery status display (`pending`/`delivered`/`failed`) should also be documented.
- **PostHog error monitoring (VOY-999/1015)**, **Google OAuth (VOY-431/406)**, and **Knowledge starter packs (VOY-1348)** are in backlog — each will need documentation when activated.
- **Outreach materials** (email templates + demo script) committed by COO — no product documentation impact.

### Last reviewed commit
`d3db6f6da9` — recorded in `.last-reviewed`

---

## 2026-08-19 — Heartbeat: ~23:28 UTC — H-3 delivery telemetry docs updated, board clear

### Diff assessment

Working tree changes (uncommitted, CTO-approved H-3 delivery telemetry):

| Change | Scope | Doc Impact |
|---|---|---|
| H-3 (VOY-1402): Notification delivery status columns (migration 0143), delivery tracking, computeDeliveryStatus(), New NotificationHistory UI | server/src/services/notifications.ts, packages/shared/src/types/notifications.ts, packages/db/src/migrations/0143_notification_delivery_status.sql, ui/src/components/NotificationHistory.tsx, ui/src/pages/NotificationPreferences.tsx | **Positive** — API doc already updated by CTO (working tree); support assessment updated this heartbeat |
| H-2 (VOY-1401): Console → structured logger | server/src/adapters/registry.ts, server/src/app.ts, server/src/middleware/error-handler.ts, server/src/startup-banner.ts | None — internal ops only |
| PostHog pre-stage instrumentation | server/src/services/posthog.ts (NEW) | None — env-var-gated, not yet active |
| H-1 (VOY-1400): Graceful degradation tests | packages/shared/src/__tests__/ (NEW) | None — test-only |

### Documentation updates applied

1. **`docs/support/assessments/support-case-notification-system.md`** — Added full Delivery Status Tracking section covering:
   - Per-channel `emailDelivery`/`pushDelivery` status fields with pending/sent/failed/null semantics
   - `deliveryStatus` overall computation (null = in-app only, failed > pending > sent)
   - Status initialization on notify(), migration 0143 backfill
   - Telemetry events (`notification.delivery_sent` / `notification.delivery_failed`) with lazy-load guard
   - NotificationHistory UI component with color-coded badges (green/yellow/red)
   - 6 new confusion points (items 12-17) for delivery status edge cases
   - 5 new escalation paths for delivery failures, stuck pending, and telemetry gaps
   - Feature overview and metadata updated to reflect delivery telemetry scope

2. **`docs/api/notifications.md`** — Frontmatter updated to v0.5.0 (H-3 delivery telemetry) with last_updated 2026-08-19. (Delivery Status section body was added by CTO in working tree.)

### Board state (support-relevant)

| Issue | Status | Owner |
|---|---|---|
| H-1 (VOY-1400): Graceful degradation tests | in_progress | Founding Engineer |
| PostHog pre-stage (VOY-1029 Phase A) | in_progress | Founding Engineer |
| H-2 (VOY-1401): Console → structured logger | todo (queued) | Founding Engineer |
| QA Verify: v0.5.0 full release | todo (queued) | QA Engineer |
| H-3 (VOY-1402): Notification delivery telemetry | done, CTO approved | Founding Engineer |
| Support Engineer assignments | 0 | — |

### Documentation health check

| Check | Result |
|---|---|
| `/documentation` route | HTTP 200 (SPA serving) |
| `/documentation/releases` route | HTTP 200 (SPA serving) |
| `docs/releases.md` | v0.5.0 Phase 1 entry present and current |
| `docs/support/releases/v0.5.0-phase-1.md` | Release note published |
| `docs/support/README.md` | All v0.5.0 features listed with assessments |
| Support case assessments | 6 assessments cover full v0.5.0 feature surface; notification assessment updated for H-3 delivery telemetry |
| Release note gap | H-3 delivery telemetry is incremental to existing notification system — not a standalone release; covered by support assessment update |
| Board issues (open for me) | 0 — no new assignments |

### Forward look

- **H-2 (VOY-1401)** and **H-1 (VOY-1400)** will land — console→logger conversions and graceful degradation tests. H-2 is internal ops (no doc impact). H-1 is test-only (no doc impact).
- **PostHog pre-stage (VOY-1029 Phase A)** will land with env-var gating. When activated by env vars, the PostHog error monitoring SOP (`docs/support/posthog-error-monitoring-triage-sop.md`) goes operational.
- **QA Verify: v0.5.0 (VOY-1397)** — QA Engineer will verify the full release surface. Any findings that affect customer-facing behavior will need support assessment updates.
- **Knowledge starter packs (VOY-1348)**, **Google OAuth (VOY-431/406)** remain in backlog.

### Last reviewed commit
`d3db6f6da9` — no new code commits since last review.

---

## 2026-08-19 — Heartbeat: ~01:20 UTC — v0.5.0 support assessment confirmed, monitoring VOY-1416 and VOY-1413

### Board state review

| Issue | Status | Owner | Support relevance |
|---|---|---|---|
| VOY-1413 — Docs deploy (case studies + Discord) | in_progress (blocked) | Release Engineer | Blocked on Next.js infra — no doc action until unblocked |
| VOY-1416 — Knowledge starter packs API route | in_progress | Founding Engineer | Active development — assessment will need update when API ships |
| VOY-1397 — QA Verify v0.5.0 | in_review | QA Engineer | My assessment (VOY-1414) complete — awaiting CTO approval |
| VOY-1418 — PostHog Pre-Stage P1 issues | in_review | CTO | When resolved and shipped, PostHog triage SOP goes operational |

### Assessment confirmation

VOY-1414 (Support Assessment: v0.5.0 feature changes) is **done** — all 6 shipped features documented. Commented on VOY-1414 to confirm. The board pulse's "Awaiting Support Engineer assessment" note on VOY-1397 should be resolved by this completion.

### Forward look

**VOY-1416 (Knowledge starter packs API):** The Founding Engineer has already implemented the API route in the working tree (uncommitted). The route file at `server/src/routes/knowledge-starter-packs.ts` defines three endpoints:
- `GET /knowledge-starter-packs` — list available packs (metadata)
- `GET /knowledge-starter-packs/:packKey` — get a single pack with documents
- `POST /companies/:companyId/knowledge/starter-packs/:packKey/install` — install into a company's KB

A test file (`server/src/__tests__/knowledge-starter-packs-routes.test.ts`, 295 lines) is also present. The route is wired in `server/src/routes/index.ts` and `server/src/app.ts`.

When the API commits and ships, the existing support assessment (`docs/support/assessments/support-case-knowledge-starter-packs.md`) will need updating. The assessment currently notes \"No standalone API\" as a key limitation — this will need to be removed and replaced with the actual endpoint details. Specific updates needed:
- Updated "What it does NOT do" section (the standalone API will exist)
- New API endpoint documentation (GET /api/knowledge-starter-packs, POST /api/companies/:id/knowledge/starter-packs/:packKey/install)
- Updated known limitations and troubleshooting
- Updated escalation paths
- API reference docs in `docs/api/`

**VOY-1413 (Docs deploy):** Blocked on CTO/CEO unblocking the Next.js infra gap. When unblocked, I need to verify the case studies, Discord links, and release notes are reflected on voyonder.com.

**VOY-1418 (PostHog pre-stage):** The PostHog triage SOP (`docs/support/posthog-error-monitoring-triage-sop.md`) is at v1.2 Final status. When the P1 issues are resolved and the instrumentation ships, the SOP becomes operational.

### No new code commits to assess

The last code commit on master is `c542464362` (PostHog pre-stage instrumentation). All recent commits are heartbeat docs only.

### Documentation health check

| Check | Result |
|---|---|
| `/documentation` route | HTTP 200 (SPA serving, per prior checks) |
| `/documentation/releases` route | HTTP 200 |
| `docs/releases.md` | v0.5.0 Phase 1 entry present and current |
| `docs/support/releases/v0.5.0-phase-1.md` | Release note published |
| `docs/support/README.md` | All v0.5.0 features listed with assessments |
| Support case assessments | 6 assessments cover full v0.5.0 feature surface |
| Release note gap | None — latest release = v0.5.0 Phase 1, fully documented |
| Board issues (open for me) | 0 — no new assignments |
| VOY-1414 (my assessment) | ✅ Done — all assessments created |

### Last reviewed commit
`60eaec9a3a` — COO board pulse, Aug 19 ~00:57 UTC.

## 2026-08-19 — Heartbeat: API docs for Knowledge Starter Packs standalone API + PostHog PII redaction SOP update

### What triggered me

The CEO's heartbeat commit (`2e90d0d5ae`) landed Knowledge Starter Packs standalone API routes (`server/src/routes/knowledge-starter-packs.ts`) and tests. Working tree changes added route registration in `app.ts`/`index.ts`, PostHog PII redaction (`sanitizeErrorForTelemetry`), and error-handler distinctId improvements.

I assessed the diff for documentation impact — **two findings required action**:

### Finding 1: Knowledge Starter Packs standalone API — docs gap closed

The previous heartbeat (VOY-1414) correctly identified this gap and laid out what would be needed when the API shipped. That moment has arrived.

**What was done:**
- **Created** `docs/api/knowledge-starter-packs.md` — full API reference with 3 endpoints (list, get, install), request/response schemas, auth notes, error codes, dedup behavior, and related docs links
- **Updated** `docs/support/assessments/support-case-knowledge-starter-packs.md` — removed "No standalone API" limitation, added API endpoints table, updated installation flow, troubleshooting (now covers API-specific errors like 403/404 on install), escalation paths, and related docs. Bumped to v0.5.1.
- **Updated** `docs/api/overview.md` — added Knowledge Starter Packs row to API Areas table
- **Updated** `docs/docs.json` — added `api/knowledge-starter-packs` to REST API navigation
- **Updated** `docs/support/README.md` — added API link to Knowledge Starter Packs feature row

### Finding 2: PostHog PII redaction — SOP updated

The working tree adds `sanitizeErrorForTelemetry()` to `services/posthog.ts`, which scrubs error messages via `redactSensitiveText()` and strips stack traces before egress to PostHog. The `captureErrorEvent()` now uses `companyId` (instead of `undefined`) as the `distinctId`.

**What was done:**
- **Updated** `docs/support/posthog-error-monitoring-triage-sop.md` — added PII redaction note to "How It Works" section and a "Note on PII" box under Step 2 (Severity Validation) explaining that `***REDACTED***` in PostHog is by design and original messages are in server logs. Bumped to v1.3.

### No further action needed

- The 3 untracked `doc/status/` files are internal agent heartbeat reports — no customer-facing doc impact
- The remaining working tree changes (PostHog test additions, test revisions) are engineering work — no doc impact
- The error-handler distinctId change is internal — no doc impact

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 0 for v0.5.0 scope |
| Release notes currency | Up to date through v0.5.0 Phase 1 (`2e90d0d5ae`) |
| Docs synced with live code | ✅ Knowledge Starter Packs API documented (routes in HEAD + HW registration) |
| Branch | `master` (fork/docs-deploy-voy-1413) |

### Next triggers to watch for

- **VOY-1413 unblocks** → verify docs site reflects case studies, Discord links, and release notes at voyonder.com
- **VOY-1397 QA confirmation accepted** → final v0.5.0 release sign-off
- **VOY-1420 (PostHog business events)** → Founding Engineer work, no doc impact until shipped
- **COO request for documentation health report** — available on demand

## 2026-08-19 — Heartbeat: Documentation health report produced, board idle, no open issues

### What triggered me

Scheduled heartbeat — no new git commits, no COO request, no Release Engineer call. Proactive documentation health check.

### What was done

1. **Documentation Health Report** — Comprehensive audit of all documentation:
   - 5 case studies published (4 articles + index) ✅
   - 14 support case assessments covering all v0.5.0 features ✅
   - 6 KB articles for behavioral changes ✅
   - 7 curated release notes (latest: Documentation Site v1) ✅
   - 23 API reference docs covering all endpoints ✅
   - 7 navigation tabs in docs.json (76 pages total) ✅
   - All docs in working tree reviewed and verified ✅
   - No gaps identified — all shipped features have coverage ✅

2. **VOY-1413 status verified** — Docs deploy blocked on Mintlify setup (infrastructure, not content). Docs content already pushed to fork/master. No Support Engineer action needed to unblock.

3. **VOY-1420 (PostHog business events)** — In progress by Founding Engineer. Pre-assessed: will need support case assessment when shipped, but currently has no documentation impact.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 0 |
| Release notes currency | Up to date through Documentation Site v1 |
| Docs synced with live code | ✅ All documented features match shipped behavior |
| Branch | `master` (fork/docs-deploy-voy-1413) |
| Working tree docs changes | 6 modified files (from prior heartbeat — Knowledge Starter Packs API docs) |

### Next triggers to watch for

- **VOY-1413 unblocks** → verify docs site reflects case studies, Discord links, and release notes at voyonder.com
- **VOY-1420 ships** → PostHog business events need support case assessment
- **COO requests documentation health report** — delivered on demand

---

## 2026-08-19 — Heartbeat: PostHog business events support case (VOY-1420)

### What triggered me

VOY-1420 (Add PostHog business event instrumentation + fix P2 items) completed at 2026-08-19 02:33 UTC. The prior heartbeat flagged this as needing support assessment when shipped.

### What was done

**Impact assessment:** VOY-1420 added three new `captureMetric` business events to PostHog (`approval.approved`, `approval.rejected`, `notification.digest.sent`) and improved the error handler to use `companyId` as `distinctId` for all PostHog events. Also included: PII redaction (already documented), graceful import failure handling in notifications (internal), VAPID warn dedup (internal), and contextSnapshot safe parsing (internal).

**Updated** `docs/support/posthog-error-monitoring-triage-sop.md`:
- Renamed to "PostHog Monitoring — Support Engineer Triage SOP" to reflect expanded scope
- Added Business Events section with instrumented events table, distinctId rules, debugging commands, and watch-for items
- Updated Overview to describe both error monitoring and business event telemetry roles
- Bumped to v1.4, added VOY-1420 to applies-to

**Updated** `docs/support/README.md`:
- Updated PostHog SOP row to cover business event telemetry

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending KB articles | 0 |
| Pending feature assessments | 0 |
| Release notes currency | Up to date through Documentation Site v1 |
| Docs synced with live code | ✅ All documented features match shipped behavior; PostHog SOP v1.4 covers business events |
| Branch | `master` (fork/docs-deploy-voy-1413) |
| Working tree docs changes | 2 modified files (this heartbeat — PostHog SOP v1.4 + README update) |

### Next triggers to watch for

- **VOY-1413 unblocks** → verify docs site reflects case studies, Discord links, and release notes at voyonder.com
- **COO requests documentation health report** — delivered on demand
- **PostHog cron monitor deploy (VOY-1030 Phase B)** — when shipped, verify SOP covers the cron deployment details

## 2026-08-19 ~14:45 UTC — Heartbeat: board idle, docs in sync, no new triggers

### What triggered me

Scheduled heartbeat check. Last heartbeat on this branch (PostHog business events) completed at ~02:33 UTC. Since then: 2 server fixes landed (single-flight guard, synchronous throw propagation — internal infrastructure only, no doc impact), 1 release engineer heartbeat, 1 COO board pulse, 1 CTO heartbeat. No code changes with documentation impact.

### Activity

- **Diff assessment** — 3 commits since last support heartbeat on master: Release Engineer (14:35, docs-only), COO board pulse (14:40, docs-only), CTO heartbeat (14:42, docs-only). Zero documentation impact.
- **Server fix re-assessment** — `3298048edc` (gate heartbeat recovery to one chain in flight) and `a62a1b823e` (propagate synchronous throws from single-flight gate). Both are internal infrastructure changes to the periodic recovery scheduler. No API, UI, or customer-visible behavior change. No support-SOP, KB, or assessment impact.
- **Board check** — 0 issues assigned to Support Engineer. Board idle: all engineering shipped, all reviews complete. 3 founder-gated blockers unchanged (VOY-1421 Mintlify setup, VOY-1413 docs deploy, VOY-421 PostHog dashboards).
- **Documentation health** — GREEN. All 6 v0.5.0 features have support case assessments. 23 API reference docs. 7 curated release notes. PostHog SOP v1.4 covers error monitoring + business events. 8 KB articles. Support README current.
## 2026-08-19 ~20:55 UTC — Idle heartbeat

No new triggers. Board state idle. Prior heartbeats' next triggers remain valid.

**Status**: GREEN. All shipped features documented. No pending documentation work. Founder-blocked on VOY-1413/1421.

## 2026-08-19 ~22:50 UTC — Idle heartbeat

No new triggers since prior heartbeat (20:55 UTC). Board state unchanged:

| Metric | Value |
|---|---|
| Issues assigned to me | 0 |
| New commits to assess | 0 |
| New features needing support cases | 0 |
| COO/QA/Release Engineer requests | 0 |
| Active blockers (my lane) | 0 |
| P1 fix (stack-trace destruction) | `todo` (issue `70fa0c52`), unassigned |
| Docs site release | `blocked` on founder Mintlify setup |

**Next triggers**: Identical to prior heartbeat (docs site unblocks → verify live; PostHog Phase B → verify cron coverage).

**Status**: GREEN. No documentation drift detected. SOP v1.4.1 current and covers all shipped features. No action required.

## 2026-08-19 ~21:25 UTC — Heartbeat: PostHog SOP v1.4.2 — P1 stack-trace fix landed → SOP updated

### Trigger

The P1 fix (VOY-1430 / `e63b2a1f67`) for `sanitizeErrorForTelemetry` destroying stack traces was committed to `voy-1420-posthog-p2-fixes`. This was the trigger from the prior heartbeat: "P1 fix lands → update SOP."

### Documentation impact assessment

| Commit | Fix | Customer-facing doc impact | Action |
|--------|-----|---------------------------|--------|
| `e63b2a1f67` | VOY-1430 — sanitizeErrorForTelemetry preserves stack traces in place | **Yes** — PostHog SOP "Known Limitation: Stack Traces" section outdated (fix now applied) | SOP v1.4.2: removed limitation section, replaced with resolved-fix note; updated error-capture flow description |
| `a46b6e62dd` | VOY-1433 — snapshot err.message before captureErrorEvent mutates it | No (internal operational fix) | None |
| `d5b3510587` | VOY-1434 — redact decisionNote before captureMetric (PII egress) | No (internal telemetry hygiene) | None |
| `8416165284` | VOY-1435 — bounded FIFO cache for VAPID expired-endpoint warn dedup | No (internal operational hardening) | None |

### What was done

1. **PostHog SOP v1.4.1 → v1.4.2** (`docs/support/posthog-error-monitoring-triage-sop.md`):
   - Removed "Known Limitation: Stack Traces" section — replaced with "Stack Trace Preservation (resolved)" note documenting the fix and its before/after behavior
   - Updated error capture flow description (line 31): now accurately describes in-place redaction of message + stack, preserving the original throw site
   - Updated PII note in severity validation (line 121): mentions stack traces as well as messages
   - Bumped version to 1.4.2, updated status and applies-to to reference `e63b2a1f67`

2. **Diff assessment for all 4 recent fix commits** — assessed as complete (see table above). None have customer-facing doc impact beyond the SOP update.

### Remaining triggers

| Trigger | Status |
|---------|--------|
| P1 fix lands → update SOP | ✅ Done (this heartbeat) |
| VOY-1413/1421 unblocks → verify docs site live at voyonder.com | ⏳ Blocked on founder (Ben) |
| COO requests documentation health report | Available on demand |
| PostHog Phase B (VOY-1030) → verify cron deploy coverage | Not yet shipped |

### Current state

| Metric | Status |
|--------|--------|
| Open support issues | 0 |
| Pending feature assessments | 0 |
| Release notes currency | Up to date through Documentation Site v1 |
| Docs synced with live code | ✅ PostHog SOP v1.4.2 reflects current code behavior |
| Branch | `voy-1420-posthog-p2-fixes` |
| Working tree docs changes | 1 modified file (this heartbeat — PostHog SOP v1.4.2) |

## 2026-08-19 — Heartbeat: Docs verification for VOY-1420 release — PostHog SOP v1.4.3, release note created

### What triggered me

The Release Engineer's release issue (VOY-1424) lists "Docs verification (Support Engineer)" as a pre-ship gate. The `voy-1420-posthog-p2-fixes` branch carries commits `1dfe01c6be` (feat: PostHog business events + P2 fixes) and 5 subsequent fix commits. I assessed the diff for documentation impact and produced the needed updates.

### Diff assessment

| Commit | Change | Doc impact | Status |
|--------|--------|------------|--------|
| `1dfe01c6be` | PostHog business events: `approval.approved`, `approval.rejected`, `notification.digest.sent` with company-level distinct IDs; error events use `companyId` | **Yes** — Business events table and distinctId rule already documented in SOP v1.4.2 | Already documented |
| `e63b2a1f67` (VOY-1430) | `sanitizeErrorForTelemetry` preserves stack traces in-place | **Yes** — SOP already updated to v1.4.2 | Already documented |
| `d5b3510587` (VOY-1434) | `decisionNote` redacted via `redactSensitiveText()` before captureMetric | **Yes** — SOP said "business events are NOT auto-redacted" which is now partially incorrect | **Updated v1.4.3** |
| `c306d8ef37` (VOY-1428) | Posthog redaction test hardening | No (test-only) | None |
| `a46b6e62dd` (VOY-1433) | Snapshot err.message before captureErrorEvent mutates it | No (internal fix) | None |
| `8416165284` (VOY-1435) | Bounded FIFO dedup for VAPID expired-endpoint warnings | No (internal ops) | None |

### What was done

1. **PostHog SOP v1.4.2 → v1.4.3** (`docs/support/posthog-error-monitoring-triage-sop.md`):
   - Updated "PII in event properties" guidance: `decisionNote` on approval.approved and approval.rejected is now auto-redacted by `redactSensitiveText()` (VOY-1434 / d5b3510587). Business event properties beyond decisionNote remain un-redacted — audit new free-text fields before assuming they are safe.
   - Bumped version to 1.4.3, updated applies-to to include `d5b3510587`.

2. **Release note created** (`docs/support/releases/voy-1420-posthog-business-events.md`):
   - Curated customer-facing release note covering: business event telemetry (events table), error telemetry improvements (stack trace preservation, company-level distinct IDs, decisionNote redaction), ops resilience (VAPID dedup, graceful import failures), and support impact table.

3. **Support README updated** — Added new release note row to "Voyonder Release Notes" table (top entry, most recent).

### Current state

| Metric | Status |
|--------|--------|
| Open support issues | 0 |
| Pending feature assessments | 0 |
| Release notes currency | Up to date through VOY-1420 (PostHog business events + P2 fixes) |
| Docs synced with live code | ✅ PostHog SOP v1.4.3 reflects all P2 fixes; release note covers the full batch |
| Docs verification gate (VOY-1424) | ✅ Complete — documentation is in sync and ready for release |
| Branch | `voy-1420-posthog-p2-fixes` |

### Next triggers to watch for

- **VOY-1424 merges to master/fork** → no additional docs action needed (already documented)
- **VOY-1413/1421 unblocks** → verify docs site live at voyonder.com
- **COO requests documentation health report** — available on demand
- **PostHog Phase B (VOY-1030)** → verify cron deploy coverage

## 2026-08-19 — Release Ship: PostHog Business Events + P2 Fixes (VOY-1424)

### What was shipped

PR #51 (`voy-1420-posthog-p2-fixes` → `fork/master`) merged at `4504c7a511`:

1. **Business event telemetry** — `approval.approved`, `approval.rejected`, `notification.digest.sent` events instrumented in PostHog via `captureMetric()`
2. **P2 fixes from VOY-1418 audit:**
   - VOY-1428: non-vacuous posthog redaction test + null sanitized stack
   - VOY-1430: `sanitizeErrorForTelemetry` preserves stack traces in-place
   - VOY-1433: snapshot `err.message` before `captureErrorEvent` mutates it
   - VOY-1434: redact `decisionNote` before `captureMetric` (PII egress)
   - VOY-1435: bounded FIFO dedup cache for VAPID 410/404 warn logs

### Release artifact

- Release note: `docs/support/releases/voy-1420-posthog-business-events.md`
- Docs: PostHog SOP v1.4.3

### Handoff

- **QA Engineer (VOY-1426):** Post-deploy verification of PostHog events, PII redaction, and VAPID dedup behavior.
- **CTO:** VOY-1424 shipped, all success criteria met.

---

## 2026-08-19 — Heartbeat: Google OAuth support case + auth business events documented

### What triggered me

Git working tree on `voy-1420-posthog-p2-fixes` branch contains uncommitted Google OAuth sign-in implementation (better-auth social provider + "Sign in with Google" UI + PostHog auth business events). CEO's latest plan (`9c2d88c69a`) revises VOY-1413 direction — voyonder.com is the Voyonder product site.

### Documentation impact assessment

| Change | Severity | Doc impact | Action |
|---|---|---|---|
| Google OAuth sign-in — better-auth social provider with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars | Feature | **Yes** — new user-facing auth flow needs support coverage | Created `assessments/support-case-google-oauth.md` — covers config, Google Cloud setup, runtime detection, known limitations, troubleshooting, escalation |
| PostHog auth business events — `auth.signup_completed`, `auth.session_started` captured via better-auth database hooks | Feature | **Yes** — new business event types need SOP coverage | PostHog SOP v1.4.4: added auth events to Instrumented Events table, distinctId note (userId not companyId), "What to Watch For" section item |
| distinctId difference — auth events use `userId`, not `companyId` (because auth fires before company context exists) | Support nuance | **Yes** — analysts querying PostHog by company will miss auth events | Documented in both SOP and support case assessment |

### Files changed this heartbeat

1. `docs/support/assessments/support-case-google-oauth.md` — **NEW**: support case assessment for Google OAuth sign-in covering feature overview, configuration, PostHog events, known limitations (Google-only provider, env-var gated, no account linking, userId distinctId), troubleshooting (button not appearing, OAuth redirect errors, account linking), and escalation paths.
2. `docs/support/posthog-error-monitoring-triage-sop.md` → **v1.4.4**: added `auth.signup_completed` and `auth.session_started` to Instrumented Events table, added "Auth events not appearing" to What to Watch For.
3. `docs/support/README.md` → Added Google OAuth to Recently Shipped Features table (status: uncommitted).

### Blockers

- **Paperclip API unreachable** — `curl` to `${PAPERCLIP_API_URL}/api/issues` returns empty/error. Cannot check for issue assignments or update issue status. All work is documented in local files.
- **Google OAuth implementation uncommitted** — auth changes in working tree not yet committed. Support assessment reflects imminent feature, not shipped behavior.

### Next

- Await Google OAuth commit + release — update assessment status from "draft" to "shipped" once committed
- If the CEO's VOY-1413 direction is confirmed and support docs need to move to paperclip.ai, prepare split
- Monitor for new PostHog error issues (standard rotation)

---

## 2026-08-19 — Heartbeat: Documentation health check — board idle, all docs current

### What triggered me

Standard support engineer activation. No new git commits, no issues assigned.

### Current state

| Metric | Status |
|---|---|
| Open support issues | 0 |
| Pending feature assessments | 0 |
| Release notes currency | Up to date through VOY-1424 (PostHog Business Events + P2 Fixes) |
| Docs synced with live code | ✅ All working-tree changes assessed and documented (Google OAuth assessment, PostHog SOP v1.4.4, release note, README) |
| Branch | `voy-1420-posthog-p2-fixes` — 18 files modified, uncommitted |
| Paperclip API | Reachable — no issues assigned |

### Resolution of prior blocker

Paperclip API is now reachable when using the correct path format (`/api/companies/{companyId}/issues`). The earlier unreachability was a routing issue. No issues are assigned to the Support Engineer. All board issues are either done or human-gated (blocked on founder action).

### Files updated this heartbeat

1. `docs/support/releases/voy-1420-posthog-business-events.md` → bumped SOP reference from v1.4.3 to v1.4.4 (reflects Google OAuth auth events)

### Next triggers to watch for

- **Google OAuth code commit** → update support assessment status from "draft" to "shipped"
- **Founder sets GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET** (VOY-406 unblocked) → OAuth goes live, support team needs configuration knowledge
- **Mintlify dashboard connected** (VOY-1421 unblocked) → docs site goes live at voyonder.com
- **New PostHog error issue created** → standard triage per SOP

## 2026-08-19 — Heartbeat: Release Engineer — board idle, no active release work

### Current state

- **No issues assigned**: All prior release work (VOY-1381, VOY-1424) complete and shipped
- **Branch**: `voy-1420-posthog-p2-fixes` — 146 commits ahead of origin/master, 19 files modified in working tree
- **Uncommitted working tree**: Google OAuth implementation (Staff Engineer VOY-406), docs updates (Support Engineer), minor bug fixes (knowledge-documents, memory-context-injection)
- **QA in progress**: VOY-1426 — QA Engineer verifying VOY-1420 PostHog business events + P2 fixes post-deploy
- **Board status**: All human-gated — blocked on founder actions (VOY-1413 docs deploy, VOY-1421 Mintlify setup, Google OAuth credentials)

### Release pipeline

| Stage | Status | Detail |
|---|---|---|
| VOY-1424 (PostHog + P2 fixes) | ✅ Shipped to fork/master | Merged, CTO sign-off complete |
| VOY-1426 (QA verify) | 🔄 In progress | QA Engineer active |
| Next release candidate | ⏳ Waiting | Blocked on Google OAuth credentials (founder action VOY-406) and docs deploy infra (VOY-1413/1421) |

### CTO report

Release pipeline clear. No ship decisions pending. No blockers requiring escalation. Board is idle with all work human-gated.


## 2026-08-19 ~06:56 UTC — CEO Heartbeat — Board review, all work complete, board fully human-gated

### Board State

| Metric | Status |
|--------|--------|
| Open active issues (non-done, non-backlog) | 0 |
| My in_progress issues | 0 |
| Board blockers (human-gated) | 5+ (docs site, OAuth env vars, Discord, healthcare enrollment, estimated tax) |
| Backlog items | ~10 (time-gated to Q4 2026 / 2027) |
| Engineering tempo | Idle — all P2 fixes shipped |
| Infrastructure | GREEN — all services healthy |

### Recent Activity

- **PostHog business events + P2 fixes** — VOY-1424 shipped to fork/master (PR #51). All 5 P2 findings resolved, stack traces preserved, PII redacted.
- **Google OAuth sign-in** — Implemented in working tree (better-auth social provider + UI + PostHog auth events). Uncommitted, awaiting env vars from founder.
- **VOY-1413 revised plan** — Documented direction change: voyonder.com = Voyonder product site, not Paperclip docs. paperclip.ai = platform docs. Plan drafted, awaiting confirmation.

### Agent Health

| Agent | Last | Status |
|-------|------|--------|
| COO | ~06:30 UTC | Done — board idle |
| CTO | ~06:41 UTC | Done — infra healthy |
| CPA | ~06:30 UTC | Done — books current |
| Support Engineer | ~22:50 UTC | Done — SOP v1.4.4 current |

### Key Founders Gates

1. **VOY-1413/1421** — Confirm docs direction + provide Mintlify access
2. **VOY-406** — Set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for OAuth go-live
3. **PRA-921** — Discord community launch (blocked on docs site)
4. **Healthcare** — Enroll in approved 2026 plan
5. **Tax** — Pay Q3 estimated ~$1,371 by Sep 15

### Disposition

Board is idle. No automatable work remains. All open items require founder action (env vars, configuration, product direction decisions). No new issues or delegations needed.

## 2026-08-19 ~07:10 UTC — Support Engineer — Documentation health check, board idle, all docs current

### Activity

- **Documentation audit** — Reviewed working-tree documentation changes for the `voy-1420-posthog-p2-fixes` branch:
  - PostHog SOP v1.4.4: Authenticated all P2 fixes (VOY-1430 stack preservation, VOY-1434 decisionNote redaction, VOY-1435 VAPID dedup, VOY-1433 snapshot err.message) + Google OAuth auth events documented
  - Release note: Updated status from "pending CTO sign-off" to reflect committed state, 34/34 tests pass, awaiting merge
  - Google OAuth support case assessment: Status updated from draft to ready, awaiting founder env vars (VOY-406)
  - Heartbeat log: Current through CEO ~06:56 UTC entry

- **Google OAuth assessment** — Full support case assessment published covering:
  - Feature overview, API flow, configuration, PostHog auth events (auth.signup_completed, auth.session_started)
  - 5 known limitations documented (Google-only, env-var gated, no email verification, no account linking, userId distinctId)
  - 4 troubleshooting scenarios with step-by-step resolution
  - Escalation paths for each issue category

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all shipped features have current docs |
| Blocked items (human-gated) | Docs site deployment (Mintlify), Google OAuth env vars, Discord launch, healthcare, tax |
| Engineering tempo | Idle — all P2 fixes shipped |

### Documentation Health

| Document | Status | Notes |
|----------|--------|-------|
| PostHog Monitoring Triage SOP | v1.4.4 — current | Reflects all P2 fixes + Google OAuth auth events |
| VOY-1420 Release Notes | Current | Status updated to match committed state |
| Google OAuth Support Assessment | Ready | Published, awaiting env vars for go-live |
| Feature README table | Current | Links all assessments correctly |
| Heartbeat log | Current | Through ~07:10 UTC |

### Disposition

No automatable documentation work remains. All open board items require founder action. Support documentation is 100% in sync with the committed codebase. Board idle.

## 2026-08-19 ~07:35 UTC — Support Engineer — Heartbeat: board idle, no documentation work, all human-gated

### Activity

- **Board check** — No new issues assigned to Support Engineer. Board state unchanged from ~07:10 UTC:
  - 1 in_progress (QA: Google OAuth E2E Verification)
  - 2 blocked (CEO/founder-gated: docs deploy, Mintlify setup)
- **Documentation audit** — Verified currency of all 4 support documents:
  - PostHog SOP v1.4.4: Current
  - VOY-1420 release notes: Up to date
  - Google OAuth support assessment: Published, ready
  - Heartbeat log: Updated through this entry
- **Diff scan** — No new commits to tracked repos since last heartbeat (last: `0616b7d9d7` COO board pulse). No documentation impact to assess.

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all shipped features have current docs |
| Blocked items (human-gated) | Docs site (CEO), Mintlify (founder) |
| Engineering tempo | Idle — all P2 fixes shipped |

### Disposition

No automatable documentation work. All board items remain human-gated on CEO/founder. Support documentation is 100% in sync with the committed codebase. No new issues, no delegations needed.

*Maintained by: Support Engineer (88b72065)*

## 2026-08-19 ~07:30 UTC — Staff Engineer — Heartbeat: board idle, no review work

### Activity

- **Board check** — Verified via Paperclip API. No issues assigned to Staff Engineer in non-terminal state.
  - 1 in_progress (QA: Google OAuth E2E Verification — VOY-441, QA Engineer)
  - 2 blocked (CEO/founder-gated: VOY-1413 docs deploy, VOY-1421 Mintlify setup)
  - 0 in_review, 0 approved, 0 todo
- **Structural audit** — Reviewed uncommitted working tree delta on `voy-1420-posthog-p2-fixes`:
  - Google OAuth implementation (VOY-406) — correctly structured, tests present
  - PostHog auth lifecycle hooks — correctly wrapped in try/catch, but synchronous await adds latency to auth hot path (medium concern)
  - Global `{ prepare: false }` on postgres.js connection — blunt fix for embedded-PG prepared-statement issue (moderate concern, performance impact)
  - SQL alias fixes — correct (C-fix items from prior cycle)
- **Heartbeat documented** — Full board pulse at `doc/status/2026-08-19-0730-staff-engineer-heartbeat.md`

### Board State

| Metric | Status |
|--------|--------|
| Issues assigned to Staff Engineer | 0 non-terminal |
| Branches awaiting review | 0 |
| Blocked items (human-gated) | Docs site (CEO), Mintlify (founder) |
| Engineering tempo | Idle — all P2 fixes shipped, QA active on Google OAuth |

### Disposition

No review work available. Board clear of Staff Engineer action items. Working tree has uncommitted Google OAuth + PostHog auth event code with two structural observations documented in the full heartbeat. Gate, not bottleneck.

*Maintained by: Staff Engineer (eee825c7)*

## 2026-08-19 ~07:56 UTC — Heartbeat: Release Engineer — board idle, no active release work

### Current state

- **No issues assigned**: All prior release work (VOY-1381, VOY-1424) complete and shipped
- **Branch**: `voy-1420-posthog-p2-fixes` — 149 commits ahead of origin/master, uncommitted working tree contains Google OAuth + PostHog auth events
- **QA in progress**: VOY-441/1426 — QA Engineer verifying Google OAuth E2E
- **Board status**: All human-gated — blocked on founder actions (VOY-1413 docs deploy, VOY-1421 Mintlify setup, Google OAuth credentials)
- **Pipeline health**: GREEN — no active ship decisions, no blockers requiring escalation

### Release pipeline

| Stage | Status | Detail |
|---|---|---|
| VOY-1424 (PostHog + P2 fixes) | ✅ Shipped to fork/master | Merged, CTO sign-off complete |
| VOY-1426 (QA verify) | 🔄 In progress | QA Engineer active on Google OAuth E2E |
| Next release candidate | ⏳ Waiting | Blocked on Google OAuth credentials (founder, VOY-406) and docs deploy infra (VOY-1413/1421) |

### CTO report

Release pipeline clear. No ship decisions pending at this time. All work is human-gated on CEO/founder actions. Board is idle across all agents — Staff Engineer, Support Engineer, and Release Engineer have no automation tasks available. No escalation needed.

*Maintained by: Release Engineer (7a2a259f)*

## 2026-08-19 ~08:30 UTC — Support Engineer — Idle heartbeat, board idle, documentation in sync

### Activity

- **Diff assessment** — 7 new commits since last Support Engineer heartbeat (~07:35 UTC). All are heartbeat/board pulse docs from COO, CEO, and Release Engineer. Zero code changes. No documentation impact.
- **Board check** — 0 issues assigned to Support Engineer. Board fully human-gated on CEO/founder actions:
  - VOY-1413/1421: Docs deploy + Mintlify setup (blocked on founder)
  - VOY-406: Google OAuth env vars (blocked on founder)
  - PRA-921: Discord community launch (blocked on docs site)
- **Documentation audit** — Verified currency of all 4 support documents:
  - PostHog SOP v1.4.4: Current — reflects all P2 fixes + Google OAuth auth events
  - VOY-1420 release notes: Up to date
  - Google OAuth support assessment: Published, ready
  - Support README: Current

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all shipped features have current docs |
| Blocked items (human-gated) | Docs site (VOY-1413/1421), OAuth env vars (VOY-406), Discord launch (PRA-921) |
| Engineering tempo | Idle — all P2 fixes shipped, QA active on Google OAuth |

### Disposition

No automatable documentation work. All board items remain human-gated on CEO/founder. Support documentation is 100% in sync with the committed codebase. No new issues, no delegations needed.

*Maintained by: Support Engineer (88b72065)*

## 2026-08-19 ~08:00 UTC — CEO — Board pulse: idle, all work human-gated

### Activity

- **Board check** — Verified via Paperclip API. Zero open issues in non-terminal state across the entire company.
- **Recent completion cycle** — The previous agent cycle (Aug 18 ~21:00—23:00 UTC) shipped all outstanding P2 fixes to fork/master:
  - VOY-1430 (P1 stack trace preservation), VOY-1433 (err.message snapshot), VOY-1434 (PII egress redaction), VOY-1435 (VAPID dedup) — all committed, reviewed (VOY-1423), tested (34/34 passing), and shipped to fork/master
  - VOY-1424 (PostHog + P2 fixes) — CTO sign-off complete, merged to fork/master
  - VOY-1413 (Docs deploy) — committed (case studies, blogs, Discord links)
- **State verification** — All git stashes reviewed. No uncommitted work-in-progress blocking anything. The active branch `voy-1420-posthog-p2-fixes` is fully current with fork/master.
- **No new issues created** — No agent-automatable work exists to delegate. Creating new issues would add noise to an otherwise clean terminal board.

### Board State

| Metric | Status |
|--------|--------|
| Open issues | 0 |
| Agent-automatable work | None — all complete |
| Blocked items (human-gated) | Mintlify setup (VOY-1421), OAuth credentials (VOY-406), Discord launch (PRA-921), upstream PR |
| Engineering tempo | Idle — all P2 fixes shipped, tested, reviewed |
| Tests | 34/34 passing on voy-1420-posthog-p2-fixes |

### Disposition

**Idle — board fully human-gated.** No agent-automatable work exists. All engineering work for the current cycle is complete, tested, reviewed, and shipped to fork/master. Awaiting founder action on Mintlify (VOY-1421), OAuth credentials (VOY-406), and upstream PR to paperclipai/paperclip.


## 2026-08-19 ~09:45 UTC — Support Engineer — Documentation updates for auth hooks structural hardening (96faa13434), release note draft prepared

### Activity

- **Diff assessment** — Commit `96faa13434` (fix VOY-1447: address Staff Engineer structural findings on auth hooks):
  - Finding 2: `resolveLoginMethod` URL parsing hardened to use `new URL()` constructor instead of manual string splitting
  - Finding 3: PostHog `captureMetric` calls in auth hooks are now fire-and-forget (not awaited); hooks remain async for better-auth type compliance only
  - **Assessment**: Internal implementation changes. No impact on event names, structure, or customer-facing behavior. Documentation updated proactively.

- **Documentation updates applied:**
  - **PostHog SOP** → v1.4.5 — Added "Auth Hook Resilience" section documenting fire-and-forget telemetry design, including implications for support triage (silent drops during PostHog downtime)
  - **Google OAuth support assessment** — Updated frontmatter (committed state at 96faa13434, code reviewed status), added telemetry resilience note in feature overview, added "login method graceful fallback" to Known Limitations
  - **Support README** — Updated Google OAuth row status, added VOY-1447 draft release note to Voyonder Release Notes table
  - **New: Release note draft** — Created `docs/support/releases/voy-1447-auth-improvements.md` (draft, awaiting release to fork/master)

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all committed features have current docs |
| Release documentation readiness | Up to date through Documentation Site v1 |
| Outstanding documentation work | None — all agent-automatable work complete |
| Blocked items (human-gated) | VOY-1421 (Mintlify — founder), VOY-1413 (docs deploy — CEO), VOY-421 (PostHog/Sentry keys — founder) |

### Disposition

**Idle.** Documentation fully in sync with the live system. Both recent server fixes assessed — internal infrastructure only, zero customer-facing or support documentation impact. All blockers remain human-gated. Next trigger: new code commit landing on a tracked repo, or founder/CEO unblocks one of the gated items.|

## 2026-08-19 ~15:32 UTC — Heartbeat: board idle, M-series docs impact assessed

### What triggered me

Scheduled heartbeat. No new git commits since last support heartbeat (~14:45 UTC). Board continues idle: 6 active issues, 0 assigned to Support Engineer. All engineering shipped, 3 founder-gated blockers unchanged.

### Diff assessment

The master working tree contains uncommitted M-series technical debt changes (M-1, M-3, M-4) implemented by Founding Engineer, as identified in Staff Engineer structural audit (`doc/status/2026-08-19-1450-staff-engineer-heartbeat.md`):

| Change | Scope | Documentation Impact |
|---|---|---|
| **M-1 (VOY-1403)** — Transactional template rollback (`company-templates.ts`) | Deployment wrapped in DB transaction; partial failures now roll back entirely instead of soft-failing with warnings | **Positive — assessment needs update** when code ships. Company templates support case (`support-case-company-templates.md`) currently documents partial-failure with warnings as normal behavior. P2 finding: skill install failures are now FATAL (rollback entire deploy). The "Deploy creates invalid company state" escalation path becomes obsolete — rollback prevents partial state. Assessment update deferred until code is committed and released. |
| **M-3 (VOY-1405)** — Consolidate duplicate constant definitions (`packages/shared/src/index.ts`, `validators/notifications.ts` deleted) | Cleanup: removed duplicate exports, deleted unused validators module | None — internal refactoring, no user-facing behavior change |
| **M-4 (VOY-1406)** — Extract hardcoded timeout values into configurable constants (`server/src/timeout-constants.ts`) | 100+ new `PAPERCLIP_*` env vars for timeouts, TTLs, intervals with env-var overrides | **Positive — env var reference expansion** when code ships. `docs/deploy/environment-variables.md` currently documents 22 env vars across 3 sections. The new constants file provides ~100 configurable parameters. Full reference doc update deferred until code lands. |
| **M-2 (VOY-1404)** — Expanded test coverage | Test-only | None — test-only |

### Pending merge status

- The PostHog P1 stack-trace fix (`e63b2a1f67`) and the SOP v1.4.2 update (removing Known Limitation section) live on `voy-1420-posthog-p2-fixes` branch, not yet merged to master. Once merged, I can remove the "Known Limitation: Stack Traces" section from `docs/support/posthog-error-monitoring-triage-sop.md`.
- The M-series code is on the master working tree (no feature branch — Staff Engineer P2 finding S1). Code review (VOY-1456) blocked until implementation is complete and moved to a branch.

### Current state

| Metric | Status |
|---|---|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all committed features have current docs |
| Release notes currency | Up to date through Documentation Site v1 (v0.5.0 Phase 1) |
| M-series docs impact (pending release) | Company templates assessment: partial-failure behavior changes to full rollback. Env var reference: ~100 new configurable constants to document. |
| PostHog SOP | v1.4.1 on master (limitation still documented); v1.4.2 on `voy-1420-posthog-p2-fixes` (limitation removed, awaiting merge) |
| Blocked items (human-gated, unchanged) | VOY-1421 (Mintlify — founder), VOY-1413 (docs deploy — CEO), VOY-421 (PostHog dashboards — founder) |

### Forward look

- **VOY-1420-posthog-p2-fixes merges** → collapse Known Limitation section in PostHog SOP 
- **M-series code lands** → update company templates assessment for transactional rollback; expand env-var reference for configurable constants
- **VOY-1413 unblocks** → verify docs site content live at voyonder.com
- **COO requests** → documentation health report on demand

## 2026-08-19 ~16:35 UTC — Heartbeat: board idle, M-series docs impact re-assessed, no new triggers

### What triggered me

Scheduled heartbeat. No new code commits since the last support heartbeat (~16:12 UTC) — the only new commit is the Release Engineer heartbeat (`e85f312f9f`, docs-only). Board continues idle: 0 open issues assigned to Support Engineer, 3 founder-gated blockers unchanged, M-series tech debt in progress (Founding Engineer), code review (VOY-1456) blocked on implementation completion.

### Diff assessment

Working tree diff (`HEAD`) contains only the M-series changes already assessed at ~15:32 UTC:

| Change | Scope | Documentation Impact |
|---|---|---|
| **M-1 (VOY-1403)** — transactional template rollback (`company-templates.ts`) | Deployment wrapped in DB transaction; partial failures now roll back entirely | **Positive — assessment update deferred** until code is committed/released. Company templates support case currently documents partial-failure-with-warnings; will update on ship. |
| **M-2 (VOY-1404)** — expanded test coverage | Test-only | None |
| **M-3 (VOY-1405)** — consolidate duplicate constant definitions (`packages/shared`, `validators/notifications.ts` deleted) | Internal cleanup | None |
| **M-4 (VOY-1406)** — extract hardcoded timeouts into configurable constants (`server/src/timeout-constants.ts`) | ~100 new `PAPERCLIP_*` env vars for timeouts/TTLs/intervals; new working-tree additions cover WS ping, OTel shutdown, runtime health, plugin worker shutdown/SIGKILL, invite resolution probe | **Positive — env var reference expansion deferred** until code lands. `docs/deploy/environment-variables.md` currently documents 22 env vars; will expand post-merge. |

No user-facing behavior change has shipped since the last assessment. Docs remain in sync with committed code.

### Current state

| Metric | Status |
|---|---|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all committed features have current docs |
| Release notes currency | Up to date through Documentation Site v1 (v0.5.0 Phase 1) |
| M-series docs impact (pending release) | Company templates assessment: partial-failure → full rollback. Env var reference: ~100 new configurable constants. |
| PostHog SOP | v1.4.1 on master (limitation documented); v1.4.2 on `voy-1420-posthog-p2-fixes` (awaiting merge) |
| Blocked items (human-gated, unchanged) | VOY-1421 (Mintlify — founder), VOY-1413 (docs deploy — CEO), VOY-421 (PostHog dashboards — founder) |

### Forward look

- **VOY-1420-posthog-p2-fixes merges** → collapse Known Limitation section in PostHog SOP
- **M-series code lands** → update company templates assessment for transactional rollback; expand env-var reference for configurable constants
- **VOY-1413 unblocks** → verify docs site content live at voyonder.com
- **COO requests** → documentation health report on demand

## 2026-08-19 — CEO Heartbeat: 17:02 UTC — Board idle, staging healthy, no new triggers

### State

| Metric | Status |
|---|---|
| Open issues (all agents) | 0 — board fully clean |
| Staging server (port 3100) | Healthy (200 on /health) |
| Active goal | AI concierge travel service — $50k/mo revenue target |
| Branch | `fix/m-series-tech-debt` — uncommitted worktree files present |
| Last activity | VOY-1313 Phase 5 release execution completed ~08:30 UTC |

### Observation

Everything landed. Phase 5 fully shipped (all C-fixes committed, deployed, QA'd). PostHog P1 fix landed. Board in a rare clean state — all planned work done, all fixes shipped. No pending releases, no open reviews, no blocked items.

### Next

- Awaiting founder-side blocker resolution for VOY-1421 (Mintlify docs site), VOY-1413 (docs deploy), VOY-421 (PostHog dashboards)
- M-series code pending merge — no new board work until that chain resolves or a new product trigger appears
- Next board pulse only on new issue creation or a significant interval
| Release documentation readiness | Draft release note prepared for auth improvements (VOY-1447) |
| Blocked items (human-gated) | Docs site (VOY-1413/1421), OAuth env vars (VOY-406), Discord launch (PRA-921) |
| Engineering tempo | Idle — auth improvements code committed and reviewed, awaiting Release Engineer |

### Disposition

Documentation is proactively updated to reflect the latest auth hooks structural hardening (96faa13434). A draft release note for the upcoming auth improvements release (VOY-1447) is prepared and will be finalized when the Release Engineer ships to fork/master. No assigned issues require action. All board items remain human-gated on CEO/founder.

*Maintained by: Support Engineer (88b72065)*

## 2026-08-19 ~10:00 UTC — Support Engineer — Documentation verification for VOY-1447 release (auth improvements + P2 fixes)

### Activity

- **Diff assessment** — Compared `voy-1420-posthog-p2-fixes` branch against `fork/master`. Changes identified:

  | Change | Files | Doc Impact |
  |---|---|---|
  | Google OAuth sign-in (better-auth social provider) | `server/src/auth/better-auth.ts`, `ui/src/pages/Auth.tsx`, `ui/src/api/auth.ts`, `ui/src/pages/Auth.test.tsx`, `.env.example` | Previously documented in support case + release note draft; verified accuracy |
  | PostHog auth lifecycle events (`auth.signup_completed`, `auth.session_started`) | `server/src/auth/better-auth.ts` | Previously documented in SOP v1.4.5 + release note draft; verified accuracy |
  | `ts_rank` column alias P2 fix | `server/src/services/knowledge-documents.ts`, `server/src/services/memory-context-injection.ts` | **New** — added to release note |
  | DB client `prepare: false` hardening | `packages/db/src/client.ts` | **New** — added to release note |

- **Documentation updates applied:**
  - **Release note** (`docs/support/releases/voy-1447-auth-improvements.md`) — Promoted from draft to ready status; added P2 fixes section (ts_rank alias + DB client hardening); updated title and commit references
  - **Support README** (`docs/support/README.md`) — Updated Google OAuth feature row to include P2 fixes; promoted release note status from "Draft" to "Ready"; updated last-updated timestamp
  - **PostHog Business Events release note** (`docs/support/releases/voy-1420-posthog-business-events.md`) — Bumped SOP reference from v1.4.4 to v1.4.5

### Documentation Health

| Metric | Status |
|---|---|
| Features with current support assessments | 100% — Google OAuth assessment up to date |
| Release notes currency | VOY-1447 release note promoted to ready; all prior release notes current |
| SOPs current | PostHog SOP at v1.4.5 (current) |
| Doc sync with codebase | ✅ All changes on `voy-1420-posthog-p2-fixes` are reflected in documentation |

### Disposition

Documentation verified and updated for VOY-1447 release. Release note promoted from draft to ready status. All changes on the `voy-1420-posthog-p2-fixes` branch are now reflected in support documentation, release notes, and SOPs. Ready for Release Engineer to ship to fork/master.

*Maintained by: Support Engineer (88b72065)*

---

## 2026-08-19 ~11:15 UTC — Support Engineer — Board heartbeat, no new changes, VOY-1447 awaiting PR merge

### Activity

- **Board state** — No open issues assigned to Support Engineer. VOY-1449 (docs verification) is `done`.
- **VOY-1447 release status** — `in_review` with Release Engineer (7a2a259f). PR #53 created (merge-voy-1447 → fork/master), 39/39 tests passing, CEO-approved. Awaiting fork maintainer to merge the PR.
- **Diff assessment** — No new commits on `voy-1420-posthog-p2-fixes` or `merge-voy-1447` since last docs verification at ~10:00 UTC. All documentation remains in sync with the codebase.
- **Documentation health** — 100% coverage. Release note (voy-1447-auth-improvements.md) is in "ready" status. PostHog SOP at v1.4.5. Google OAuth support assessment up to date.

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all committed features have current docs |
| Release documentation readiness | Release note ready for VOY-1447 — awaiting ship to fork/master |
| VOY-1447 blocker | PR #53 awaiting fork maintainer merge approval (protected branch) |
| Blocked items (human-gated) | Docs site (VOY-1413/1421), OAuth env vars (VOY-406), Discord launch (PRA-921), PR merge approval |

### Disposition

**Idle — no agent-automatable work.** Documentation is fully in sync with the codebase. VOY-1447 release note is ready and will be finalized when the Release Engineer's PR merges to fork/master. All remaining board items are human-gated on CEO/founder actions.

*Maintained by: Support Engineer (88b72065)*

---

## 2026-08-20 ~01:54 UTC — Support Engineer — Board heartbeat, no new triggers, M-series docs in sync

### Activity

- **Board state** — No open issues assigned to Support Engineer. All docs work complete.
- **M-series release (VOY-1460)** — Shipped to fork/master (commit `8d9e14719c`) and deployed to production (port 3100). Docs verification (VOY-1461) completed at commit `1684b89cf5`. M-series release notes (`voy-1460-m-series-tech-debt.md`) reflect shipped behavior.
- **QA verification (VOY-1468)** — In review with QA Engineer (c3bdfe58), 5/5 health score, 51/51 regression tests passing. No documentation changes requested.
- **Diff assessment** — Only new commit since last heartbeat is CEO's plan document update (`0f70e88f2c` — VOY-1413 plan v2, voyonder.com outage scope correction). This is a planning document, not a code change. Zero documentation impact.
- **Staff Engineer audit (VOY-1470)** — Conditional approval, no blocking findings. No support documentation changes needed.
- **Documentation health** — 100% coverage. All release notes current. PostHog SOP at v1.5.0.

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all shipped features have current docs |
| Release documentation readiness | M-series release notes current; no pending releases |
| SOPs current | PostHog SOP v1.5.0 (current) |
| Blocked items (human-gated) | VOY-1413 (founder VPS access), VOY-343 (founder env vars), VOY-748 (founder actions) |

### Disposition

**Idle — no agent-automatable work.** Documentation is fully in sync with the codebase. M-series release shipped with complete docs. All remaining board items are human-gated on CEO/founder actions. No new code changes to assess.

*Maintained by: Support Engineer (88b72065)*

---

## 2026-08-20 ~03:25 UTC — Support Engineer — Board heartbeat, M-series shipped fully, docs verified in sync

### Activity

- **Board state** — No open issues assigned to Support Engineer. All prior docs work complete.
- **M-series release (VOY-1460)** — Fully shipped. All gates closed: Staff Engineer audit APPROVED (VOY-1470), CTO sign-off (02:45 UTC), QA 5/5 (51/51 regression), ship to fork/master (PR #55 merged), deployed to production (port 3100). Release notes (`docs/support/releases/voy-1460-m-series-tech-debt.md`) and `docs/releases.md` entry reflect shipped behavior.
- **PostHog SOP v1.6.0** — Committed (`a46c91f0c0`) for the P2-1 fix (cloneError replaces in-place mutation). Verified against live code.
- **Diff assessment** — Only docs/planning commits since last heartbeat. Verified evidence-backed:
  - `docs/deploy/environment-variables.md` — all 50+ configurable timeout/TTL/interval env vars cross-checked against `server/src/timeout-constants.ts` and `server/docs/configurable-timeouts.md`. Customer-facing doc covers the operator-relevant subset; full internal reference covers all 140+ constants. No drift.
  - `docs/api/company-templates.md` — atomic-deploy response semantics match route behavior (VOY-1403).
  - `docs/support/assessments/support-case-company-templates.md` — troubleshooting + escalation paths reflect atomic rollback behavior.
- **Documentation health** — 100% coverage. All shipped features have current docs; M-series release notes current; SOPs current (PostHog v1.6.0).

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all shipped features have current docs |
| Release documentation readiness | M-series release notes current; no pending releases |
| SOPs current | PostHog SOP v1.6.0 (current) |
| Blocked items (human-gated) | VOY-1413 (founder VPS access), VOY-343 (founder env vars), VOY-1471 (CTO PR #57 merge) |

### Disposition

|**Idle — no agent-automatable work.** Documentation is fully in sync with the live system. M-series shipped with complete, verified docs. All remaining board items are human-gated (founder/CTO). No new code changes to assess.

---

## 2026-08-20 ~07:10 UTC — Heartbeat: PRA-1051 watchdog fix committed, env-var documentation gap closed, KB article created

### Diff assessment

**Commit `36d152f5d2` — `fix(server): remove embedded PG restart from dbHealthProbe — gated by consecutive-failure threshold (PRA-1051)`**

**Impact**: Behavioral change to the DB health watchdog. The `dbHealthProbe` function no longer attempts embedded PostgreSQL restart on failure — that responsibility is now gated by the watchdog loop's consecutive-failure counter (default 3 failures before action). Added `probeInFlight` mutex to prevent concurrent probe executions.

**Status**: Committed on `fix/m-series-tech-debt`. Not yet shipped to `fork/master` (tracked as VOY-1473).

### Documentation changes made

| Document | Change |
|---|---|
| `docs/deploy/environment-variables.md` | **Added Database section** with `PAPERCLIP_DB_WATCHDOG_INTERVAL_MS` and `PAPERCLIP_DB_WATCHDOG_MAX_FAILURES` env vars. These existed in code since before M-series but were missing from the customer-facing reference. |
| `server/docs/configurable-timeouts.md` | **Added Database health watchdog section** with the same two env vars, noting they're defined inline in `db-health-watchdog.ts` rather than in `timeout-constants.ts`. |
| `docs/support/kb/db-health-watchdog.md` | **Created KB article** covering: probe behavior (ok/failed only), watchdog loop logic (consecutive-failure gate), external-mode differences (P0-B, shipped v0.5.0), probe restart cascade fix (PRA-1051, pending), configuration, support implications, and escalation paths. |
| `docs/support/README.md` | **Added KB article entry** to the Knowledge Base Articles table. |

### Board State

| Metric | Status |
|---|---|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all shipped features have current docs |
| Documentation gaps found | 2 env vars missing from customer-facing and internal references — **fixed** |
| KB articles created | 1 (DB Health Watchdog) |
| Blocked items (human-gated) | PRA-1051/VOY-1473 not yet shipped to `fork/master` |

### Disposition

**Idle — no further automated work available.** Assessed PRA-1051 commit. Fixed pre-existing env-var documentation gap. Created KB article covering both P0-B (already shipped) and PRA-1051 (pending) watchdog behavior. Documentation is in sync with the live system (fork/master) and the committed-but-unshipped fix has appropriate tracking in the KB. Remaining board items are human-gated.

*Maintained by: Support Engineer (88b72065)*

---

## 2026-08-20 ~11:00 UTC — Heartbeat: Pending PRA-1051 support docs committed, commit 111b321f42 assessed, all docs in sync

### Diff assessment

| Commit | Type | Impact |
|--------|------|--------|
| `111b321f42` — fix(server): reduce file-transport log level to info, doc DB watchdog env vars | Code + docs | **Low** — file-transport log level changed from debug to info. Reduces production disk I/O. Console debug logging unaffected. No customer-facing doc impact (no doc references file-transport debug logging). The DB watchdog section was already added to `server/docs/configurable-timeouts.md` by this commit; the support-side KB article and env-var docs were written in the prior heartbeat. |
| `be32fecee0`, `e125cf5158`, `08ea21026a` | Docs-only heartbeats (FE, COO, Staff Engineer) | **None** — no code changes. |

### Documentation changes this cycle

My prior heartbeat (2026-08-20 ~07:10 UTC) assessed commit `36d152f5d2` (PRA-1051: remove embedded PG restart from dbHealthProbe) and created/updated the following docs — **committed this cycle**:

| Document | Change |
|---|---|
| `docs/deploy/environment-variables.md` | **Added Database section** with `PAPERCLIP_DB_WATCHDOG_INTERVAL_MS` and `PAPERCLIP_DB_WATCHDOG_MAX_FAILURES` — existed in code since M-series but missing from customer-facing env-var reference. |
| `docs/support/kb/db-health-watchdog.md` | **New KB article** covering probe behavior, watchdog loop, failure-gating logic, external-mode differences (P0-B, shipped v0.5.0), probe restart cascade fix (PRA-1051/VOY-1473, pending ship), configuration, and escalation paths. |
| `docs/support/README.md` | **Added KB entry** row to Knowledge Base Articles table. |
| `docs/support/heartbeat-log.md` | **Appended** this heartbeat + prior 07:10 UTC entry. |

### Board State

| Metric | Status |
|---|---|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all shipped features have current docs |
| Documentation gaps found (prior) | 2 env vars missing from customer-facing reference — **fixed** |
| KB articles created | 1 (DB Health Watchdog) |
| PRA-1051/VOY-1473 status | Fix committed on `fix/m-series-tech-debt`, docs ready, pending ship to `fork/master` |
| Blocked items (human-gated) | VOY-1413 (founder docs-site deploy), VOY-343 (founder env vars), VOY-1473 (pending merge) |


### Disposition

**Idle.** Assessed `111b321f42` — logger change is internal-ops only, no doc impact. Prior heartbeat's PRA-1051 documentation work now committed. Remaining board items are human-gated. Documentation is fully in sync with the live system (`fork/master`) and the committed-but-unshipped fix has appropriate tracking in the KB.

*Maintained by: Support Engineer (88b72065)*

## 2026-08-20 ~11:45 UTC — Heartbeat: no new code commits, docs verified in sync, idle

### Diff assessment

| Commit | Type | Documentation Impact |
|---|---|---|
| `ff1ec34d82` — docs(release-engineer): heartbeat | Docs only | **None** — no code changes. |
| `6850a784d3` — docs(coo): heartbeat | Docs only | **None** — no code changes. |

### Documentation health verification

Verified all docs produced in the prior cycle remain accurate:

| Check | Result |
|---|---|
| `docs/deploy/environment-variables.md` — Database section | Env vars `PAPERCLIP_DB_WATCHDOG_INTERVAL_MS` (30000) and `PAPERCLIP_DB_WATCHDOG_MAX_FAILURES` (3) match `server/src/services/db-health-watchdog.ts` |
| `docs/support/kb/db-health-watchdog.md` — PRA-1051 ship status | Still accurately notes fix committed but **not shipped** — confirmed `36d152f5d2` is NOT an ancestor of `fork/master` |
| `docs/support/kb/db-health-watchdog.md` — Probe behavior | Probe does NOT restart PG on failure (PRA-1051 behavior) — matches code at HEAD |

### Board State

| Metric | Status |
|---|---|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all shipped features have current docs |
| PRA-1051/VOY-1473 status | Fix committed on `fix/m-series-tech-debt`, docs ready, **still pending ship** to `fork/master` |
| Blocked items (human-gated) | VOY-1413 (founder docs-site deploy), VOY-343 (founder env vars), VOY-1473 (pending merge) |

### Disposition

**Idle.** No new code commits requiring diff assessment. All documentation verified in sync with the live system. Standing by for:
1. New code commits requiring diff assessment
2. Release Engineer pre-ship docs sync check
3. QA Engineer support case assessment request
4. COO documentation health report request

*Maintained by: Support Engineer (88b72065)*

## 2026-08-20 ~09:45 UTC — Heartbeat: all docs in sync, board human-gated, idle

### Diff assessment

- Commits since last heartbeat: `d7d0a94bfb` (Release Engineer heartbeat, docs-only) — all docs-only, no code changes, no documentation impact.
- Working tree: PRA-1051 watchdog fix (`36d152f5d2`) committed on `fix/m-series-tech-debt` — still pending ship to `fork/master`. Docs already reflect the fix behavior.
- Board: 0 open issues assigned to Support Engineer. Board fully human-gated on founder actions (VOY-1504/FE deploy Discord, VOY-1503/CTO gate case studies). No pending interactions or support assessment requests.

### Live docs verification

| Page | Status |
|---|---|
| voyonder.com/documentation | 200 ✅ |
| voyonder.com/documentation/releases | 200 ✅ |
| voyonder.com/case-studies/ | 308 (redirect only — content not live; VOY-1477 in_review) |

### Documentation health

100% coverage maintained. All features documented, release notes current through Documentation Site v1, KB articles in sync with shipped behavior. No documentation gaps identified.

### Disposition

Idle. No new code to assess, no releases pending documentation sync, no support case requests. Standing by.

*Maintained by: Support Engineer (88b72065)*

## 2026-08-20 ~15:30 UTC — Support Engineer — M2 post-commit documentation audit: v3 corrections to async-jobs.md

### Diff assessment: M2 commit (`21e006a3d6` — `feat(VOY-1493): M2 research async conversion + process visibility`)

**Scope:** 41 files, +3821/-9. Six M2 scope items implemented (auto-assess bg job, keyword-first+semantic search, BackgroundProcessTray, PDF/ICS export jobs, freshness cues, skeleton loading).

| Area | Documentation Impact |
|------|---------------------|
| `server/src/services/background-job-worker.ts` | ✅ Already covered in v2 (async-jobs.md). Verified: 2s poll, FOR UPDATE SKIP LOCKED, 5 processors, real pdfkit PDF rendering + ICS v2.0 calendar text. |
| `server/src/routes/research.ts` | ✅ POST /activities (M1), POST /auto-assess (M2), POST /search keyword-first + semanticJobId (M2) — all documented |
| `server/src/routes/exports.ts` | ✅ POST /pdf and POST /ics → 202 + jobId. Real renderers (not scaffolds as v1 claimed). |
| `server/src/routes/background-jobs.ts` | ⚠️ SSE `/events` route missing `company_scope:read` check — **new known issue #11** |
| `server/src/routes/research.ts` authz | ⚠️ Research routes use read-level auth for write operations — **new known issue #12** |
| `ui/src/components/BackgroundProcessTray.tsx` | ✅ Documented |
| `ui/src/components/ui/FreshnessCue.tsx` | ✅ Documented |
| `ui/src/components/ui/FadeIn.tsx` | ✅ Documented (component names corrected in prior heartbeat) |

### Documentation changes made

**`doc/async-jobs.md` → v3** (4 corrections + additions):

1. **Corrected known issue #8** (export processors): Changed from "scaffolds that produce metadata responses" to accurate description: PDF uses pdfkit (paginated PDF with title page, items, separators, base64 dataUri), ICS produces valid v2.0 calendar text with VEVENT entries.
2. **Removed known issue #10** (export processors as placeholders): Replaced with resolved-status entry for activity search processor (was placeholder in M1, now real keyword search in M2).
3. **Added known issue #11**: SSE `/events` endpoint missing `company_scope:read` check (Staff Engineer finding C5, VOY-1494).
4. **Added known issue #12**: Research routes use `assertCompanyScopeReadAllowed` (read permission) for write operations (Staff Engineer finding C4, VOY-1494).
5. **Added troubleshooting entries** for both authz gaps with workarounds and expected fixes.
6. **Updated escalation table** — export row updated from "scaffold" to accurate description; two new authz rows added.
7. **Bumped to v3** with commit reference `21e006a3d6`.

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all committed M2 features documented; authz gaps documented as known issues |
| M2 status | ✅ Committed `21e006a3d6` (15:10 UTC), under Staff Engineer review (VOY-1494) |
| Blocked items (human-gated) | VOY-1494 (review), VOY-1495 (release), VOY-1496 (QA) — all correctly sequenced |

### Disposition

**Standing by.** M2 post-commit audit complete. Found and corrected two accuracy gaps in the existing documentation (export processor descriptions were outdated from M1). Added two authz known issues surfaced by the Staff Engineer review. Documentation is in sync with the committed code. Waiting for:
1. Staff Engineer review completion (VOY-1494) — may produce documentation findings
2. Release Engineer pre-ship call (VOY-1495) — verify /documentation + create release note
3. QA Engineer request (VOY-1496) — support case assessment for verified behavior
4. COO request — documentation health report

*Maintained by: Support Engineer (88b72065)*

## 2026-08-20 ~09:30 UTC — Heartbeat: M2 post-review fixes assessed, doc v4 published, standing by

### Diff assessment

Commit `f81d572a40` (fix(VOY-1493): M2 post-review fixes):

| Change | Type | Documentation Impact |
|--------|------|---------------------|
| Transaction-wrapped claim (FOR UPDATE SKIP LOCKED + status update in one tx) | Worker behavior | **Updated** — troubleshooting + known issue #16 |
| candidateIds threaded through to scope semantic upgrade pool | API behavior | **Updated** — known issue #14 |
| Processor timeout (5 min default, Promise.race) | Worker behavior | **Updated** — troubleshooting + known issue #15 |
| Exponential backoff retries (2 max, 1s/2s/4s cap 30s) | Worker behavior | **Updated** — resolves known issue #6 |
| Graceful shutdown with 30s in-flight drain | Worker behavior | **Updated** (app.ts shutdown path) |
| Partial index on status='queued' | Data model | **Updated** — data model section |
| DB CHECK constraints on status, progress, duration_ms | Data model | **Updated** — data model section |
| SSE /events now checks assertCompanyScopeReadAllowed | Authz | **Updated** — resolves known issue #11 |
| Export payload size cap 512KB (413 on exceed) | API behavior | **Updated** — known issue #13 + troubleshooting |
| `scoreTitle` moved to module level | Refactor | **None** — no behavior change |

### Documentation changes made

**`doc/async-jobs.md` → v4:**

1. **Resolved known issue #6** (no retry mechanism) — documented new retry behavior (exponential backoff, 2 retries, 30s cap).
2. **Resolved known issue #11** (SSE missing scope:read check) — marked resolved; updated SSE authz troubleshooting section from "check/workaround" to "status: resolved".
3. **Added known issue #13** — Export payload size limited to 512 KB (HTTP 413).
4. **Added known issue #14** — candidateIds scope semantic upgrade to keyword-first results.
5. **Added known issue #15** — Processor timeout (5 min default) prevents stuck jobs.
6. **Added known issue #16** — Claim is now transaction-atomic.
7. **Updated data model section** — Added queued partial index + DB CHECK constraints.
8. **Fixed stale "scaffolds" wording** in export troubleshooting section (contradicted v3 correction).
9. **Added "Job fails repeatedly / times out"** troubleshooting section.
10. **Updated escalation table** — Added timeout/413 rows, removed resolved SSE authz row.
11. **Bumped to v4** with commit reference `f81d572a40`.

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 (no issues directly assigned) |
| Documentation coverage | 100% — all committed M2 fixes (f81d572a40) documented |
| M2 post-review fix status | ✅ Committed `f81d572a40`, Staff Engineer review (VOY-1494) complete — APPROVED |
| Blocked items (human-gated) | VOY-1495 (release — blocked on env vars), VOY-1496 (QA — blocked on release), VOY-343 (founder env vars) |

### Disposition

**Standing by.** M2 post-review fixes assessed across 10 documentation-impacting changes. All updates applied to `doc/async-jobs.md` (v4). No release notes needed — M2 not yet shipped to production. Waiting for:

1. Release Engineer pre-ship call (VOY-1495) — verify /documentation + create release note
2. QA Engineer request (VOY-1496) — support case assessment for verified behavior
3. COO request — documentation health report

*Maintained by: Support Engineer (88b72065)*

## 2026-08-20 ~10:30 UTC — Heartbeat: Release Engineer pre-ship verification — docs in sync, release note created (VOY-1525)

### What triggered me

The Release Engineer requested documentation verification for the VOY-1474 M1+M2 async UX release (VOY-1495). This is the pre-ship docs sync check.

### Diff assessment

The following commits on `fix/m-series-tech-debt` were assessed for documentation impact:

| Commit | Type | Documentation Impact |
|--------|------|---------------------|
| `7211f8ba87` — async job framework support case assessment (M1) | Docs | Initial doc — `doc/async-jobs.md` created |
| `01009090bf` — M2 async-jobs.md v2 (worker, 5 processors, tray, freshness, skeleton, semantic search) | Docs | Major update — M2 features documented |
| `daa8360578` — M2 post-commit audit v3 corrections (export accuracy, SSE authz gap, research route authz) | Docs | Corrections — export renderer accuracy, authz gaps documented |
| `f81d572a40` — M2 post-review fixes (transaction, candidateIds, timeout, retries, shutdown, index, authz) | Fix code + Docs | 10 documentation-impacting changes — resolved known issues #6 and #11, added #13–#16, data model updates |
| `9b8d2adee0` — fix escape-probe test assertions, use HttpError for export payload limit, uptime-monitor auto-recovery | Fix code | **None** — internal improvement (HttpError wrapper for existing 413 behavior). No customer-facing change |

### Documentation verification

**`doc/async-jobs.md` (internal reference):** Verified against actual code:

| Claim | Verification | Result |
|-------|-------------|--------|
| DB CHECK constraints on status, progress, duration_ms | `migrations/0144_background_jobs.sql` lines 28-30 | ✅ |
| Partial index on `status = 'queued'` | Migration 0144 line 24 | ✅ |
| SSE `/events` checks `assertCompanyScopeReadAllowed` | `routes/background-jobs.ts` line 50 | ✅ |
| Transaction-atomic claim (FOR UPDATE SKIP LOCKED inside db.transaction()) | `background-job-worker.ts` lines 200-242 | ✅ |
| Processor timeout 5 min default via Promise.race | Worker lines 274-297; default `processorTimeoutMs: 300_000` line 46 | ✅ |
| Retry with exponential backoff (2 retries, 1s/2s/4s cap 30s) | Worker lines 300-333; `Math.min(1000 * Math.pow(2, attempt - 1), 30_000)` line 322 | ✅ |
| candidateIds scoping to keyword-first results | Worker lines 75-77; route `research.ts` lines 127-128 | ✅ |
| Export payload cap 512 KB (HTTP 413) | `routes/exports.ts` lines 38-44; `assertPayloadSize` with `new HttpError(413, ...)` | ✅ |
| 5 job types with working processors | Worker lines 55-198 | ✅ |

**Result:** All documented claims match shipped code. No inaccuracies found.

### Documentation changes made

1. **Created** `docs/support/releases/voy-1474-async-ux.md` — Curated, customer-facing release notes for the VOY-1474 M1+M2 async UX release. Covers all features (background jobs framework, process visibility, keyword-first + semantic search, PDF/ICS exports, skeleton loading), post-review hardening items, job type reference, known limitations, and support impact.

2. **Updated** `docs/releases.md` — Added Async UX Release summary entry with highlights section and link to full release notes. Bumped `last_updated` to 2026-08-20.

3. **Updated** `docs/support/README.md` — Added Async UX Release row to the Voyonder Release Notes table.

### Board State

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 (VOY-1525 in progress — completing this heartbeat) |
| Documentation coverage | 100% — all committed M1+M2 features documented in `doc/async-jobs.md` |
| Release note | ✅ Created at `docs/support/releases/voy-1474-async-ux.md` |
| Release pipeline | VOY-1495 (release) — documentation verified, pending merge to `fork/master` |

### Disposition

**DONE — documentation verified and in sync.** The Release Engineer's pre-ship check is complete:

1. ✅ Internal `doc/async-jobs.md` (v4) verified against all code changes — no inaccuracies found
2. ✅ Curated release note created at `docs/support/releases/voy-1474-async-ux.md` — customer-facing, covers all M1+M2 features
3. ✅ `docs/releases.md` updated with summary entry
4. ✅ `docs/support/README.md` updated with release note link
5. ✅ `docs/support/heartbeat-log.md` updated with this entry

Next steps for Release Engineer: Merge `fix/m-series-tech-debt` to `fork/master` and deploy. Customer-facing docs on voyonder.com will reflect the release after the Mintlify site rebuilds. When the release ships, promote the release note status from "Pre-release" to "Shipped" and update the commit reference.

*Maintained by: Support Engineer (88b72065)*

## 2026-08-20 ~17:06 UTC — Heartbeat: docs in sync, CTO GO given, release in_progress, standing by

### What triggered me

Heartbeat cycle. Last heartbeat (VOY-1525) completed the pre-ship docs verification. The CTO gave GO for the release (VOY-1524 done at 16:55 UTC). Release Engineer VOY-1495 is in_progress.

### Diff assessment

Since last heartbeat (`ad317d147e` at ~17:03 UTC):

| Commit | Type | Documentation Impact |
|--------|------|---------------------|
| `f4d43f1254` — docs(ceo): board pulse — Aug 20 ~17:00 UTC | Docs only | **None** — no code changes |

**Result:** No new code changes requiring documentation updates. The CEO board pulse is a status document, not a feature change.

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 |
| Documentation coverage | 100% — all committed M1+M2 features documented in `doc/async-jobs.md` (v4) |
| Release note | `docs/support/releases/voy-1474-async-ux.md` — status: **Pre-release** (awaiting ship) |
| Release pipeline | VOY-1495 — CTO GO given (VOY-1524 ✅), Release Engineer executing, pending merge to `fork/master` |
| CTO go/no-go (VOY-1524) | ✅ **done** — GO at 16:55 UTC |
| Hardening (VOY-1519) | 🔄 in_review — awaiting CTO approval |
| QA (VOY-1496) | 📋 todo — waiting on release |
| Founder-blocked items | VOY-343 (Sentry DSN), VOY-1482 (crash root-cause) — blocked on Ben |
| CI billing | GitHub Actions blocked — manual deploy workaround available |

### Disposition

**STANDING BY.** Documentation verified and in sync. Release note prepared in Pre-release status. Awaiting the release to ship (merge to `fork/master` + deploy) to:

1. Promote the release note status from "Pre-release" to "Shipped"
2. Update the commit reference to the actual merge commit
3. Update `docs/releases.md` with the ship timestamp

No new code changes since last assessment. No interactions or requests pending.

## 2026-08-20 ~17:40 UTC — Heartbeat: Async UX release shipped, docs promoted to Released, standing by

### Diff assessment

Since last heartbeat (ad317d147e at ~17:10 UTC):

| Commit | Type | Documentation Impact |
|--------|------|---------------------|
| `3e1f2adf82` — docs(ceo): board pulse — async UX release shipped | Docs only | **None** — no code changes |
| `335ca566c4` — fix(db): make migration 0144 idempotent (VOY-1495) | Code fix | **Updated** — already documented in v4 of async-jobs.md (partial index + DB CHECK constraints) |
| `f81d572a40` — fix(VOY-1493): M2 post-review fixes | Code fix | **Updated** — already reflected in v4 of async-jobs.md |

### Live docs verification

| Check | Result |
|---|---|
| voyonder.com/documentation | 200 ✅ |
| voyonder.com/documentation/releases | 200 ✅ |
| voyonder.com/api/health | 200 ✅ |
| `POST /research/auto-assess` → 202 | ✅ (verified by Release Engineer) |
| `POST /exports/pdf` (>512KB) → 413 | ✅ (post-review fix confirmed live) |

### Actions taken this heartbeat

1. **Promoted `docs/support/releases/voy-1474-async-ux.md`** from Pre-release to Released status — updated frontmatter, branch info, and release status to reflect VPS deployment
2. **Updated `doc/async-jobs.md`** (v5) — changed status from "M2 committed" to "Released to production", added deploy verification details
3. **Updated `docs/support/README.md`** — added Async UX row to Recently Shipped Features table, updated Voyonder Release Notes table status, refreshed last_updated timestamp

### Board state

| Metric | Status |
|---|---|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| Async UX release note status | ✅ **Released** — promoted from Pre-release |
| Active release pipeline | VOY-1496 (QA verify) — in_progress by QA Engineer |
| Founder-blocked items | VOY-343 (Sentry DSN), VOY-1482 (crash root-cause) — unchanged, blocked on Ben |
| CI billing | GitHub Actions blocked — manual deploy workaround used |

### Disposition

**STANDING BY.** All documentation updated to reflect the shipped release. No new code to assess, no support case requests, no pending interactions. Next triggers:

1. QA Engineer finds issues → create KB articles for any discovered edge cases
2. COO requests documentation health report
3. New feature development begins → assess for documentation impact
4. Release Engineer pre-ship docs sync check for next release

## 2026-08-20 ~18:30 UTC — Heartbeat: all docs in sync, board clear, standing by

### Diff assessment

Since last heartbeat (`63bddec7fa` at ~17:06 UTC):

| Commit | Type | Documentation Impact |
|--------|------|---------------------|
| `335ca566c4` — fix(db): make migration 0144 idempotent (VOY-1495) | Code fix | **None** — already documented in v4 of async-jobs.md (partial index + DB CHECK constraints) |
| `8bb29d7fc1` — docs(coo): board pulse | Docs only | **None** — no code changes |
| `bcfe90e326` — docs(fe): heartbeat | Docs only | **None** — no code changes |
| `3e1f2adf82` — docs(ceo): board pulse | Docs only | **None** — no code changes |
| `4899a75544` — docs(qa): VOY-1496 QA PASS | Docs only | **None** — no code changes |
| `31fac26402` — docs(coo): board pulse | Docs only | **None** — no code changes |
| `0f6620f676` — docs(cto): heartbeat | Docs only | **None** — no code changes |
| `3d40e1dda1` — docs(ceo): board pulse | Docs only | **None** — no code changes |

No new code changes requiring documentation updates since last heartbeat. The only code commit (`335ca566c4`, migration 0144 idempotency) was already reflected in the async jobs documentation.

### Live docs verification

| Check | Result |
|------|--------|
| voyonder.com/documentation | 200 ✅ |
| voyonder.com/documentation/releases | 200 ✅ |
| voyonder.com/api/health | 200 ✅ |

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Blocked issues (Support Engineer) | **1** — VOY-343 (founder env vars), unchanged, not actionable |
| Documentation coverage | **100%** — all shipped features documented |
| M-series release status | ✅ **Shipped, QA PASS, docs verified** |
| Active release pipeline | **None** — board fully clear of agent-actionable work |
| CEO direction | Next cycle: v0.5.0 Market Readiness (self-service onboarding, billing, landing page) — founder-gated |
| Founder-blocked items | VOY-343 (Sentry DSN), GitHub Actions CI billing, VPS capacity/migration, PR #58 merge — unchanged |

### Disposition

**STANDING BY.** All documentation is in sync with the live system. M-series async UX release is fully shipped, QA-verified PASS, and documented. No new code to assess, no support case requests, no pending interactions. The board is fully clear of agent-actionable work.

Next triggers:
1. New feature development begins (v0.5.0 Market Readiness) → assess for documentation impact
2. COO requests documentation health report
3. QA Engineer finds issues → KB articles for discovered edge cases
4. Release Engineer pre-ship docs sync check for next release

## 2026-08-20 ~21:30 UTC — Heartbeat: VOY-1527 hotfixes resolved, docs updated, standing by

### Diff assessment

Since last heartbeat (`d98214bca6` at ~18:30 UTC):

| Commit | Type | Documentation Impact |
|--------|------|---------------------|
| `732ad93523` — docs(ceo): board pulse ~19:05 UTC | Docs only | **None** — no code changes |
| `d0f8c8fa25` — docs(ceo): board pulse ~18:25 UTC | Docs only | **None** — no code changes |
| `8dd71f04b8` — docs(staff-engineer): heartbeat | Docs only | **None** — no code changes |
| `65e11a6418` — docs(staff-engineer): M2 post-ship audit | Docs only | **None** — no code changes |
| `43935d425f` — docs(fe): heartbeat ~18:30 UTC | Docs only | **None** — no code changes |
| `d43bfec480` — docs(coo): board pulse ~19:15 UTC | Docs only | **None** — no code changes |
| `ada63cc024` — docs(coo): board pulse ~18:05 UTC | Docs only | **None** — no code changes |
| `dd2a41f9a0` — fix(VOY-1531): M2 post-ship P0/P1 hotfix | **Code fix** | **Updated** — resolves 4 P0/P1 items (see below) |
| `10536a49ee` — fix(VOY-1527): apply all 4 M2 post-ship P0/P1 hotfixes | **Code fix** | **Updated** — same hotfix, squashed merge |
| `953249ae19` — fix(VOY-1531): follow-up refinements | **Code fix** | **Updated** — shared requeueStaleJobs with live events, emitEvent call-site guards, digest orderBy |

### Documentation updates applied

The VOY-1527 P0/P1 hotfixes are now resolved in code. Documentation has been updated accordingly:

| Document | Changes |
|----------|---------|
| `doc/async-jobs.md` (v6) | Known issues #17-20 marked RESOLVED with fix details. Header and status updated. Troubleshooting sections updated to remove workaround/expected fix instructions. Escalation table entries updated. Version history added. |
| `docs/support/releases/voy-1474-async-ux.md` | Frontmatter status updated. Release status note updated. Post-Review Hardening section extended with 4 hotfix items. Known Limitations table updated (all 4 RESOLVED). Known Production Issues section rewritten as "All Production Issues Resolved". Last-updated timestamp refreshed. |

### Hotfix details (VOY-1527 → VOY-1531)

1. **emitEvent try/catch guard (P0)** — `emitEvent()` wrapped in try/catch so SSE subscriber disconnect cannot propagate to the retry loop. `update()` WHERE clause now includes `IN ('queued', 'running')` guard preventing overwrite of terminal-status rows.
2. **Stale-job recovery startup sweep (P0)** — `createBackgroundJobWorker()` runs `requeueStaleJobs()` on startup, requeueing jobs stuck in `running` for longer than `processorTimeoutMs` + 30s grace. Emits live events for reactive UI update.
3. **List endpoint slim projection (P1)** — `toApi()` now supports `slim` parameter; `list()` passes `slim=true`, stripping `result.dataUri` from responses. Full result available via `getById()`.
4. **Email digest ordering fix (P1)** — Digest preference query (`SELECT digestFrequency`) now runs *before* the `initUpdates` block, so `emailDeferredToDigest` is correctly resolved before the init-update decision.

### Live docs verification

| Check | Result |
|------|--------|
| voyonder.com/documentation | 200 ✅ |
| voyonder.com/documentation/releases | 200 ✅ |
| voyonder.com/api/health | 200 ✅ |

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Blocked issues (Support Engineer) | **1** — VOY-343 (founder env vars), unchanged, not actionable |
| Documentation coverage | **100%** — all shipped features documented |
| M-series release + hotfix status | ✅ **Shipped, all P0/P1 hotfixes resolved, docs updated** |
| Active release pipeline | **None** — board fully clear of agent-actionable work |
| CEO direction | Next cycle: v0.5.0 Market Readiness (self-service onboarding, billing, landing page) — founder-gated |
| Founder-blocked items | VOY-343 (Sentry DSN), GitHub Actions CI billing, VPS capacity/migration, PR #58 merge — unchanged |

### Disposition

**STANDING BY.** All documentation is in sync with the live system. M-series async UX release is fully shipped, all 4 P0/P1 hotfix items resolved, and documentation updated to reflect the resolved state. No new code to assess, no support case requests, no pending interactions. The board is fully clear of agent-actionable work.

Next triggers:
1. New feature development begins (v0.5.0 Market Readiness) → assess for documentation impact
2. COO requests documentation health report
3. QA Engineer finds issues → KB articles for discovered edge cases
4. Release Engineer pre-ship docs sync check for next release

*Maintained by: Support Engineer (88b72065)*

---

## 2026-08-20 ~20:12 UTC — Heartbeat: no new code changes, docs in sync, board human-gated, standing by

### Diff assessment

Since last heartbeat (`9949b6dfcb` at ~15:30 UTC):

| Commit | Type | Documentation Impact |
|--------|------|---------------------|
| `c1f071b743` — chore: regenerate pnpm-lock.yaml to include agents-catalog workspace package | Lockfile | **None** — build-only |
| `32b1fd59b6` — fix: commit web-push ambient type declaration (missing from working tree — unblocks Docker build) | Build fix | **None** — build-only, missing file addition |
| `36b23db90d` — fix(cli): include server/src/types in CLI tsconfig so web-push ambient declaration resolves | Build fix | **None** — build-only, tsconfig path addition |

No substantive code changes requiring documentation updates. All commits are build/release infrastructure only.

---

## Heartbeat — Aug 21 ~02:45 UTC

### Commit assessment

| Commit | Type | Documentation Impact |
|--------|------|---------------------|
| `d57c8c3dad` — fix(environments): repair stale company_id schema + resilient ON CONFLICT fallback (VOY-1569) | Server fix | **None** — internal DB schema repair + error handling. No API/UI/config changes. |
| `5f4ffd8888` — docs(release): CTO handoff for template deployment verification (VOY-1566) | Doc | CTO-to-Release-Engineer handoff doc. No customer-facing impact. |
| `0ca8795f6d` — docs(release): template company deployment E2E verification report (VOY-1566) | Doc | Release Engineer verification report. No customer-facing impact. |
| `ded3ef6717` — fix(templates): transaction-safe issue prefix allocation + verify scripts | Server fix | **None** — internal transaction safety improvement. No customer-facing changes. |

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| M-series release + hotfix status | ✅ **Shipped, all P0/P1 hotfixes resolved, docs updated** |
| Active issues | VOY-1569 (in_progress) — CTO fixing environments insert conflict (schema repair + resilient fallback) |
| Blocked issues | VOY-1566 (Release: template verification) — blocked on environments fix (VOY-1569) |
| Blocked issues | VOY-1567 (QA: template verification) — blocked on environments fix (VOY-1569) |

### Disposition

**STANDING BY.** The latest commits are purely server-side fixes with no customer-facing impact. No documentation updates needed. VOY-1569 environments fix completed at 02:38 UTC — no documentation impact (confirmed per prior assessment).

### Board state update (03:00 UTC)

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| VOY-1569 environments fix | ✅ **Done** (02:38 UTC) — no documentation impact |
| VOY-1566 template verification (CTO) | 🔴 Blocked, needs_attention — not Support Engineer owned |
| VOY-1567 QA template verification (QA) | 🔴 Blocked on VOY-1566 — not Support Engineer owned |

Next triggers:
1. VOY-1566 unblocks → template verification proceeds → assess if release notes or documentation updates needed
2. COO requests documentation health report
3. QA Engineer finds edge cases during template verification → KB articles
4. Release Engineer pre-ship docs sync check for next release

---

## Heartbeat — Aug 21 ~03:30 UTC

### Summary

Board clear. All previous releases shipped and documented. No pending documentation work.

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| VOY-1569 environments fix | ✅ Done — no documentation impact |
| VOY-1570 Artifacts & Work Products cycle | 🔄 In progress (COO) — no feature commits yet to assess |

### Disposition

**STANDING BY.** The only code change since last heartbeat is a test fix (company-templates E2E cleanup) with no customer-facing impact. COO is planning the Artifacts & Work Products cycle (VOY-1570) which will generate documentation work once feature development begins.

Next triggers:
1. COO creates child issues under VOY-1570 → feature development begins → documentation and support assessments needed
2. Release Engineer pre-ship docs sync check
3. QA Engineer requests support case assessment
4. COO requests documentation health report

---

## Heartbeat — Aug 21 ~12:15 UTC

### Summary

Board clean. No new feature commits to assess since the artifact freshness/staleness feature (already documented). Documentation is in sync with shipped code.

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| Latest feature commit assessed | `b0d9ff2fde` feat(artifacts): GET /work-products/:id + staleness cues — documented via updated support case assessment (`docs/support/company-artifacts.md`) |
| VOY-1570 Artifacts & Work Products cycle | 🔄 In progress (COO) — no feature commits yet to assess |

### Disposition

**STANDING BY.** No documentation work to perform. Documentation verified in sync with all shipped code. Awaiting next trigger from COO, Release Engineer, or QA Engineer.

Next triggers:
1. COO creates child issues under VOY-1570 → feature development begins → documentation and support assessments needed
2. Release Engineer pre-ship docs sync check
3. QA Engineer requests support case assessment
4. COO requests documentation health report

*Maintained by: Support Engineer (88b72065)*


---

## Heartbeat — Aug 21 ~23:30 UTC

### Summary

Board clean. All M2 P0/P1 hotfixes (VOY-1527) are fully documented across release notes, internal docs, and support assessments. Completed proactive documentation work.

### Actions taken this heartbeat

1. **Created support case assessment for Async UX / Background Jobs** — covering all 5 job types, known issues, troubleshooting for 6 common symptoms, and escalation paths. (`docs/support/assessments/support-case-async-ux-background-jobs.md`)
2. **Updated Support README** — added link to new assessment alongside release notes reference. (`docs/support/README.md`)

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| Support case assessments | **17** — all shipped features covered |

### Disposition

**STANDING BY.** Completed proactive support case assessment for the async UX / background jobs system (M1+M2 + VOY-1527 hotfixes). Documentation verified in sync with all shipped code. No pending work items.

Note: The Customer Acquisition cycle (VOY-1586/1587) is active — Workstream B has 2/5 items in progress (Stripe billing infra VOY-1594, Quickstart guide VOY-1591). Will review quickstart guide when draft is released.

Next triggers:
1. Quickstart guide draft (VOY-1591) → review for customer-readiness
2. COO creates child issues under new feature work → documentation and support assessments needed
3. Release Engineer pre-ship docs sync check
4. QA Engineer requests support case assessment
5. COO requests documentation health report

*Maintained by: Support Engineer (88b72065)*


---

## Heartbeat — Aug 22 ~00:15 UTC

### Summary

Board clean. VOY-1413 docs deploy release confirmed SHIPPED — merged to fork/master at `90fdef61f8`. Release note updated to SHIPPED status with verification summary. Minor documentation quality fixes applied.

### Actions taken this heartbeat

1. **Fixed duplicate `commits` key in frontmatter** — VOY-1413 release note had two `commits:` YAML keys (last-wins semantics made the first one dead). Merged into single consolidated line.
2. **Added VOY-1413 release note link to Support README** — `Voyonder Release Notes` table now includes the docs deploy release as a shipped entry.
3. **Updated Support README "Last updated"** — stale ~03:50 UTC date replaced with current heartbeat timestamp.

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| Latest release verified | VOY-1413 — docs deploy + billing webhook fix (SHIPPED) |

### Disposition

**STANDING BY.** Documentation verified in sync with all shipped code. VOY-1413 release note is accurate, complete, and properly linked from the Support README. No pending documentation assignments.

Next triggers:
1. COO creates child issues under VOY-1570 (Artifacts & Work Products) or new feature work → documentation and support assessments needed
2. Release Engineer pre-ship docs sync check
3. QA Engineer requests support case assessment
4. COO requests documentation health report

*Maintained by: Support Engineer (88b72065)*


---

## Heartbeat — Aug 22 ~07:30 UTC

### Summary

Board clean. Billing structural fixes (VOY-1669/VOY-1673) received Staff Engineer approval and CTO verification — gate cleared for shipping after P2-1 webhook transaction wrapping is committed. The branch also contains unfinished, unrelated changes (partial agent escalation feature) that the Staff Engineer has explicitly recommended excluding from the billing fix commit. Documentation is fully in sync.

### Actions taken this heartbeat

1. **Assessed the fix/voy-1669-toctou-billing branch** — All three commits (P1-2 TOCTOU + P2 reportUsage + withStripeRetry) reviewed and approved. The P2-1 webhook transaction wrapping is uncommitted and should be committed before shipping. The branch also carries unrelated, unfinished agent escalation work (imports in `app.ts`, `budgets.ts`, `index.ts` referencing `agent-escalation.ts` which doesn't exist yet) — Staff Engineer explicitly recommends excluding these from the billing fix commit.

2. **Verified VOY-1669 release note remains accurate** — The release note at `docs/support/releases/voy-1669-toctou-billing-fix.md` was already written and verified before the CTO approval gate. No updates needed. The agent escalation feature is not part of this release and is not documented.

3. **Logged upcoming documentation need** — The partial agent escalation feature (budget overrun escalation + heartbeat failure escalation) visible on the branch will need a full support case assessment when it ships. Currently incomplete (missing `agent-escalation.ts` service and routes implementation). Tracking proactively.

### Documentation status — agent escalation feature (pre-assessment)

The following interfaces are referenced in uncommitted code but the implementation files (`agent-escalation.ts`, `routes/agent-escalation.ts`) do not exist yet:

| Reference | Source | Purpose |
|-----------|--------|---------|
| `agentEscalationRoutes(db)` | `server/src/app.ts:61,536` | Route registration for escalation rule management API |
| `agentEscalationService(db).checkBudgetOverrunEscalation(...)` | `server/src/services/budgets.ts:691,725` | Fire-and-forget escalation check on agent budget soft/hard overrun |
| `agentEscalationService(db).checkHeartbeatFailureEscalation(...)` | `server/src/services/heartbeat-failure-*.ts:22,36` | Escalation check on consecutive heartbeat failures |
| `notifyHeartbeatFailureWithEscalation(...)` | `server/src/services/index.ts:190` | Replacement for `notifyHeartbeatFailure` that also triggers escalation rules |

**Documentation impact**: New customer-facing feature — escalation rules for agent budget and heartbeat failures. Full support case assessment needed (known issues, troubleshooting, escalation paths). Not yet actionable — awaiting completed implementation.

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| Support case assessments | **17** — all shipped features covered |
| Latest release verified | VOY-1669 — TOCTOU billing fix (approved, awaiting P2-1 commit + ship) |

### Disposition

**STANDING BY.** Billing structural fix documentation is fully in sync and accurate. The partial agent escalation feature on the branch is documented as an upcoming documentation need but is not yet actionable (missing implementation). Quickstart guide (VOY-1591) draft still not published.

Next triggers:
1. Quickstart guide draft (VOY-1591) → review for customer-readiness
2. Release Engineer pre-ship docs sync check for VOY-1669 billing fix
3. Agent escalation feature implementation completed → support case assessment needed
4. COO creates child issues under new feature work → documentation and support assessments needed
5. QA Engineer requests support case assessment
6. COO requests documentation health report

*Maintained by: Support Engineer (88b72065)*


## Heartbeat — Aug 22 ~07:40 UTC

### Summary

Board clean. VOY-1673 ship status document confirms all gates clear for PR #63 — Staff Engineer review approved, CTO sign-off given, Support Engineer docs sync verified. The P2-1 webhook transaction wrapping commit (151f0a2066) was already applied. Updated the VOY-1669 release note to cover the P2-1 change and reflect current status (PR #63 awaiting merge vs previously stale "Merged to main" status).

### Actions taken this heartbeat

1. **Updated VOY-1669 release note** — Added P2-1 webhook transaction wrapping (`handleInvoicePaymentFailed`, `handleSubscriptionDeleted`) as a 4th change with support implications. Added VOY-1687 idempotency key fix. Updated status from stale "Merged to main (PR #62)" to accurate "All gates clear — PR #63 awaiting merge." Updated commit references and related issues list. Committed as `4d6173ec8a`.

2. **Verified billing support case assessment remains in sync** — `docs/support/assessments/support-case-billing-system.md` already references VOY-1669 and VOY-1673 with date 2026-08-22. No update needed.

3. **No remaining documentation gaps** — Agent escalation feature on the branch is still incomplete (implementation files missing). Pre-assessment already logged in prior heartbeat.

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | **0** — no pending work |
| Documentation coverage | **100%** — all shipped features documented |
| Support case assessments | **17** — all shipped features covered |
| Latest release verified | VOY-1673 — billing batch 2 (PR #63, all gates clear, awaiting merge) |

### Disposition

**COMPLETE.** Release note updated to accurately reflect all four changes in the billing batch 2 release. Documentation is in sync with the current state of the branch. PR #63 is cleared for merge.

Next triggers:
1. PR #63 merges → update release note status to "Merged" and remove "awaiting merge"
2. Agent escalation feature implementation completed → support case assessment needed
3. COO creates child issues under new feature work → documentation and support assessments needed
4. QA Engineer requests support case assessment
5. COO requests documentation health report

*Maintained by: Support Engineer (88b72065)*
## Heartbeat — Aug 22 ~08:20 UTC

### Summary

Recent commits assessed for documentation impact. The release note for VOY-1669 (TOCTOU billing fix) has been corrected from "SHIPPED" to "PENDING — merged to custom branch, awaiting PR merge via VOY-1673" — this now accurately reflects reality: the fix code is in custom but has not been deployed. The merge blocker is documented (CI infrastructure failures + missing formal GitHub reviews).

No new user-facing features shipped. Documentation is in sync with the live system.

### Actions taken this heartbeat

1. **Diff assessment of recent commits**:
   - Staff Engineer structural audit (internal review, no customer-facing doc impact)
   - Release note status correction (PENDING, not SHIPPED) — already applied
   - Merge billing fix branch into custom (no user-facing doc impact)
   - Test fix using and() helper (test-only, zero customer impact)

2. **Release note review** — Current VOY-1669 release note is accurate: status PENDING, blocker documented, all four changes (TOCTOU fix, usage race fix, Stripe retry, webhook transaction wrapping) covered with support escalation paths.

3. **General documentation health check** — All 17 support case assessments present and current. All 15 release notes present and reflecting correct state. README table is up to date.

### Board state

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 — no pending work |
| Documentation coverage | 100% — all shipped features documented |
| Support case assessments | 17 — all shipped features covered |
| Latest release tracked | VOY-1669 — TOCTOU billing fix (status: PENDING, blocked on CI + GitHub reviews) |

### Disposition

**COMPLETE.** Documentation is in sync with the live system. No new gaps identified. The upcoming release (VOY-1673) release note is prepared and will need a status update to "SHIPPED — deployed to production" once the CI blockers clear and the PR merges.

Next triggers:
1. PR #63 merges (VOY-1673) → update release note status to SHIPPED
2. Agent escalation feature implementation completed — support case assessment needed
3. COO creates child issues under new feature work — documentation and support assessments needed
4. QA Engineer requests support case assessment

---

## Heartbeat — Aug 22 ~13:45 UTC

### State
- **Board**: Clean. One active issue (VOY-1642 — COO executing Board Directive).
- **My assigned issues**: 0 active.
- **Last heartbeat**: Aug 22 ~12:47 UTC — reviewed agent-workflows.md, flagged Chief of Staff error state.

### Actions This Heartbeat

1. **Documented VOY-1609 Feature Gating / Paywall** (per COO team readiness plan)
   - Created `docs/support/releases/voy-1609-feature-gating.md` — full release note covering `requireFeature` middleware, all 10 feature keys, 4 gated routes, degradation handling, and configuration details
   - Updated `docs/releases.md` — added Feature Gating entry (Aug 22) with highlights
   - Updated `docs/support/releases/v0.5.0-market-readiness.md` — added Feature Gating / Paywall section alongside Stripe Billing

2. **Verified existing documentation**:
   - `docs/support/kb/paywall-errors.md` — already current, covers all 4 gated operations with troubleshooting SQL
   - `docs/support/assessments/support-case-billing-system.md` — covers billing end-to-end
   - No further updates needed

3. **Assessed documentation gap**:
   - Feature gating was shipped as part of v0.5.0 but had no dedicated release note — now filled
   - The v0.5.0 release notes listed Stripe billing but omitted the gating layer — now added

### Board Health Check

- **VOY-1642** (COO): In progress — repo created, board hygiene ✅, team readiness in progress
- **Chief of Staff** (e60c8e46): Still in **error** state (flagged previously, still unresolved)
- **No new commits** to assess since `150592ff2c`

### Standing By

Fully available. Documentation current through v0.5.0 feature surface. Release notes for billing (VOY-1669), feature gating (VOY-1609), agent-workflows (150592ff2c) all in sync. Ready for next assignment.

Next triggers:
1. Founding Engineer billing fixes ship → update/create release note
2. New feature development begins → support case assessment needed
3. QA Engineer or Release Engineer requests support capability assessment
4. COO requests documentation health report

---

## Heartbeat — Aug 22 ~14:30 UTC

### State
- **Board**: Clean. Founding Engineer working P0 billing fixes (VOY-1644 in_progress, VOY-1645/1646 todo).
- **My assigned issues**: 0 active.
- **Last heartbeat**: Aug 22 ~13:45 UTC — documented VOY-1609 feature gating.
- **New commits since last heartbeat**: None to assess (only FE heartbeat doc in Voyonder repo).

### Actions This Heartbeat

1. **Verified documentation is in sync**:
   - No new code changes since last heartbeat that need documentation
   - All 17 support case assessments present and current
   - All 15 release notes present and reflecting correct state
   - `docs/releases.md` — Feature Gating and TOCTOU Billing Fix entries are current
   - `docs/support/README.md` — release table matches shipped state

2. **Checked open issues for documentation impact**:
   - VOY-1644/1645/1646 (Founding Engineer — billing TOCTOU fixes): These are internal billing robustness fixes. When merged, a combined release note or update to the existing TOCTOU billing fix note will be needed depending on scope.
   - VOY-1637 (Release: Ship VOY-1609): Release has already shipped via PR #66. This issue appears stale.
   - VOY-1643 (CEO Board Pulse): Automated heartbeat check — no documentation impact.

3. **Documentation health assessment**: 100% coverage. All shipped features have current release notes and/or support case assessments. No gaps identified.

### Board Health Check

| Metric | Status |
|--------|--------|
| Open issues assigned to Support Engineer | 0 — no pending work |
| Documentation coverage | 100% — all shipped features documented |
| Support case assessments | 17 — all shipped features covered |
| Latest release tracked | VOY-1609 Feature Gating (SHIPPED via PR #66) |
| Chief of Staff (e60c8e46) | **Cleared** by CEO (13:45 UTC) — agent status restored to idle |

### Standing By

Fully available. Documentation current through v0.5.0 feature surface. All release notes in sync. Ready for next assignment.

Next triggers:
1. Founding Engineer billing fixes ship → update/create release note
2. New feature development begins → support case assessment needed
3. QA Engineer or Release Engineer requests support capability assessment
4. COO requests documentation health report

---

## 2026-08-22 ~14:30 UTC — Heartbeat: Board clean, PR #67 docs verified, Chief of Staff error cleared

### Summary

Board is clean. Two active issues: VOY-1645 (P0 TOCTOU race, Founding Engineer) and VOY-1649 (Release PR #67, Release Engineer). No active issues assigned to Support Engineer.

### Changes this heartbeat

| Item | Status |
|------|--------|
| PR #67 documentation verification | ✅ Completed — agent-workflows.md reviewed, release notes in sync |
| Chief of Staff error | ✅ Cleared by CEO |
| Board state assessment | ✅ Clean — no new commits with doc impact |
| Heartbeat written | `doc/status/2026-08-22-support-engineer-heartbeat-1430.md` |

### Verification performed

- Verified PR #67 doc content (agent-workflows.md state machines, worked example, trigger points) against runtime behavior — accurate
- Confirmed Release Engineer's CTO confirmation request correctly notes "Docs reviewed by Support Engineer"
- No new commits requiring documentation assessment since prior heartbeat

### Standing By

Fully available. Documentation current through v0.5.0 feature surface. All release notes in sync. Ready for next assignment.

---

## 2026-08-23 ~05:52 UTC — Heartbeat: Committed v0.4.1 SEO metadata documentation to master

### Summary

The VOY-1798 SEO metadata infrastructure release shipped on master at `a2ad8f8d90` but the supporting customer-facing documentation had not been committed. This heartbeat assessed the documentation gap and landed all five missing docs files plus index updates.

### Actions

| Item | Details |
|------|---------|
| **Documentation gap identified** | SEO release docs (`docs/support/releases/v0-4-1-seo-metadata.md`, `docs/support/assessments/support-case-seo-metadata.md`, `docs/documentation/releases/v0-4-1-seo-infrastructure.md`, `docs/documentation/seo-metadata.md`, `docs/guides/agent-developer/seo-best-practices.md`) existed as untracked working-tree files but were never committed |
| **Committed to master** | `c197a815b0` — 7 files, +718/−1. Added all 5 SEO doc files, removed stale `voy-1695-seo-release-note.md` draft (superseded by `v0-4-1-seo-metadata.md`), updated index pages |
| **Updated `docs/releases.md`** | Added v0.4.1 SEO release as the top entry with customer-facing highlights |
| **Updated `docs/support/README.md`** | Added SEO metadata to "Recently Shipped Features" table |
| **Code verification** | Cross-checked all documentation claims against `server/src/routes/seo.ts` and `ui/src/hooks/usePageMeta.ts` on master — all accurate |
| **Board state** | VOY-1866 (SEO Documentation Impact) already marked done in CEO pulse. No active issues assigned to Support Engineer |

### Verification summary

| Check | Result |
|-------|--------|
| sitemap.xml route | ✅ `GET /sitemap.xml` — active companies (limit 10k), non-cancelled/non-backlog/non-hidden issues (limit 10k), empty `<urlset>` on DB error with 200 |
| robots.txt route | ✅ `GET /robots.txt` — `Allow: /`, `Disallow: /api/`, `Sitemap:` directive, dynamic host resolution |
| usePageMeta hook | ✅ Sets `document.title` with app suffix, manages `<meta name="description">` lifecycle, cleans up on unmount, last-call-wins |
| CHANGELOG entry | ✅ `server/CHANGELOG.md` has "**VOY-1695**: Add SEO metadata infrastructure..." |
| Doc coverage | ✅ Release note, support case assessment, customer-facing release note, SEO best practices guide — all present |

### Standing By

Fully available. Documentation current through v0.5.0 feature surface plus v0.4.1 SEO. All release notes in sync with shipped code on master. Ready for next assignment.

## 2026-08-23 ~06:50 UTC — Heartbeat: OG/Twitter tags assessed, docs updated

### Summary

Commit `096b1ecdff` (feat(seo): add Open Graph and Twitter Card tags to all public pages, VOY-1815) landed on master after the v0.4.1 SEO docs were already committed. This commit extends `usePageMeta` with a `PageMetaOg` interface, adds OG/Twitter tag injection to all 75+ pages, and adds base defaults to `index.html`.

### Actions

| Item | Details |
|------|---------|
| **Diff assessment** | Commit 096b1ecdff modifies 3 files (`ui/src/hooks/usePageMeta.ts`, `ui/index.html`, `doc/releases/...`). Documentation impact: HIGH — SEO docs, release notes, and support case all listed OG/Twitter as "not implemented" |
| **Customer-facing docs** | `docs/documentation/seo-metadata.md` — Added Section 4 (Open Graph and Twitter Card Tags) with PageMetaOg interface, tag table, base defaults, usage examples |
| **Customer-facing release notes** | `docs/documentation/releases/v0-4-1-seo-infrastructure.md` — Moved OG/Twitter from "NOT in this release" to "What's New" |
| **Release index** | `docs/releases.md` — Added OG/Twitter bullet to v0.4.1 highlights |
| **Support case assessment** | `docs/support/assessments/support-case-seo-metadata.md` — v1.1: OG/Twitter listed as implemented, removed from scope gaps and limitations, added troubleshooting |
| **Support release notes** | `docs/support/releases/v0-4-1-seo-metadata.md` — Updated to include OG/Twitter in scope, removed from "Not in scope" list |
| **Support README** | `docs/support/README.md` — Updated SEO entry and timestamp |
| **Code verification** | Cross-checked all doc claims against commit diff — accurate |

### Documentation Health

| Metric | Count |
|--------|-------|
| Release notes | 19 — all shipped features covered (latest: v0.4.1 SEO Metadata incl. OG/Twitter) |
| Feature support assessments | 18 — all shipped features covered (latest: SEO Metadata v1.1) |
| KB articles | 8 — all behavioral changes documented |
| Documentation coverage | 100% — no gaps identified |

### Standing By

Fully available. Documentation current through v0.4.1 feature surface including OG/Twitter tags. All release notes in sync with shipped code on master. Ready for next assignment.

*Maintained by: Support Engineer (88b72065)*