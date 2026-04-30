# Phase 49: Daily Work Kanban Core - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in `49-CONTEXT.md` are canonical.

**Date:** 2026-04-30
**Phase:** 49-daily-work-kanban-core
**Mode:** discuss `--auto --chain`

## Auto-Selected Gray Areas

### First operational route

- **Question:** Should the daily board become the first work surface, or remain nested behind existing knowledge/dashboard routes?
- **Auto-selected:** Make a dedicated daily work board route the company default.
- **Reason:** BOARD-01 requires the daily board to be reachable as the first operational work surface, and Phase 48 explicitly left this to Phase 49.

### Lane semantics

- **Question:** Should the board keep `today/support_1/support_2`, or switch to To-Do/Doing/Done?
- **Auto-selected:** Use To-Do/Doing/Done as canonical visible lanes and normalize/migrate old lane values.
- **Reason:** BOARD-02 names To-Do, Doing, Done explicitly. Existing support-lane language is too vague for the phase requirement.

### Card metadata

- **Question:** How much card metadata should appear without opening a detail view?
- **Auto-selected:** Show Task/To-Do type, owner, due date, OKR/KPI link, deliverable, price, and quality state on the card front.
- **Reason:** BOARD-03 requires these details without deep navigation.

### Existing asset reuse

- **Question:** Build a new board path or reuse existing RT2 board assets?
- **Auto-selected:** Reuse `Rt2DailyBoard` persistence and `KanbanBoard` visual/metadata patterns.
- **Reason:** The codebase already has both the daily-report persistence path and the desired 3-lane board UX; combining them is the smallest safe scope.

### Persistence feedback

- **Question:** Should lane movement wait for server response, or update immediately?
- **Auto-selected:** Optimistic immediate feedback with Korean save/pending/error state and rollback/clear failure handling.
- **Reason:** BOARD-02 requires immediate feedback, but persisted truth must remain authoritative.

## Scope Guardrails

- Phase 50 owns quick edit, filters, sort, and search.
- Phase 51 owns One-Liner to board capture and draft review.
- Phase 52 owns supporting Jarvis/wiki/graph/economy evidence panels and broader identity regression gates.

## Codebase Evidence

- `ui/src/components/Rt2DailyBoard.tsx` has daily board rendering and save wiring but old lane names.
- `server/src/services/rt2-daily-report.ts` derives deliverable, price, quality, OKR context, and wiki materialization.
- `ui/src/components/KanbanBoard.tsx` has the 3-lane Korean board and compact metadata pattern.
- `ui/src/App.tsx` still defaults company root to `one-liner`, which Phase 49 must change.

## Deferred Ideas

None added beyond the roadmap's Phase 50-52 scope split.
