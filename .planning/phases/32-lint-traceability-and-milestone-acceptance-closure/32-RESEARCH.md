# Phase 32: Lint Traceability and Milestone Acceptance Closure - Research

**Researched:** 2026-04-28  
**Domain:** GSD milestone closure, lint traceability, Nyquist validation, TypeScript/Vitest server evidence  
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

## Implementation Decisions

### Closure Artifact Scope
- **D-01:** Update `.planning/phases/29-consistency-linting-batch/29-01-SUMMARY.md` frontmatter with `requirements-completed` for LINT-01, LINT-02, LINT-03, and LINT-04 only if the existing verification and focused tests still support acceptance.
- **D-02:** Create `.planning/phases/29-consistency-linting-batch/29-VALIDATION.md` with Nyquist-style validation scenarios for scheduled execution, evidence-only findings, `embedding_consistency`, read-only behavior, and no on-write lint trigger.
- **D-03:** Keep Phase 32 as audit closure first. Source changes are allowed only when traceability or validation reveals a concrete lint implementation gap.

### Evidence Standard
- **D-04:** Every accepted LINT requirement must cite exact code and test evidence. Minimum evidence: implementing service file, startup/scheduler wiring, route/API surface where relevant, focused test coverage, Phase 29 verification, and command results.
- **D-05:** Do not mark LINT requirements accepted from roadmap, context, or plan text alone. The acceptance matrix must line up across `REQUIREMENTS.md`, `29-VERIFICATION.md`, `29-01-SUMMARY.md` frontmatter, and `29-VALIDATION.md`.
- **D-06:** If a lint requirement is partial, record an explicit gap and avoid inflating milestone completion.

### Phase 29 Lint Closure
- **D-07:** LINT-01 should be verified against `rt2WikiLintService.lintWikiPages()` comparing scoped daily wiki pages and the scheduled runner invoking lint by company/project scope.
- **D-08:** LINT-02 should be verified against evidence-rich issue fields and tests that assert wiki rows are unchanged before and after linting.
- **D-09:** LINT-03 should be verified against `embedding_consistency` as a first-class issue type, summary count, semantic comparison count, and contradiction evidence.
- **D-10:** LINT-04 should be verified against `createRt2WikiLintScheduler()`, server startup wiring, nightly window gating, overlap prevention, and no coupling to daily wiki write/materialization paths.

### Cross-Phase Integration Closure
- **D-11:** Phase 32 must explicitly connect Phase 30's accepted WIKI and GRAPH closure artifacts to Phase 29 lint acceptance: board/domain events produce stable daily wiki pages, graph projection depends on those pages, and scheduled lint reads the stabilized wiki corpus.
- **D-12:** Phase 31 economy closure should be treated as a prerequisite for final milestone acceptance, but Phase 32 should not rework economy artifacts unless the final audit still finds a traceability blocker there.
- **D-13:** The final acceptance artifact should identify whether v2.4 now passes requirements, phase artifacts, integration, and flow gates. Any residual issue must be labeled as explicit deferred tech debt with evidence.

### Verification Run Handling
- **D-14:** Prefer focused lint verification first: `pnpm --filter @paperclipai/server test -- rt2-wiki-lint`, then `pnpm typecheck`, then `pnpm test` if practical.
- **D-15:** Record exact command outcomes in artifacts. If full `pnpm test` still fails in unrelated `worktree.test.ts` timeout or host-specific embedded Postgres skips, document that separately from LINT acceptance.
- **D-16:** Do not require `pnpm test:e2e`; AGENTS.md makes it a separate browser suite and it is not the default verification gate for this closure.

### the agent's Discretion
- Exact table shape and heading names can mirror Phase 30 and Phase 31 closure artifacts.
- The final milestone audit can be a new audit artifact or an update to `.planning/v2.4-MILESTONE-AUDIT.md`, as long as it preserves the original gap context and clearly records the post-closure result.
- If Phase 31 has not fully landed by the time Phase 32 executes, the planner may gate final milestone acceptance on the existing Phase 31 artifacts rather than duplicating their work.

