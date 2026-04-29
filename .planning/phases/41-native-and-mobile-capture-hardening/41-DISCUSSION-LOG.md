# Phase 41: Native and Mobile Capture Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-29
**Phase:** 41-native-and-mobile-capture-hardening
**Areas discussed:** Capture source trust and installation, inbound draft review queue, promotion and knowledge continuity, mobile knowledge search, verification
**Mode:** auto

---

## Capture Source Trust And Installation

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing inbound draft source model | Reuse current Slack/Teams/webhook/mobile/native source enum and add company-scoped installation/signing evidence around it. | yes |
| Create separate capture connector subsystem | Build new source/install records and routes disconnected from One-Liner inbound drafts. | |
| Treat sources as display-only labels | Keep accepting source strings without verification or installation evidence. | |

**User's choice:** Auto-selected recommended default.
**Notes:** `[auto] Capture source trust and installation -> Extend existing inbound draft source model.` This keeps Phase 41 as hardening of shipped Phase 23 capture behavior.

---

## Inbound Draft Review Queue

| Option | Description | Selected |
|--------|-------------|----------|
| Enrich existing `/rt2/capture-drafts` queue | Add source evidence, signing status, semantic context, duplicate warning, and promotion readiness to current queue contracts. | yes |
| Add a separate inbox | Create a new review surface independent of capture drafts. | |
| Keep queue minimal | Leave semantic context and source evidence outside the review queue. | |

**User's choice:** Auto-selected recommended default.
**Notes:** `[auto] Inbound draft review queue -> Enrich existing queue.` Operators should see context and warnings where review decisions happen.

---

## Promotion And Knowledge Continuity

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit promotion with audit and indexing continuity | Preserve operator promotion to task/todo/deliverable while carrying source evidence into activity log, metadata, wiki, and semantic indexing paths. | yes |
| Automatic promotion | Promote trusted drafts directly into work objects without review. | |
| Queue-only hardening | Improve source and queue evidence but leave promotion/indexing continuity unverified. | |

**User's choice:** Auto-selected recommended default.
**Notes:** `[auto] Promotion and knowledge continuity -> Explicit promotion with audit and indexing continuity.` This matches RT2 approval/audit principles.

---

## Mobile Knowledge Search

| Option | Description | Selected |
|--------|-------------|----------|
| Harden existing KnowledgePage search for small viewports | Keep semantic result, lexical fallback, citation target, freshness, confidence, and contradiction evidence visible without overflow. | yes |
| Build standalone mobile search app | Create a separate native/mobile search product surface. | |
| Hide advanced evidence on mobile | Simplify mobile by removing fallback/citation/staleness signals. | |

**User's choice:** Auto-selected recommended default.
**Notes:** `[auto] Mobile knowledge search -> Harden existing KnowledgePage search.` Store-distributed native app remains out of scope.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic route/service/UI coverage | Cover signed/unsigned, duplicate, stale semantic evidence, promotion audit, and mobile layout without live Slack/Teams/native/provider dependencies. | yes |
| Live provider/API verification | Require live Slack/Teams or provider-backed semantic services in default verification. | |
| UI-only verification | Check only visible screens and skip route/service edge cases. | |

**User's choice:** Auto-selected recommended default.
**Notes:** `[auto] Verification -> Deterministic route/service/UI coverage.` Default command remains `pnpm typecheck && pnpm test`.

---

## the agent's Discretion

- Exact table names and endpoint names.
- Exact signature algorithm and canonical payload fields, provided deterministic accepted/blocked/stale cases are covered.
- Exact mobile search layout, provided citation/evidence signals remain visible and text does not overflow.

## Deferred Ideas

- App-store native distribution, push notifications, and OS-level share extension packaging.
- Live Slack/Teams OAuth installation and production webhook secret rotation.
- Automatic capture promotion without operator review.
- Jarvis autonomous rewrite proposal/eval guardrails.
