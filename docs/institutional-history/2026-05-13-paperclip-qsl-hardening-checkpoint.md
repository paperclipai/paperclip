# Paperclip / QSL Hardening Checkpoint — May 12–13, 2026

## Session Overview

Full day/night hardening session spanning May 12–13, 2026. This session transformed Paperclip from a loosely coupled agent framework into a hardened institutional operating system with durable governance, persistent review state, liveness protection, adapter correctness, provider routing foundations, and backup/recovery infrastructure.

Work was executed across five merged PRs and one institutional backup framework commit, each following a deliberate hardening order: persistence before autonomy, liveness before routing, backup before live fallback.

---

## PR Lineage

### PR #5 — QSL Review Persistence

**Branch:** `feat/qsl-review-persistence`
**Status:** Merged → `c6d2481a`

Root cause fix: browser refresh was reloading raw bridge findings instead of DB-backed review state, causing reviewed findings to reappear as fresh. Fixes included:

- Company-scoped findings routing (`/api/qsl/companies/:companyId/findings`)
- DB-backed persistence on refresh instead of raw bridge data
- Durable review states: approved, denied, recurring, pending_review, accepted_risk, suppressed, escalated
- Recurring finding reconciliation with occurrence count increment
- Review history tracking (reviewer, timestamp, previous state, notes)
- Active queue filtering (denied/reviewed findings no longer reappear)
- Debug diagnostics: X-QSL-Source header, bridge-vs-DB tracing

**Key commits:**
- `4897725f` feat(qsl): persist review state in database across refreshes and rescans
- `479e73fd` fix(qsl): route company ID through URL path for finding persistence
- `dc996d59` feat(qsl): harden review states and add active queue filtering
- `c990512c` debug(qsl): add persistence diagnostics and error resilience

### PR #11 — Liveness / Deadlock Hardening

**Branch:** `feat/liveness-deadlock-hardening`
**Status:** Merged → `22861627`

Addressed continuation loops, stuck in_progress states, and recursive wake behavior discovered during TrustScore testing.

- Duplicate-error continuation guard (prevents recursive loops)
- Tiered staleness detection: 4h warning, 12h auto-recovery
- Watchdog snooze cap: 7-day maximum
- Liveness telemetry action constants
- Architecture changelog, risk register, liveness report

**Key commits:**
- `e9050cdb` feat(recovery): harden liveness/deadlock detection subsystem
- `12d15bb1` docs(governance): add architecture changelog, risk register, and liveness report

### PR #12 — Hermes Adapter Fix

**Branch:** `fix/hermes-adapter-skills`
**Status:** Merged → `428939fe`

Restored `listSkills` and `syncSkills` methods on the Hermes local adapter, which had been dropped during prior refactoring. Without this fix, the adapter would fail silently when the runtime queried for available skills.

**Key commit:**
- `5c2469b9` fix(hermes): restore listSkills/syncSkills on hermesLocalAdapter

### PR #13 — Provider Routing Stage 0 Foundation

**Branch:** `feat/provider-routing-stage0`
**Status:** Merged → `ef140697`

Foundation-only infrastructure for provider-aware routing. Stage 0 is intentionally non-functional — no live fallback is enabled. This PR establishes the routing abstraction layer so that future stages can add logging, scoring, and actual failover.

- Provider routing type definitions and configuration
- `claude_quota_exhausted` error code handling
- Test updates for quota exhaustion path

**Key commits:**
- `cd9998f6` feat(routing): add provider routing infrastructure (Stage 0)
- `4fe7d3b3` test: update claude-local execute test for claude_quota_exhausted error code

### PR #9 — Institutional Backup / Recovery Framework

**Branch:** (institutional backup)
**Status:** Committed → `137dd161`

Established the institutional backup and disaster recovery framework. This is the foundation for validated restore paths and operational continuity.

**Key commit:**
- `137dd161` feat: add institutional backup and disaster recovery framework

---

## Current Stable System State

As of May 13, 2026 02:00 UTC, master (`ef140697`) includes all five PRs merged.

### What Is Done