### Deferred Ideas (OUT OF SCOPE)
- Live LLM or embedding-provider integration for production-grade contradiction detection remains future hardening.
- Auto-fix or remediation workflow for lint findings remains out of scope.
- Vector semantic search, pgvector-backed retrieval, and cross-company knowledge federation remain v2+ deferred items.
- Additional browser E2E coverage for lint inspection UI is outside this closure unless a concrete route/UI acceptance gap is found.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LINT-01 | Nightly batch LLM scan compares wiki pages for contradictions and inconsistencies. [VERIFIED: .planning/REQUIREMENTS.md:43] | `lintWikiPages()` scopes daily wiki pages by company/project/date and performs pairwise semantic comparisons; scheduler enumerates project scopes and invokes the service. [VERIFIED: server/src/services/rt2-wiki-lint.ts:254] [VERIFIED: server/src/services/rt2-wiki-lint.ts:284] [VERIFIED: server/src/services/rt2-wiki-lint.ts:400] |
| LINT-02 | Lint issues flagged with evidence, not auto-fixed. [VERIFIED: .planning/REQUIREMENTS.md:44] | Issue type includes evidence and related page metadata; focused embedded test snapshots rows before/after lint and asserts unchanged rows. [VERIFIED: server/src/services/rt2-wiki-lint.ts:12] [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:156] |
| LINT-03 | `rt2WikiLintService` extended with `embedding_consistency` check. [VERIFIED: .planning/REQUIREMENTS.md:45] | `embedding_consistency` is in the issue union, produced by `analyzeWikiPageConsistency()`, counted in summaries, and asserted by tests. [VERIFIED: server/src/services/rt2-wiki-lint.ts:18] [VERIFIED: server/src/services/rt2-wiki-lint.ts:220] [VERIFIED: server/src/services/rt2-wiki-lint.ts:303] [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:63] |
| LINT-04 | Lint runner executes on schedule, not on every wiki write. [VERIFIED: .planning/REQUIREMENTS.md:46] | Scheduler gates by nightly hour and one run per date; server startup starts the scheduler; daily report write/materialization routes emit live events but do not invoke scheduled lint. [VERIFIED: server/src/services/rt2-wiki-lint.ts:395] [VERIFIED: server/src/app.ts:436] [VERIFIED: server/src/routes/rt2-daily-report.ts:64] [VERIFIED: server/src/routes/rt2-daily-report.ts:124] |
</phase_requirements>

## Summary

Phase 32 should be planned as an audit/artifact closure phase, not as a lint feature build. The original v2.4 audit classified LINT-01 through LINT-04 as partial because `29-VERIFICATION.md` passed but `29-01-SUMMARY.md` lacked `requirements-completed` frontmatter and Phase 29 had no `29-VALIDATION.md`. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:46] [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:52] [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:125]

Current code and tests support accepting LINT-01 through LINT-04 if focused verification remains green. `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` exited 0 during this research session, and `pnpm --filter @paperclipai/server typecheck` exited 0. [VERIFIED: command 2026-04-28] Full `pnpm typecheck` timed out after about 124 seconds in this session, so the planner should record that exact result if it recurs and should use the narrower server typecheck as the practical Phase 32 fallback evidence. [VERIFIED: command 2026-04-28]

Phase 30 and Phase 31 are now closed with verification artifacts, so the prior upstream audit blockers for WIKI/GRAPH and LEDGER/SETTLE should be treated as satisfied unless a fresh re-audit contradicts them. [VERIFIED: .planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md:24] [VERIFIED: .planning/phases/31-economy-artifact-and-verification-closure/31-VERIFICATION.md:22]

**Primary recommendation:** Plan one closure plan that repairs Phase 29 frontmatter, creates `29-VALIDATION.md`, reruns focused lint/server checks, then writes a Phase 32 verification and v2.4 re-audit result artifact. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

## Project Constraints (from AGENTS.md)

