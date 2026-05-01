# Phase 66: Daily Work and OKR Cockpit Convergence - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-01
**Phase:** 66-daily-work-and-okr-cockpit-convergence
**Areas discussed:** Three-panel daily cockpit, One-Liner review evidence, Mission-to-To-Do rollup, DevPlan alignment closure

---

## Three-Panel Daily Cockpit

| Option | Description | Selected |
|--------|-------------|----------|
| Converge existing `DailyWorkPage`/`Rt2DailyBoard` | Reuse the existing first operating screen and strengthen its three panels. | yes |
| Build a new cockpit page | Higher churn and duplicate board logic. | |
| Move cockpit pieces into separate routes | Weakens the "first operating screen" requirement. | |

**User's choice:** `[auto]` Selected the existing daily cockpit convergence path.
**Notes:** This respects Phase 49-51 decisions and avoids reopening lane/quick-edit/capture architecture.

---

## One-Liner Review Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Add cockpit filters and reliability report | Source/status/evidence filters plus source-level reliability metrics in the same board. | yes |
| Leave review queue as simple list | Does not satisfy cockpit-level traceability for source failures, retries, and promotions. | |
| Move review reliability to a separate operations page | Loses the one-cockpit flow required by DAILY-02. | |

**User's choice:** `[auto]` Selected cockpit-local review evidence with server query support.
**Notes:** Promoted draft evidence remains visible through original draft/revision and created object IDs.

---

## Mission-To-To-Do Rollup

| Option | Description | Selected |
|--------|-------------|----------|
| Add `hierarchyRows` to the daily cockpit contract | API and UI both expose path nodes plus rollup evidence. | yes |
| Reconstruct hierarchy only in React | UI can show it, but API/UI consistency remains unproven. | |
| Add a new Mission/Object/KR schema | Larger schema work not needed for Phase 66. | |

**User's choice:** `[auto]` Selected explicit `hierarchyRows` on the existing read model.
**Notes:** Existing `goals.level` and parent chain are sufficient for now; schema expansion is deferred.

---

## DevPlan Alignment Closure

| Option | Description | Selected |
|--------|-------------|----------|
| Mark Phase 66 rows complete after focused evidence | Updates daily cockpit and hierarchy rows to complete, score to 72%. | yes |
| Leave rows partial until Phase 71 | Understates completed Phase 66 evidence and blocks downstream truth. | |
| Mark all v3.1 rows complete | Overclaims future phases and violates Phase 65 evidence rules. | |

**User's choice:** `[auto]` Selected evidence-backed Phase 66 row completion only.
**Notes:** Phase 71 still owns final v3.1 acceptance score delta.

---

## the agent's Discretion

- Exact compact spacing of the OKR tree in the left cockpit panel.
- Exact source reliability label wording.
- Whether route-level filters are also mirrored in UI-local controls.

## Deferred Ideas

- New dedicated Mission/Object/KR schema.
- Runtime progress stream and cancellation evidence.
- wikiLLM export/update loop.
- Graphify v3 corpus sidecar.
- Marketplace/P&L/CareerMate loop.
