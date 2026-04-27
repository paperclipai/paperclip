# Phase 29: Consistency Linting (Batch) - Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 29 delivers a scheduled wiki consistency lint runner. It compares stable daily/wiki content from Phase 25 and Phase 26 for contradictions and inconsistencies, stores lint issues with evidence snippets, extends `rt2WikiLintService` with an `embedding_consistency` check, and runs on a schedule. It must not mutate wiki content and must not run on every wiki write.

</domain>

<decisions>
## Implementation Decisions

### Batch Execution Model
- **D-01:** Run consistency linting as a scheduled batch job, not as part of daily wiki materialization, graph projection, or any write path.
- **D-02:** Prefer the existing scheduler/job patterns where practical: cron-like schedule, persisted run records, overlap prevention, and failure capture. If direct reuse of plugin job infrastructure is too coupled to plugin workers, implement the same shape in an RT2-specific runner.
- **D-03:** Default cadence is nightly. The exact cron expression and timezone handling are agent discretion, but planning must include a deterministic test path for manual invocation.

### Lint Service Scope
- **D-04:** Extend `rt2WikiLintService` rather than creating a parallel wiki lint service. Existing page-level checks remain valid and the new consistency pass is added as another check family.
- **D-05:** Add `embedding_consistency` as a first-class issue type/check result. It should compare semantic similarity across candidate wiki pages and flag likely contradictions or drift.
- **D-06:** Existing issue types (`empty`, `missing_summary`, `no_activity`, `stale`) stay cheap deterministic checks. LLM/embedding consistency should be separately identifiable so callers can distinguish expensive semantic findings from structural lint.

### Evidence-Only Findings
- **D-07:** Lint findings must include enough evidence for a human or later agent to inspect the problem: source page ids/keys, report dates, matched snippets, check type, severity, and a short reason.
- **D-08:** The system never auto-fixes, rewrites, deletes, or edits wiki pages in this phase. Any remediation flow is deferred.
- **D-09:** If the LLM/embedding provider is unavailable, the batch run should record/report failure or skip semantic checks without pretending the wiki is clean.

### Candidate Selection
- **D-10:** Compare scoped wiki pages by company/project, with date-range support reused from the existing lint API where useful.
- **D-11:** Start with daily wiki pages (`rt2_v33_daily_wiki_pages`) because Phase 25/26 established them as the stable source for project knowledge. Broader cumulative/wiki page comparisons can be added only if already exposed by existing knowledge code without scope expansion.
- **D-12:** Use graph/projector context as a narrowing aid where available, but do not make graph community detection a hard dependency for the first implementation unless existing Phase 26 code makes it trivial.

### API and Observability
- **D-13:** Existing read endpoint shape can remain the primary inspection path (`GET /companies/:companyId/rt2/wiki-lint`), but the result type must expose semantic consistency findings and evidence.
- **D-14:** Scheduled runs should be observable through logs or persisted run metadata. Planning should cover at least one test that proves the runner is schedule-driven and not triggered by wiki writes.

### Agent Discretion
- Embedding provider abstraction and exact similarity threshold.
- Prompt wording for contradiction detection, provided the output is structured and evidence-bound.
- Whether to persist lint issues in a new table or return computed results, as long as nightly runs leave auditable evidence and tests can verify the behavior.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Definition
- `.planning/ROADMAP.md` — Phase 29 goal, dependency, and success criteria.
- `.planning/REQUIREMENTS.md` — LINT-01 through LINT-04.
- `.planning/PROJECT.md` — RealTycoon2 knowledge/economy direction and Phase 29 product intent.
- `.planning/STATE.md` — Current v2.4 milestone state and Phase 29 readiness.

### Prior Phase Context
- `.planning/phases/25-daily-wiki-projector/25-CONTEXT.md` — Daily wiki page source, pageKey conventions, idempotent projector decisions.
- `.planning/phases/26-graphify-projector/26-CONTEXT.md` — Stable graph/wiki dependency, graph cache and daily wiki node context.

### Existing Code
- `server/src/services/rt2-wiki-lint.ts` — Existing lint service to extend with `embedding_consistency`.
- `server/src/routes/rt2-daily-report.ts` — Current wiki lint and quality score API endpoints.
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` — Daily wiki table used as the primary lint corpus.
- `server/src/services/rt2-knowledge-projector.ts` — Existing knowledge projector context and graph/daily wiki integration.
- `server/src/services/plugin-job-scheduler.ts` — Existing scheduled job pattern: due-job scan, overlap prevention, run records, schedule pointer advancement.
- `packages/db/src/schema/plugin_jobs.ts` — Existing job/run persistence shape for schedule and audit patterns.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2WikiLintService.lintWikiPages(companyId, projectId, startDate, endDate)` already reads `rt2_v33_daily_wiki_pages`, builds scoped conditions, and returns checked page count plus issue summaries.
- `Rt2WikiLintIssue` and `Rt2WikiLintResult` already provide a narrow result contract that can be extended to support evidence-rich semantic findings.
- `GET /companies/:companyId/rt2/wiki-lint` already performs company auth, requires `projectId`, accepts optional date range, and returns lint results.
- `plugin-job-scheduler.ts` already demonstrates scheduler tick guards, active-job overlap prevention, run persistence, worker dispatch, and schedule pointer advancement.

### Established Patterns
- Company-scoped routes call `assertCompanyAccess`.
- Existing RT2 services prefer function factories such as `rt2WikiLintService(db)`.
- Daily wiki content is project-scoped and date-scoped. Phase 25 established `daily/YYYY-MM-DD.md` page keys and Phase 26 depends on stable wiki output before downstream graph/lint processing.
- Existing lint behavior is read-only; quality scoring reads lint output but does not mutate pages.

### Integration Points
- Extend `server/src/services/rt2-wiki-lint.ts` with semantic consistency issue types and evidence fields.
- Update shared types/validators if lint results are exported to the UI/client.
- Add or extend server tests around `rt2WikiLintService` and route behavior.
- Add scheduler/runner wiring in the server layer only after confirming the existing app startup pattern for background services.

</code_context>

<specifics>
## Specific Ideas

- `embedding_consistency` should produce findings like: source page A, source page B, snippets from each page, similarity/contradiction score if available, and a reason.
- The nightly job should be explicitly separate from the `emitLiveEventSafely` daily wiki update flow in `rt2-daily-report.ts`.
- The first implementation can use deterministic local heuristics or injectable test doubles for the LLM/embedding layer so unit tests are stable.

</specifics>

<deferred>
## Deferred Ideas

- Auto-fix/remediation workflow for wiki contradictions — future phase.
- Vector embedding + semantic search/pgvector-backed retrieval — deferred v2+ item in `.planning/REQUIREMENTS.md` / `.planning/STATE.md`.
- Cross-company knowledge federation — outside trusted ecosystem scope.

</deferred>

---

*Phase: 29-consistency-linting-batch*
*Context gathered: 2026-04-28*