- Use `pnpm` workspace commands; default verification is `pnpm typecheck && pnpm test`. [VERIFIED: AGENTS.md]
- Do not run `pnpm test:e2e` as the default closure gate. [VERIFIED: AGENTS.md]
- Do not commit `pnpm-lock.yaml` changes in PRs. [VERIFIED: AGENTS.md]
- Leave `DATABASE_URL` unset for dev because embedded PGlite is the default. [VERIFIED: AGENTS.md]
- Prefer minimal scope and do not run unrelated rewrites. [VERIFIED: AGENTS.md]
- RealTycoon2 terminology should be preferred for product-facing RT2 work. [VERIFIED: AGENTS.md]
- Source-of-truth order is user instruction, AGENTS.md, developer docs, product/spec docs, database docs, existing behavior, then reference docs. [VERIFIED: AGENTS.md]
- Do not invoke broad ceremonies for mechanical cleanup unless explicitly requested. [VERIFIED: AGENTS.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Lint issue detection | API / Backend | Database / Storage | `rt2WikiLintService()` reads daily wiki rows and returns lint results without mutating pages. [VERIFIED: server/src/services/rt2-wiki-lint.ts:254] [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:156] |
| Scheduled lint execution | API / Backend | Database / Storage | `createRt2WikiLintScheduler()` enumerates company/project scopes from daily wiki rows and invokes lint on a timer. [VERIFIED: server/src/services/rt2-wiki-lint.ts:357] [VERIFIED: server/src/services/rt2-wiki-lint.ts:400] |
| Manual lint inspection route | API / Backend | Browser / Client | `GET /companies/:companyId/rt2/wiki-lint` exposes computed results for project/date scope. [VERIFIED: server/src/routes/rt2-daily-report.ts:124] |
| Daily wiki write path separation | API / Backend | Browser / Client | Daily report save and daily wiki materialization emit live events and return wiki pages; scheduled lint is wired in app startup rather than these write handlers. [VERIFIED: server/src/routes/rt2-daily-report.ts:64] [VERIFIED: server/src/app.ts:436] |
| Milestone acceptance traceability | Planning Artifacts | Test Runner | Acceptance depends on `REQUIREMENTS.md`, `29-VERIFICATION.md`, `29-01-SUMMARY.md` frontmatter, `29-VALIDATION.md`, and final audit artifact alignment. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md] |

## Standard Stack

### Core

| Library / Tool | Current Project Version | Registry Current | Purpose | Why Standard |
|----------------|-------------------------|------------------|---------|--------------|
| TypeScript | `^5.7.3` [VERIFIED: package.json] | `6.0.3`, modified 2026-04-16 [VERIFIED: npm registry] | Static type checking for server/shared workspace code. [VERIFIED: package.json] | Already used by server and workspace scripts; Phase 32 should not introduce a new language/toolchain. [VERIFIED: package.json] |
| Vitest | `^3.0.5` [VERIFIED: package.json] | `4.1.5`, modified 2026-04-23 [VERIFIED: npm registry] | Focused unit/integration test runner. [VERIFIED: package.json] | Existing lint tests are Vitest tests and focused command exits 0. [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts] [VERIFIED: command 2026-04-28] |
| Express | `^5.1.0` [VERIFIED: server/package.json] | `5.2.1`, modified 2026-04-16 [VERIFIED: npm registry] | API route layer for lint inspection and daily report write routes. [VERIFIED: server/src/routes/rt2-daily-report.ts:1] | Existing app and route mounting use Express; no routing replacement belongs in this phase. [VERIFIED: server/src/app.ts:1] |
| Drizzle ORM | `^0.38.4` [VERIFIED: server/package.json] | `0.45.2`, modified 2026-04-27 [VERIFIED: npm registry] | Typed database query layer for daily wiki rows. [VERIFIED: server/src/services/rt2-wiki-lint.ts:1] | Existing lint service uses Drizzle query helpers and RT2 daily wiki schema. [VERIFIED: server/src/services/rt2-wiki-lint.ts:254] |
| Zod | `^3.24.2` [VERIFIED: server/package.json] | `4.3.6`, modified 2026-01-25 [VERIFIED: npm registry] | Request validation for existing RT2 daily wiki query route. [VERIFIED: server/src/routes/rt2-daily-report.ts:2] | Already used in route validation; Phase 32 does not need new validation libraries. [VERIFIED: server/src/routes/rt2-daily-report.ts:18] |

### Supporting

| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| Node.js | `v22.17.0` [VERIFIED: command 2026-04-28] | Runtime for pnpm scripts and Vitest. [VERIFIED: package.json] | Use for all workspace commands. [VERIFIED: AGENTS.md] |
| pnpm | `9.15.4` [VERIFIED: command 2026-04-28] | Workspace package manager. [VERIFIED: package.json] | Use `pnpm --filter @paperclipai/server ...` for focused closure verification. [VERIFIED: package.json] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Existing Vitest tests | Playwright E2E | Do not use as default; AGENTS.md explicitly makes Playwright E2E separate from default verification. [VERIFIED: AGENTS.md] |
| Existing scheduler/service | New job framework or cron dependency | Out of scope because the existing scheduler is implemented and tested; a new framework would be a broad rewrite. [VERIFIED: server/src/services/rt2-wiki-lint.ts:357] [VERIFIED: AGENTS.md] |
| Planning artifact repair | Source rewrite | Source edits are allowed only if validation reveals a concrete implementation gap. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md] |

