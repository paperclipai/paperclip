# Development Status

Last updated: 2026-03-15

## Current feature status

- Roadmap surface: `done`
  - operator-facing rename from Goals to Roadmap
  - roadmap grouping by planning horizon
  - manager guidance field and ordered roadmap presentation
  - compatibility alias routes preserved for existing goal-backed links
- System health diagnostics: `done`
  - `GET /api/health/subsystems`
  - dashboard `System Health` section
  - database, deployment/auth, `qmd`, and local-adapter diagnostics
- Manager planning governance: `done`
  - company default planning mode
  - agent override planning mode
  - resolved planning mode exposed by the server
  - `approve_manager_plan` approvals
  - top-level agent issue creation enforcement when approval is required
- DEV-DOCS refresh: `done`
  - new architecture document
  - operational spine updated to match the shipped code
  - added dedicated infrastructure and interaction-map docs
- Full condense audit: `done`
  - scored hotspot inventory across code and docs
  - five-batch backlog for safe simplification
  - docs overlap map and do-not-condense guidance
- Selective upstream hardening adoption: `done`
  - HTTP deployments now disable secure auth cookies safely
  - issues list now honors `parentId` filters end to end
  - heartbeat run list responses use trimmed operator-facing summaries
  - child-process env hardening strips nested Claude env leakage
  - Windows/local adapter wrapper handling is more robust
- Assignee filter helpers and regression coverage: `done`
  - `ui/src/lib/issues-list.ts` now owns shared assignee filtering, grouping labels, and group-derived new-issue defaults
  - tests cover agent, explicit-user, `Me`, and unassigned assignee filters
- Redaction edge-case follow-up: `done`
  - operator-facing text redaction no longer rewrites sibling paths that only share a home-dir prefix
  - exact home-dir roots still collapse to `~` when surrounded by punctuation or quotes
- Repo-backed checkout bootstrap and review handoff: `done`
  - `heartbeatService` now bootstraps Node dependencies inside isolated repo checkouts with lockfile-aware package-manager selection
  - local adapters receive checkout env including checkout id, branch, repo URL, and repo ref
  - repo-backed agent handoffs to `in_review` / `done` must include `reviewSubmission`, and the checkout row persists branch/commit/PR metadata
- Structured run observability: `done`
  - supported local adapters now persist structured `heartbeat_run_events` alongside raw run logs
  - agent-detail transcripts and the Events panel prefer structured events when they exist and fall back to raw log parsing for older runs
- OpenClaw gateway create flow: `done`
  - create mode now exposes the gateway auth token, Paperclip API URL override, role, scopes, wait timeout, and session strategy/session key fields
  - the create-form serializer now emits the server-required gateway header shape, including `headers.x-openclaw-token`
- Runs and configuration UX: `done`
  - reusable transcript renderer with `nice` / `raw` modes
  - agent runs remain a first-class detail surface
  - project detail now has an explicit-save `Configuration` tab
  - project side-panel properties no longer undercut explicit-save config edits
- Startup safety and launch auditing: `done`
  - repo-local startup profile at `.paperclip/local-start.json`
  - `--choose-startup` and `--clear-startup-profile` for repo scripts
  - non-interactive startup now fails fast when the instance is ambiguous
  - launch history recorded under instance logs
  - `paperclipai doctor --launch-history` shows pinned profile and recent launches
- Documentation sync: `done`
  - startup docs now describe repo-local profiles and launch history
  - dev docs now describe repo-backed checkout bootstrap, review handoff metadata, and structured run events
  - CLI/database docs now use resolved-instance path formulas
  - architecture, map, and infrastructure docs reflect the new startup model

## Branch state

- Active integration branch: `development`
- Docs sync branch: `documentation-update`
- Current working baseline contains the roadmap/health/governance implementation plus selective upstream adoption for startup safety, transcript UX, the March 14 redaction/issues-list follow-up hardening, repo-backed review handoff observability, and the OpenClaw gateway create-form fix.

## Primary gap

Paperclip now has the strategic primitives for manager autonomy and safer local startup, but the next maintainability gap is structural:

- several server and UI hotspots are large enough to slow review velocity and increase regression risk
- the new condense audit identifies the highest-value extractions, but none of those batches are implemented yet

Product-level gaps still remain:

- roadmap quality determines whether idle managers pick useful next work
- manager-plan approvals govern the workflow, but plan quality is still prompt-driven
- checkout cleanup and wider attribution auditing remain separate hardening work
- broader worktree/runtime migration remains deferred beyond the current checkout bootstrap and review-handoff contract
- Gemini adapter support remains deferred

## Current blockers

- None at the repo/tooling level right now.
- The remaining risk is completeness, not broken infra:
  - Batch 1 server condensation has not started yet
  - physical checkout cleanup/reaping is still light
  - attribution auditing across every mutation path still deserves a deeper sweep
  - operator UX could use browser QA for the new transcript/config/startup flows and repo-backed review handoffs

## Verification posture

Definition of done for the current branch remains:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Verified on this branch:

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
