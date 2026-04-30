# Phase 54: Persistent Capture Draft Revision - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 54-Persistent Capture Draft Revision
**Areas discussed:** Draft record ownership, Revision data shape, Review state semantics, Promotion behavior, Board review UX, API contract, Verification
**Mode:** auto

---

## Draft Record Ownership

| Option | Description | Selected |
|--------|-------------|----------|
| Keep `rt2_capture_drafts` as parent lifecycle owner and add revision records | Reuses current queue/source/promotion flow while adding durable edit history | ✓ |
| Create a separate draft subsystem | More isolation but duplicates existing capture queue, source evidence, and promotion contracts | |
| Store edits only in `auditTrail` JSON | Minimal schema change but weak queryability and harder detail UI/history tests | |

**Auto choice:** Keep `rt2_capture_drafts` as parent lifecycle owner and add revision records.
**Notes:** This follows Phase 51's decision to avoid a second capture subsystem.

---

## Revision Data Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Append-only `rt2_capture_draft_revisions` table with latest snapshot projection | Strong audit trail, easy detail/history route, preserves original input | ✓ |
| Overwrite `parsedDraft` and append audit text | Simple but risks losing edited-field semantics and diff/history quality | |
| Use generic document revisions | Existing concept exists, but capture draft evidence/status needs are domain-specific | |

**Auto choice:** Append-only revision table with latest snapshot projection.
**Notes:** `parsedDraft` may remain denormalized latest list snapshot, but revision rows must be the audit source.

---

## Review State Semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Add explicit review states for revised, hold, rejected, and revision requested | Matches DRAFT-04 and keeps inbox/lane behavior auditable | ✓ |
| Reuse only current failed/duplicate/promoted states | Too coarse for hold/request-revision and board consistency | |
| Encode review decisions only as failure codes | Loses distinction between operator workflow and source/parse failure | |

**Auto choice:** Add explicit review states and guarded transitions.
**Notes:** Duplicate and permission-blocked states remain conservative until explicitly resolved.

---

## Promotion Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Promote from latest persisted revision snapshot | Operator edits survive approval and promoted task/todo/deliverable evidence links to revision | ✓ |
| Continue reparsing original raw text during promotion | Current behavior, but violates DRAFT-02 because edits are ignored | |
| Let UI pass all revised values only at promote time | Works for one session but fails reopen/audit requirements | |

**Auto choice:** Promote from latest persisted revision snapshot.
**Notes:** This is the most important implementation correction for Phase 54.

---

## Board Review UX

| Option | Description | Selected |
|--------|-------------|----------|
| Compact reopen/edit/history drawer or inline expansion in daily board capture inbox | Keeps daily board as primary operations surface and supports reopen/edit/history | ✓ |
| New full-page draft manager | More room, but splits operators away from the daily work board | |
| Keep one-click approve/reject only | Too shallow for persistent revision workflow | |

**Auto choice:** Compact board-local reopen/edit/history UI.
**Notes:** UI copy must be Korean-first and avoid raw JSON/history dumps.

---

## API Contract

| Option | Description | Selected |
|--------|-------------|----------|
| Add narrow detail, revision, and transition validators/routes | Clear contracts without overloading promote/fail | ✓ |
| Overload promote/fail payloads | Fewer endpoints but conflates edit/state/approval semantics | |
| UI-only local state until promotion | Fails reopen and audit requirements | |

**Auto choice:** Add narrow shared validators and routes for revision/detail/state transitions.
**Notes:** Existing list/promote/fail paths should remain backward compatible.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Focused DB/shared/server/UI lifecycle tests plus typecheck | Best coverage for this phase's risk with known Windows broad-suite debt | ✓ |
| Only UI tests | Misses promotion/latest-revision and audit invariants | |
| Only route tests | Misses board reopen/edit Korean UX requirements | |

**Auto choice:** Focused lifecycle coverage and `pnpm typecheck`.
**Notes:** Broad `pnpm test` is optional if host time permits.

---

## the agent's Discretion

- Exact DB/table/column naming.
- Exact board drawer versus inline expansion layout.
- Whether `parsedDraft` is maintained as latest denormalized snapshot.

## Deferred Ideas

- Native/mobile entry and offline queue are Phase 55.
- Slack/Teams/webhook installation is Phase 56.
- Review filters/reliability reporting are Phase 57.
- App-store distribution, federation full apply, and autonomous Jarvis apply remain future scope.
