# Phase 29: Consistency Linting (Batch) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the auto discussion choices.

**Date:** 2026-04-28
**Phase:** 29-consistency-linting-batch
**Mode:** discuss `--auto --chain`
**Areas analyzed:** Batch execution model, lint service scope, evidence-only findings, candidate selection, API and observability

## Auto-Selected Gray Areas

`[--auto] Selected all gray areas: Batch execution model, lint service scope, evidence-only findings, candidate selection, API and observability.`

## Decisions Presented

### Batch Execution Model
| Question | Auto-selected choice | Rationale |
|----------|----------------------|-----------|
| How should the lint run be triggered? | Nightly scheduled batch job | Roadmap requires schedule-based execution and explicitly excludes on-write execution. |
| Should the runner reuse existing scheduling concepts? | Reuse existing scheduler/job shape where practical | `plugin-job-scheduler.ts` already has overlap prevention, run records, and cron-style next-run handling. |

### Lint Service Scope
| Question | Auto-selected choice | Rationale |
|----------|----------------------|-----------|
| Where should consistency linting live? | Extend `rt2WikiLintService` | Requirement LINT-03 explicitly names the service. |
| How should semantic findings be classified? | Add `embedding_consistency` as a distinct check/issue type | Keeps expensive semantic checks separate from existing deterministic page-quality lint. |

### Evidence-Only Findings
| Question | Auto-selected choice | Rationale |
|----------|----------------------|-----------|
| What should a lint issue contain? | Page ids/keys, dates, evidence snippets, severity, check type, reason | LINT-02 requires evidence and no auto-fix. |
| What happens when semantic providers fail? | Record/report failure or skip semantic check visibly | Avoid false clean results when LLM/embedding checks did not run. |

### Candidate Selection
| Question | Auto-selected choice | Rationale |
|----------|----------------------|-----------|
| What corpus should be scanned first? | Project-scoped daily wiki pages | Phase 25/26 established daily wiki pages as stable knowledge content and Phase 29 depends on Phase 26. |
| Should graph data be mandatory? | Use graph context as optional narrowing only | Avoid coupling the first lint implementation to community detection unless existing code makes it trivial. |

### API and Observability
| Question | Auto-selected choice | Rationale |
|----------|----------------------|-----------|
| How should users inspect findings? | Extend existing wiki-lint API/result shape | Current route already scopes by company/project and date range. |
| How should scheduled runs be verified? | Persist or log run metadata and test non-on-write behavior | LINT-04 requires schedule-driven execution. |

## Prior Context Applied

- Phase 25 established `rt2_v33_daily_wiki_pages`, `daily/YYYY-MM-DD.md`, and batch linting as a future read-only scan.
- Phase 26 established that linting depends on stable daily wiki/graph projection output.
- `.planning/STATE.md` explicitly notes vector search is deferred, while Phase 29 covers scheduling and LLM consistency checks.

## Deferred Ideas

- Auto-fixing wiki contradictions.
- pgvector/vector semantic search as a broader platform capability.
- Cross-company knowledge federation.