**Installation:** No new packages should be installed for Phase 32. [VERIFIED: AGENTS.md] [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

## Architecture Patterns

### System Architecture Diagram

```text
Board/domain events
  -> daily wiki materialization / knowledge projector
  -> rt2_v33_daily_wiki_pages corpus
  -> graph projection and graph cache closure evidence
  -> scheduled wiki lint runner
      -> list project scopes
      -> rt2WikiLintService.lintWikiPages(companyId, projectId)
      -> structural lint checks
      -> pairwise embedding_consistency analysis
      -> evidence-only issue result
  -> Phase 29 validation + verification artifacts
  -> Phase 32 final v2.4 re-audit artifact
```

This flow is the acceptance chain the planner must preserve: Phase 30 verifies daily wiki and graph closure, Phase 29 verifies scheduled lint over the daily wiki corpus, and Phase 32 should connect them explicitly in final acceptance. [VERIFIED: .planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md:24] [VERIFIED: .planning/phases/29-consistency-linting-batch/29-VERIFICATION.md:19]

### Recommended Project Structure

```text
.planning/phases/29-consistency-linting-batch/
├── 29-01-SUMMARY.md      # add requirements-completed frontmatter for LINT-01..LINT-04
├── 29-VERIFICATION.md    # existing passed evidence, update only if new command evidence changes status
└── 29-VALIDATION.md      # new Nyquist scenarios for lint closure

.planning/phases/32-lint-traceability-and-milestone-acceptance-closure/
├── 32-01-PLAN.md         # executable closure plan
├── 32-01-SUMMARY.md      # closure summary after execution
├── 32-VERIFICATION.md    # final Phase 32 verification
└── 32-RESEARCH.md        # this research

.planning/
└── v2.4-MILESTONE-AUDIT.md or a new re-audit artifact
```

The target Phase 29 directory currently lacks `29-VALIDATION.md`. [VERIFIED: rg --files .planning/phases/29-consistency-linting-batch]

### Pattern 1: Evidence-Backed Requirement Matrix

**What:** For each LINT requirement, record status, exact code evidence, test evidence, command evidence, and residual risk. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

**When to use:** Use in `29-VALIDATION.md`, `32-VERIFICATION.md`, and the final re-audit artifact. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

**Example:**

```markdown
| Requirement | Status | Code Evidence | Test Evidence | Command Evidence | Residual Risk |
|-------------|--------|---------------|---------------|------------------|---------------|
| LINT-03 | Passed | `rt2WikiLintService` issue type and summary count include `embedding_consistency`. | `rt2-wiki-lint.test.ts` asserts contradiction evidence and summary count. | `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` exit 0. | Live LLM/provider hardening deferred. |
```

Source: Phase 32 context and current lint code/test evidence. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md] [VERIFIED: server/src/services/rt2-wiki-lint.ts:18] [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:63]

### Pattern 2: Nyquist Validation Scenario Table

**What:** `29-VALIDATION.md` should encode what could break, how it is checked, expected result, evidence source, and command. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

**When to use:** Use for scheduled execution, evidence-only findings, `embedding_consistency`, read-only behavior, and no on-write trigger. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

**Example:**

```markdown
| Scenario | Requirement | Failure Mode | Evidence | Expected Outcome |
|----------|-------------|--------------|----------|------------------|
| No on-write lint trigger | LINT-04 | Daily wiki materialization invokes lint per write. | `rt2-daily-report.ts` write path calls `materializeDailyWikiPage()` and emits live events; lint route is read-only and scheduler starts in `app.ts`. | Accepted if write path has no scheduler/service lint invocation. |
```

Source: Current route and app wiring. [VERIFIED: server/src/routes/rt2-daily-report.ts:64] [VERIFIED: server/src/routes/rt2-daily-report.ts:124] [VERIFIED: server/src/app.ts:436]

