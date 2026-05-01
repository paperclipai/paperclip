# Phase 68: wikiLLM Living Memory Workflow - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-01
**Phase:** 68-wikiLLM Living Memory Workflow
**Mode:** auto
**Areas discussed:** wikiLLM file model, living memory update evidence, Jarvis citation and draft loop, operator surface, DevPlan alignment and verification

---

## wikiLLM File Model

| Option | Description | Selected |
|--------|-------------|----------|
| DB/event projector remains canonical, markdown is export/materialized output | Reuse existing `rt2V33WikiPages`, `rt2V33DailyWikiPages`, and projector architecture while making the file model stricter. | yes |
| Markdown vault becomes the primary write path | More wiki-native, but conflicts with existing RT2 event-first architecture and approval/audit model. | |
| Separate wikiLLM subsystem | Clear boundary, but duplicates projector/search/Jarvis plumbing and risks product siloing. | |

**User's choice:** `[auto] Selected recommended default: DB/event projector remains canonical, markdown is export/materialized output.`
**Notes:** Existing code already materializes `index.md`, `log.md`, and topic pages; Phase 68 should expand this to explicit project/schema pages and wikiLLM export metadata.

---

## Living Memory Update Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Structured related-page update evidence | Capture pages touched, source events, confidence, contradiction status, and related page keys for each projection/update. | yes |
| Only update markdown content | Simpler, but fails WIKI-02 because provenance/confidence/contradiction evidence is not inspectable. | |
| Only rely on graph edge evidence | Useful but belongs partly to Phase 69 and would conflate wikiLLM memory with Graphify sidecar scope. | |

**User's choice:** `[auto] Selected recommended default: Structured related-page update evidence.`
**Notes:** Reuse `sourceEventIds`, metadata, semantic freshness, graph confidence vocabulary, and contradiction candidates instead of inventing parallel evidence systems.

---

## Jarvis Citation And Draft Loop

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing Jarvis citations and rewrite proposals | Reuse `getTaskAdvice`, hybrid-search citations, `rt2JarvisRewriteProposals`, evals, approvals, and audit logs. | yes |
| Create a separate wiki assistant | Adds a new silo and duplicates Jarvis governance. | |
| Allow direct autonomous wiki updates | Faster but violates approval-first autonomy decisions from prior phases. | |

**User's choice:** `[auto] Selected recommended default: Extend existing Jarvis citations and rewrite proposals.`
**Notes:** Wiki update suggestions should be reviewable drafts with before/after markdown, citations, contradiction IDs, eval, risk, and approval evidence.

---

## Operator Surface

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing Knowledge/Daily/Jarvis surfaces | Keeps memory attached to the daily work loop and existing RealTycoon2 UI. | yes |
| Add a new wikiLLM-branded page | Clear for engine parity, but product-facing engine branding and extra navigation are unnecessary. | |
| Keep everything API-only | Easier but fails user-visible inspection/review expectations. | |

**User's choice:** `[auto] Selected recommended default: Extend existing Knowledge/Daily/Jarvis surfaces.`
**Notes:** Product copy should stay Korean-first and describe living memory/citations/reviewable updates rather than presenting wikiLLM as an operator-facing product name.

---

## DevPlan Alignment And Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Mark complete only after file model, update evidence, citations, drafts, UI/API, and focused tests exist | Conservative and consistent with Phase 65 evidence-backed completion rule. | yes |
| Mark complete once projector/export exists | Too weak; current row is already partial and needs Jarvis/update-loop proof. | |
| Defer all score changes to Phase 71 | Phase 71 owns final score delta, but Phase 68 should update its own proven row. | |

**User's choice:** `[auto] Selected recommended default: Evidence-backed Phase 68 completion only.`
**Notes:** Default verification remains `pnpm typecheck && pnpm test`; Playwright e2e is not a default gate.

## the agent's Discretion

- Exact field names for page update evidence.
- Whether wikiLLM export is a new route or a stricter mode of existing vault export.
- Exact UI placement for citation/update evidence.
- Exact migration strategy for expanded page types while preserving existing pages.

## Deferred Ideas

- Phase 69 Graphify v3 corpus graph sidecar.
- Phase 70 economy/P&L/CareerMate loop.
- Phase 71 final v3.1 acceptance score delta.
- Full local vault writer daemon/watch loop.
- Autonomous Jarvis direct wiki apply without approval.
