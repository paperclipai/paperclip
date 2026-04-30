# Phase 51: One-Liner to Board Capture Flow - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 51-one-liner-to-board-capture-flow
**Areas discussed:** Board review surface, web One-Liner promotion, draft review fields, mobile/native/inbound evidence, API/data contract, product copy/layout, verification
**Mode:** auto

---

## Board Review Surface

| Option | Description | Selected |
|--------|-------------|----------|
| Board inbox/review strip | Show capture drafts from `daily-work` while preserving the three canonical lanes. | yes |
| Fourth persisted lane | Add a new kanban lane for capture drafts. | |
| One-Liner-only queue | Keep review on the One-Liner page and link out from board. | |

**Auto choice:** Board inbox/review strip.
**Notes:** Phase 49 locked `할 일 / 진행 중 / 완료` as canonical lanes, so capture review should attach to the board without changing lane semantics.

---

## Web One-Liner Promotion

| Option | Description | Selected |
|--------|-------------|----------|
| Reviewable draft first | Web One-Liner creates a draft that shares inbound review/promote flow. | yes |
| Direct task creation | Continue creating tasks directly from the web page. | |
| UI-only pending card | Show a temporary board card before backend promotion. | |

**Auto choice:** Reviewable draft first.
**Notes:** Existing inbound draft APIs already provide duplicate warning, source evidence, semantic context, promote, and fail behavior.

---

## Draft Review Fields

| Option | Description | Selected |
|--------|-------------|----------|
| Full operator review | Expose target/work type, title, deliverable, price/quality hints, OKR/KPI candidate, assignee/context, and source note. | yes |
| Minimal title/price review | Only edit task title and base price before promotion. | |
| Trust parser output | Promote parser output without field-level revision. | |

**Auto choice:** Full operator review.
**Notes:** CAPTURE-02 explicitly requires suggested work type, deliverable candidate, price/quality hints, and OKR/KPI candidate approval or revision.

---

## Mobile Native And Inbound Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Shared board queue | Mobile/native/inbound drafts appear in the same board review flow with duplicate and source evidence. | yes |
| Separate inbound page | Keep mobile/native drafts outside the board. | |
| Promote duplicates by default | Treat duplicate drafts as normal drafts unless operator blocks them. | |

**Auto choice:** Shared board queue.
**Notes:** CAPTURE-03 requires mobile/native/inbound drafts to use the same board review flow with duplicate warning and source evidence.

---

## API And Data Contract

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse and extend narrow contracts | Reuse capture queue/promote/fail endpoints and add only missing draft revision support. | yes |
| New capture subsystem | Build separate board capture APIs and tables. | |
| Client-only revision | Keep edited draft values only in React state until promotion. | |

**Auto choice:** Reuse and extend narrow contracts.
**Notes:** `rt2-work-board` already owns capture drafts and audit trail. Persistent revision may need a narrow route if reviewed values must survive navigation.

---

## Product Copy And Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Korean operations queue | Compact RealTycoon2/Korean board-attached review UI. | yes |
| Explanatory capture landing section | Larger instructional area explaining capture concepts. | |
| English technical status labels | Keep API status names visible to operators. | |

**Auto choice:** Korean operations queue.
**Notes:** AGENTS.md and Phase 48-50 decisions require Korean-first product-facing copy and utilitarian board UX.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Focused UI/shared/server coverage | Add focused tests for draft visibility, duplicate/source evidence, promotion, board refetch, and route contracts. | yes |
| UI-only smoke tests | Cover only visible board behavior. | |
| Full suite only | Depend on `pnpm test` alone. | |

**Auto choice:** Focused UI/shared/server coverage.
**Notes:** Prior phases record Windows full-suite timeout as accepted debt, so focused tests plus `pnpm typecheck` are the reliable completion evidence.

---

## the agent's Discretion

- Exact capture inbox placement on the daily board.
- Whether web capture uses the existing inbound draft endpoint with a web-compatible source variant or a narrow dedicated web draft route.
- Exact OKR/KPI candidate heuristic, provided weak inference remains explicit and operator-approved.

## Deferred Ideas

- Jarvis/wiki/graph/economy detailed evidence panels remain Phase 52.
- Broader identity/Korean UX regression gate remains Phase 52.
- Advanced LLM inference for One-Liner parsing is future scope.