### Anti-Patterns to Avoid

- **Accepting from roadmap text alone:** The audit requires cross-reference through requirements, summary frontmatter, verification, and validation. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:115]
- **Adding live LLM/provider work during closure:** The context defers production-grade provider integration; current deterministic analyzer plus injectable test path is acceptable evidence. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md] [VERIFIED: .planning/phases/29-consistency-linting-batch/29-VERIFICATION.md:40]
- **Running Playwright E2E as the default gate:** AGENTS.md explicitly excludes `pnpm test:e2e` from default verification. [VERIFIED: AGENTS.md]
- **Reworking economy closure in Phase 32:** Phase 31 is verified as passed; only revisit economy if the final audit finds a blocker. [VERIFIED: .planning/phases/31-economy-artifact-and-verification-closure/31-VERIFICATION.md:22] [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Test runner | New test harness or shell-only assertions | Existing Vitest tests and `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` | Focused suite exists and exits 0. [VERIFIED: command 2026-04-28] |
| Scheduler framework | New cron dependency | Existing `createRt2WikiLintScheduler()` | Current scheduler has nightly gating, overlap guard, start/stop, and test hooks. [VERIFIED: server/src/services/rt2-wiki-lint.ts:357] |
| Lint service | Parallel lint service | Existing `rt2WikiLintService()` | Phase 29 locked extension of the existing service, and the current route uses it. [VERIFIED: .planning/phases/29-consistency-linting-batch/29-CONTEXT.md] [VERIFIED: server/src/routes/rt2-daily-report.ts:136] |
| Audit traceability | Ad hoc acceptance prose | Requirement/evidence matrices | Original audit failed due to missing traceability artifacts, not missing prose. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:115] |

**Key insight:** The highest-risk mistake is inflating acceptance without artifact alignment; the code gap appears smaller than the traceability gap. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:52] [VERIFIED: .planning/phases/29-consistency-linting-batch/29-VERIFICATION.md:19]

## Common Pitfalls

### Pitfall 1: Treating Old Audit Gaps as Current Without Rechecking Phase 30/31
**What goes wrong:** The planner repeats obsolete blockers for Phase 25/26 or Phase 27/28. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md]  
**Why it happens:** `STATE.md` is stale relative to the newer closure artifacts and still says Phase 31 is next. [VERIFIED: .planning/STATE.md]  
**How to avoid:** Read `30-VERIFICATION.md` and `31-VERIFICATION.md` before writing final acceptance. [VERIFIED: .planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md] [VERIFIED: .planning/phases/31-economy-artifact-and-verification-closure/31-VERIFICATION.md]  
**Warning signs:** Final audit still says WIKI/GRAPH or LEDGER/SETTLE are orphaned despite closure artifacts existing. [VERIFIED: .planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md:26] [VERIFIED: .planning/phases/31-economy-artifact-and-verification-closure/31-VERIFICATION.md:24]

### Pitfall 2: Marking LINT Accepted Without `29-VALIDATION.md`
**What goes wrong:** LINT remains partial under Nyquist/artifact gates. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:169]  
**Why it happens:** `29-VERIFICATION.md` exists, but validation does not. [VERIFIED: rg --files .planning/phases/29-consistency-linting-batch]  
**How to avoid:** Plan a specific task to create `29-VALIDATION.md` before final re-audit. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]  
**Warning signs:** Acceptance matrix has requirements and verification but no Nyquist scenarios. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:169]

### Pitfall 3: Confusing Route-Triggered Manual Lint With Scheduled Batch Lint
**What goes wrong:** LINT-04 evidence becomes ambiguous. [VERIFIED: .planning/phases/29-consistency-linting-batch/29-CONTEXT.md]  
**Why it happens:** The daily report route exposes `GET /wiki-lint`, while app startup separately starts the scheduler. [VERIFIED: server/src/routes/rt2-daily-report.ts:124] [VERIFIED: server/src/app.ts:436]  
**How to avoid:** Validation should show daily wiki writes do not call lint and scheduler startup does. [VERIFIED: server/src/routes/rt2-daily-report.ts:64] [VERIFIED: server/src/app.ts:436]  
**Warning signs:** Plan says "lint runs from daily report save" or adds an on-write trigger. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