- QSL review persistence: human governance decisions survive browser refresh and rescans
- Liveness/deadlock detection: tiered staleness, continuation-loop guards, snooze caps
- Hermes adapter: listSkills/syncSkills restored
- Provider routing Stage 0: type definitions, error codes, routing abstraction (no live fallback)
- Backup/recovery framework: institutional backup structure in place
- Board intelligence export system: governance.md, board_review_packet.md, company_map, agents, issues
- Approval governance: no-bulk-approval rule, deduplication, risk classification
- CrawDaddy governance team: GateKeeper, QA Engineer, TrustScore, WatchDog agents

### What Is Not Done

- Provider Routing Stage 1 (logging-only observation mode) — not started
- Provider Routing Stage 2+ (live fallback) — not started, explicitly deferred
- Backup restore path end-to-end validation — not yet tested
- QSL Review UI production verification — not confirmed in production
- Data confidence layer — classification added but not yet integrated into routing decisions
- Quota-aware scheduling — deferred until routing matures

---

## Known Unresolved Issues

### Moltbook API HTTP 500

The Moltbook integration endpoint returns HTTP 500 errors. Root cause not yet diagnosed. Does not block core operations but blocks Moltbook-dependent workflows.

### blocdev_bot Loop / Completion-State Failure

The `blocdev_bot` agent enters a loop or fails to reach a terminal completion state. Related to the broader liveness/deadlock patterns addressed in PR #11, but this specific agent's behavior has not been resolved.

### QSL Review UI Production Verification

QSL review persistence has been validated in test but has not yet been verified in production. The UI must be observed under real production load to confirm that review states persist correctly across refreshes, rescans, and concurrent users.

---

## Major Architectural Lessons

### 1. Persistence Before Autonomy

Autonomous agents must not operate on transient state. If human review decisions are ephemeral, the entire governance layer is theater. PR #5 established this foundation.

### 2. Liveness Before Routing

Multi-provider routing multiplies failure modes. Without robust liveness detection, a stuck agent on Provider A would not be caught before failover to Provider B, creating cascading ambiguity. PR #11 must precede any routing work.

### 3. Backup Before Live Fallback

Live fallback between providers is operationally complex. If the system cannot reliably back up and restore its own state, provider failover becomes a mechanism for data loss, not resilience.

### 4. Verification Before Execution Claims

A test passing is not the same as production working. The QSL persistence bug was not a test failure — it was a production behavior that tests did not exercise. Claims of completion require production observation.

### 5. Human-Governed Autonomous Infrastructure

Paperclip is not a fully autonomous system. It is a human-governed system with autonomous capabilities. The Board reviews, the human approves/denies, the system remembers and enforces. This ordering is constitutional, not optional.

---

## Next Recommended Work

1. **Validate backup restore path end-to-end** — Run a full backup → destroy → restore cycle against a non-production instance. Do not assume the backup framework works until a restore has been observed.

2. **Observe system stability 24–48h** — With all five PRs merged, let the system run under normal operational load. Watch for liveness alerts, continuation loops, or unexpected agent behavior.

3. **Inspect QSL Review UI production behavior** — Manually verify that review decisions persist across browser refresh, page navigation, and rescan cycles in the production environment.

4. **Begin Provider Routing Stage 1 (logging-only)** — Instrument provider selection decisions as telemetry/logs without changing any routing behavior. Observe which providers would be selected under what conditions.

5. **Do not enable live fallback yet** — Stage 2+ provider routing (actual failover) must wait until Stage 1 logging has been observed for a sufficient period and backup restore has been validated.

---

## Infrastructure Access

Production EC2 instance:

```
ssh -i "C:\Users\mikeb\.ssh\clawdbot-clean.pem" ubuntu@3.20.79.143
```

---

## Hardening Order Reference

```
1. Persistence          ✅ (PR #5)
2. Liveness/Deadlock    ✅ (PR #11)
3. Adapter Correctness  ✅ (PR #12)
4. Provider Routing S0  ✅ (PR #13)
5. Backup Framework     ✅ (PR #9 / 137dd161)
6. Backup Validation    ⬜ (next)
7. Stability Soak       ⬜ (next)
8. Production QSL UI    ⬜ (next)
9. Provider Routing S1  ⬜ (logging-only)
10. Provider Routing S2 ⛔ (not yet — requires validated backup + stability)
```

---

*Checkpoint recorded: May 13, 2026*
*Session span: May 12 ~10:00 → May 13 ~02:00 UTC*
