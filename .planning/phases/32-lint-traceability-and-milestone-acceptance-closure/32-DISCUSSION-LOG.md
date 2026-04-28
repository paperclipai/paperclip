# Phase 32: Lint Traceability and Milestone Acceptance Closure - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-04-28
**Phase:** 32-lint-traceability-and-milestone-acceptance-closure
**Areas discussed:** Closure artifact scope, evidence standard, Phase 29 lint closure, cross-phase integration closure, verification run handling

---

`[--auto] Selected all gray areas: Closure artifact scope, evidence standard, Phase 29 lint closure, cross-phase integration closure, verification run handling.`

## Closure Artifact Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Repair Phase 29 traceability only | Update summary frontmatter and add missing VALIDATION.md, without changing source unless evidence fails. | yes |
| Re-implement lint behavior | Treat Phase 32 as another lint feature phase. | |
| Skip Phase 29 and only rerun audit | Risks preserving the frontmatter and validation blockers from the v2.4 audit. | |

**User's choice:** Auto-selected recommended default.
**Notes:** The v2.4 audit says Phase 29 verification passed but summary frontmatter and VALIDATION.md were missing.

---

## Evidence Standard

| Option | Description | Selected |
|--------|-------------|----------|
| Require code, tests, verification, summary frontmatter, and validation evidence | Matches the 3-source audit gate plus Nyquist closure. | yes |
| Accept existing verification alone | Leaves the known audit blocker unresolved. | |
| Accept planning docs alone | Inflates completion without repository evidence. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Phase 32 should not mark LINT requirements accepted from roadmap/context/plan text alone.

---

## Phase 29 Lint Closure

| Option | Description | Selected |
|--------|-------------|----------|
| Map LINT-01..LINT-04 directly to existing service, scheduler, and tests | Uses `rt2WikiLintService`, `embedding_consistency`, scheduler wiring, and focused tests. | yes |
| Broaden lint scope to new wiki sources | New capability; outside closure scope. | |
| Require live LLM provider wiring | Future hardening; Phase 29 accepted deterministic injectable analyzer for stable tests. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Existing code and `29-VERIFICATION.md` provide the primary anchors.

---

## Cross-Phase Integration Closure

| Option | Description | Selected |
|--------|-------------|----------|
| Prove board/domain events -> daily wiki -> graph -> scheduled lint from existing closure artifacts | Directly addresses the remaining integration/flow audit gates. | yes |
| Re-audit only Phase 29 in isolation | Leaves graph/wiki upstream acceptance disconnected from lint acceptance. | |
| Rework Phase 30 and Phase 31 artifacts inside Phase 32 | Risks duplicating completed closure work. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Phase 30 and Phase 31 are prerequisites for final milestone acceptance; Phase 32 owns the final bridge and audit result.

---

## Verification Run Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Run focused lint tests first, then typecheck, then full unit tests if practical | Matches AGENTS.md and prior closure artifact patterns. | yes |
| Run Playwright E2E by default | Explicitly disallowed as default by AGENTS.md. | |
| Skip command evidence | Leaves acceptance weaker than the original audit standard. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Full-suite unrelated failures or embedded Postgres skips should be recorded separately from LINT acceptance.

---

## the agent's Discretion

- Exact table structure and section names for `29-VALIDATION.md`.
- Whether final acceptance is written as a new artifact or a carefully updated `.planning/v2.4-MILESTONE-AUDIT.md`.
- Whether to run full `pnpm test` after focused lint tests and typecheck based on current worktree risk and time.

## Deferred Ideas

- Live LLM/provider-backed contradiction analysis.
- Auto-fix/remediation for wiki contradictions.
- Vector search, pgvector retrieval, and cross-company knowledge federation.
- Browser E2E coverage for lint UI unless a concrete acceptance gap is found.