### Pitfall 4: Treating Full Workspace Timeout as LINT Failure
**What goes wrong:** A host or workspace timeout blocks LINT acceptance despite focused lint evidence passing. [VERIFIED: command 2026-04-28]  
**Why it happens:** Prior Phase 29 full-suite verification had an unrelated `worktree.test.ts` timeout, and this research saw full `pnpm typecheck` timeout after about 124 seconds. [VERIFIED: .planning/phases/29-consistency-linting-batch/29-VERIFICATION.md:36] [VERIFIED: command 2026-04-28]  
**How to avoid:** Record focused lint test and server typecheck as Phase-specific gates, then separately record full workspace command status if it times out. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]  
**Warning signs:** The final artifact collapses unrelated timeout debt into LINT requirement status. [VERIFIED: .planning/phases/29-consistency-linting-batch/29-VERIFICATION.md:42]

## Code Examples

### Focused Lint Verification Command

```bash
pnpm --filter @paperclipai/server test -- rt2-wiki-lint
```

This exited 0 during research. [VERIFIED: command 2026-04-28]

### Practical Server Typecheck Command

```bash
pnpm --filter @paperclipai/server typecheck
```

This exited 0 during research after building `@paperclipai/plugin-sdk` and `@paperclipai/shared`. [VERIFIED: command 2026-04-28]

### Phase 29 Summary Frontmatter Shape

```yaml
---
phase: 29
phase_name: Consistency Linting (Batch)
plan: 1
status: implemented
completed: "2026-04-28"
requirements-completed:
  - LINT-01
  - LINT-02
  - LINT-03
  - LINT-04
---
```

This shape follows the Phase 25/26/31 repaired summary pattern. [VERIFIED: .planning/phases/25-daily-wiki-projector/25-SUMMARY.md] [VERIFIED: .planning/phases/26-graphify-projector/26-SUMMARY.md] [VERIFIED: .planning/phases/31-economy-artifact-and-verification-closure/31-01-SUMMARY.md]

### Validation Scenario Rows to Include

```markdown
| Scenario | Requirements | Evidence | Result |
|----------|--------------|----------|--------|
| Scoped pairwise wiki comparison | LINT-01 | `lintWikiPages()` filters by company/project/date and increments `semanticComparisons`. | accepted if focused lint test passes |
| Evidence-only findings | LINT-02 | `evidence`, `relatedPageId`, `relatedPageKey`, and before/after row equality test. | accepted if rows remain unchanged |
| `embedding_consistency` issue family | LINT-03 | issue union, analyzer output, summary count, tests. | accepted if contradiction evidence appears |
| Scheduled, not on-write | LINT-04 | scheduler startup in `app.ts`; daily report write path lacks lint call. | accepted if no on-write coupling exists |
```

Source: Current code/test evidence. [VERIFIED: server/src/services/rt2-wiki-lint.ts] [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts] [VERIFIED: server/src/app.ts] [VERIFIED: server/src/routes/rt2-daily-report.ts]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| v2.4 audit accepted 0/24 after strict artifact reset. | Phase 30 accepted WIKI/GRAPH, Phase 31 accepted LEDGER/SETTLE, Phase 32 should close LINT. | 2026-04-28 [VERIFIED: .planning/REQUIREMENTS.md] | Final re-audit should not repeat stale orphan findings for already closed groups. [VERIFIED: .planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md] [VERIFIED: .planning/phases/31-economy-artifact-and-verification-closure/31-VERIFICATION.md] |
| Phase 29 had verification but no summary frontmatter or validation. | Add `requirements-completed` and `29-VALIDATION.md` if focused evidence remains true. | Phase 32 [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md] | LINT moves from partial to accepted under the audit matrix. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:52] |
| Live LLM/provider contradiction detection. | Deterministic local contradiction heuristics with injectable analyzer. | Phase 29 [VERIFIED: .planning/phases/29-consistency-linting-batch/29-VERIFICATION.md:40] | Acceptable for closure; production provider hardening remains deferred. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md] |

**Deprecated/outdated:**
- The original `v2.4-MILESTONE-AUDIT.md` finding that Phase 26 is unverified is outdated after Phase 30 closure. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:59] [VERIFIED: .planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md:24]
- The original audit finding that Phase 27/28 verification artifacts are missing is outdated after Phase 31 closure. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md:38] [VERIFIED: .planning/phases/31-economy-artifact-and-verification-closure/31-VERIFICATION.md:24]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 32 will use a new `.planning/v2.4-MILESTONE-REAUDIT.md` artifact and preserve the original audit unchanged. [RESOLVED] | Summary / Architecture Patterns | Low; this follows CONTEXT discretion and keeps original gap evidence intact. |

