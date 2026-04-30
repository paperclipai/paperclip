# Phase 50: Work Card Editing and Board Controls - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 50-work-card-editing-and-board-controls
**Areas discussed:** Quick edit surface, Editable field ownership, Filter/search controls, Sort and lane order, Data contract shape, Verification
**Mode:** auto

---

## Quick Edit Surface

| Option | Description | Selected |
|--------|-------------|----------|
| Board-context quick edit | Inline controls, compact popover, or expanded card edit area on the daily board | ✓ |
| Deep issue detail edit | Navigate away to a dedicated detail page for edits | |
| Always-expanded form cards | Render every card as a full form by default | |

**User's choice:** Auto-selected recommended default: board-context quick edit.
**Notes:** Phase 50 goal says quick edits should not require deep screen movement. Phase 49 already made the board the primary daily surface.

---

## Editable Field Ownership

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse existing issue, deliverable, work-board, and daily-report ownership | Update each field through the existing owner path and keep daily board materialization intact | ✓ |
| Daily-board-only overrides | Store title/deliverable/price/quality/OKR edits as board-local overrides | |
| New parallel board backend | Create a separate model for all editable card fields | |

**User's choice:** Auto-selected recommended default: reuse existing ownership.
**Notes:** Existing services already compute card metadata from issues, work products, task profiles, and board metadata. Parallel state would make badges, wiki, economy, and filters drift.

---

## Filter And Search Controls

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit composable chips plus search input | Korean chips for today/mine/missing deliverable/approval waiting/quality issue, with visible search | ✓ |
| Single dropdown filter | One menu containing every filter state | |
| Server-only query page | Replace current board payload with paged search results | |

**User's choice:** Auto-selected recommended default: explicit composable chips plus search input.
**Notes:** Operators need repeated fast narrowing on a dense board. Lane grouping should remain visible under filters.

---

## Sort And Lane Order

| Option | Description | Selected |
|--------|-------------|----------|
| View-only sort modes | Sort cards inside lanes without mutating lane/status or persisted order | ✓ |
| Persist sort as board order | Treat sort interactions as saved ordering changes | |
| No sort modes | Ship filters/search only | |

**User's choice:** Auto-selected recommended default: view-only sort modes.
**Notes:** Roadmap success criteria says sort/search controls must not break lane state or persisted board order.

---

## Data Contract Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Extend daily board response minimally | Keep daily board primary and add missing edit/filter metadata where needed | ✓ |
| Client-side stitch from several APIs | Fetch daily board, task board overview, task detail, and deliverables separately in the component | |
| Replace with legacy work board | Move Phase 50 back to the older issue-board surface | |

**User's choice:** Auto-selected recommended default: extend daily board response minimally.
**Notes:** The daily board is the Phase 49 primary surface. Some metadata can reuse `rt2WorkBoardService`, but the UI should receive a coherent card model.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Focused UI/shared/server tests plus typecheck | Cover quick edits, filters/search/sort, route contracts, and daily materialization | ✓ |
| UI-only test coverage | Verify visible controls without server contract tests | |
| Full suite only | Rely on broad `pnpm test` without focused evidence | |

**User's choice:** Auto-selected recommended default: focused UI/shared/server tests plus typecheck.
**Notes:** Host constraints have repeatedly made full suite execution unreliable, so focused evidence must be explicit even when full tests are attempted.

## the agent's Discretion

- Exact edit affordance, as long as quick edit remains board-context and scan-first.
- Exact visual style for chips/search/sort, as long as controls are Korean-first, compact, stable, and composable.
- Whether filter/search/sort run client-side or with small server support, based on available daily board fields.

## Deferred Ideas

- One-Liner board inbox/promotion flow remains Phase 51.
- Mobile/native/inbound duplicate warning and source evidence remains Phase 51.
- Jarvis/wiki/graph/economy evidence panels and identity regression gate remain Phase 52.
- Persisted per-user board-control preferences are future scope unless already trivial.