## Open Questions (RESOLVED)

1. **RESOLVED: Final acceptance will preserve the original milestone audit and write a new re-audit artifact.**
   - What we know: Context permits either updating `.planning/v2.4-MILESTONE-AUDIT.md` or creating a new audit artifact, as long as original gap context is preserved. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]
   - Prior uncertainty: The repo had not established a single post-closure re-audit filename convention for v2.4. [VERIFIED: rg .planning]
   - Resolution: Use a new `.planning/v2.4-MILESTONE-REAUDIT.md` artifact and do not overwrite `.planning/v2.4-MILESTONE-AUDIT.md`. This preserves original gap evidence while giving Phase 32 a clear post-closure acceptance target. [RESOLVED: planner decision from CONTEXT discretion]

2. **RESOLVED: Retry full workspace checks if practical, but make focused lint and server checks the LINT acceptance gate.**
   - What we know: It timed out in this research session after about 124 seconds, while server typecheck passed. [VERIFIED: command 2026-04-28]
   - Prior uncertainty: Whether the timeout was transient or inherent to the current workspace state. [VERIFIED: command 2026-04-28]
   - Resolution: Execution must run `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` and `pnpm --filter @paperclipai/server typecheck` as the required Phase 32 LINT gates. It should retry `pnpm typecheck` and `pnpm test` if practical, record exact outcomes, and separate unrelated timeout or host-specific failures from LINT acceptance. [RESOLVED: D-14, D-15]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | pnpm scripts, Vitest | yes | `v22.17.0` [VERIFIED: command 2026-04-28] | none needed |
| pnpm | workspace commands | yes | `9.15.4` [VERIFIED: command 2026-04-28] | none needed |
| Vitest | focused lint tests | yes via workspace package | project `^3.0.5`; registry current `4.1.5` [VERIFIED: package.json] [VERIFIED: npm registry] | use existing workspace version |
| Embedded Postgres support | embedded integration portions of lint tests | conditional | host-gated by test support [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:18] | default suite skips unsupported host cases |

**Missing dependencies with no fallback:** None found for artifact closure. [VERIFIED: command 2026-04-28]

**Missing dependencies with fallback:** Embedded Postgres integration execution may be skipped on unsupported hosts; default test file contains skip handling. [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:18]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest, project `^3.0.5` [VERIFIED: package.json] |
| Config file | `vitest.config.ts`, Node environment, 60s test/hook timeout [VERIFIED: vitest.config.ts] |
| Quick run command | `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` [VERIFIED: command 2026-04-28] |
| Full suite command | `pnpm test` [VERIFIED: package.json] |
| Practical typecheck fallback | `pnpm --filter @paperclipai/server typecheck` [VERIFIED: command 2026-04-28] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| LINT-01 | Scoped daily wiki pages are compared pairwise for semantic contradictions. [VERIFIED: server/src/services/rt2-wiki-lint.ts:284] | unit/integration | `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` | yes, `server/src/__tests__/rt2-wiki-lint.test.ts` [VERIFIED: rg --files] |
| LINT-02 | Findings carry evidence and linting does not mutate wiki rows. [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:156] | integration | `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` | yes [VERIFIED: rg --files] |
| LINT-03 | `embedding_consistency` is produced and counted. [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:160] | unit/integration | `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` | yes [VERIFIED: rg --files] |
| LINT-04 | Scheduler respects nightly gating and one-run-per-day behavior. [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:220] | unit/integration | `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` | yes [VERIFIED: rg --files] |

### Sampling Rate

- **Per task commit:** `pnpm --filter @paperclipai/server test -- rt2-wiki-lint` [VERIFIED: command 2026-04-28]
- **Per wave merge:** `pnpm --filter @paperclipai/server typecheck`; retry `pnpm typecheck` if time allows. [VERIFIED: command 2026-04-28]
- **Phase gate:** Focused lint test green, server typecheck green, final artifact matrix aligned; full `pnpm test` or full `pnpm typecheck` recorded if practical. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

### Wave 0 Gaps

- [ ] `.planning/phases/29-consistency-linting-batch/29-VALIDATION.md` - required for Nyquist closure. [VERIFIED: rg --files .planning/phases/29-consistency-linting-batch]
- [ ] `.planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-VERIFICATION.md` - required to record Phase 32 closure result. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure directory listing]
- [ ] final v2.4 re-audit artifact or dated update to `.planning/v2.4-MILESTONE-AUDIT.md` - required for milestone acceptance closure. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no new auth | Keep existing `assertCompanyAccess` on lint route. [VERIFIED: server/src/routes/rt2-daily-report.ts:126] |
| V3 Session Management | no | Phase 32 does not alter sessions. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md] |
| V4 Access Control | yes | Preserve company-scoped route authorization and company/project scoped lint queries. [VERIFIED: server/src/routes/rt2-daily-report.ts:126] [VERIFIED: server/src/services/rt2-wiki-lint.ts:260] |
| V5 Input Validation | yes | Existing route requires `projectId`; date strings are optional query parameters. [VERIFIED: server/src/routes/rt2-daily-report.ts:128] |
| V6 Cryptography | no | No cryptographic behavior is touched by artifact closure. [VERIFIED: .planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md] |

### Known Threat Patterns for This Phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-company lint data exposure | Information Disclosure | Keep `assertCompanyAccess` and company/project filters. [VERIFIED: server/src/routes/rt2-daily-report.ts:126] [VERIFIED: server/src/services/rt2-wiki-lint.ts:260] |
| Accidental wiki mutation from lint closure | Tampering | Keep lint service read-only and validate before/after row equality. [VERIFIED: server/src/__tests__/rt2-wiki-lint.test.ts:156] |
| Scheduler overlap causing noisy duplicate evidence | Denial of Service | Preserve `runInProgress` overlap guard. [VERIFIED: server/src/services/rt2-wiki-lint.ts:372] [VERIFIED: server/src/services/rt2-wiki-lint.ts:401] |

## Sources

### Primary (HIGH confidence)

- `AGENTS.md` - repo commands, lockfile policy, default verification, scope constraints. [VERIFIED: AGENTS.md]
- `.planning/phases/32-lint-traceability-and-milestone-acceptance-closure/32-CONTEXT.md` - locked Phase 32 decisions and evidence standard. [VERIFIED: local file]
- `.planning/REQUIREMENTS.md` - LINT-01 through LINT-04 pending status and descriptions. [VERIFIED: local file]
- `.planning/v2.4-MILESTONE-AUDIT.md` - original audit blocker and closure path. [VERIFIED: local file]
- `.planning/phases/29-consistency-linting-batch/29-VERIFICATION.md` - existing LINT passed evidence. [VERIFIED: local file]
- `server/src/services/rt2-wiki-lint.ts` - lint service and scheduler implementation. [VERIFIED: local file]
- `server/src/__tests__/rt2-wiki-lint.test.ts` - focused lint tests. [VERIFIED: local file]
- `server/src/app.ts` and `server/src/routes/rt2-daily-report.ts` - scheduler startup and route/write separation. [VERIFIED: local files]
- `.planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md` and `.planning/phases/31-economy-artifact-and-verification-closure/31-VERIFICATION.md` - upstream closure status. [VERIFIED: local files]
- Commands run during research: focused lint test exit 0; server typecheck exit 0; full `pnpm typecheck` timeout. [VERIFIED: command 2026-04-28]

### Secondary (MEDIUM confidence)

- npm registry `npm view` for current package versions and modified timestamps for TypeScript, Vitest, Express, Drizzle ORM, and Zod. [VERIFIED: npm registry]

### Tertiary (LOW confidence)

- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - project package files and npm registry versions were checked. [VERIFIED: package.json] [VERIFIED: npm registry]
- Architecture: HIGH - based on local code paths and closure artifacts. [VERIFIED: server/src/services/rt2-wiki-lint.ts] [VERIFIED: .planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md]
- Pitfalls: HIGH - based on original audit findings, current Phase 30/31 closure artifacts, and current command outcomes. [VERIFIED: .planning/v2.4-MILESTONE-AUDIT.md] [VERIFIED: command 2026-04-28]

**Research date:** 2026-04-28  
**Valid until:** 2026-05-05, because this is an active milestone closure and artifact state can change quickly. [ASSUMED]
