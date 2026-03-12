# Development Status

Last updated: 2026-03-11

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
  - CLI/database docs now use resolved-instance path formulas
  - architecture, map, and infrastructure docs reflect the new startup model

## Branch state

- Active branch in this workspace: `development`
- Working tree contains the roadmap/health/governance implementation plus selective upstream adoption for startup safety, transcript UX, and hardening.

## Primary gap

Paperclip now has the strategic primitives for manager autonomy and safer local startup, but the next maintainability gap is structural:

- several server and UI hotspots are large enough to slow review velocity and increase regression risk
- the new condense audit identifies the highest-value extractions, but none of those batches are implemented yet

Product-level gaps still remain:

- roadmap quality determines whether idle managers pick useful next work
- manager-plan approvals govern the workflow, but plan quality is still prompt-driven
- checkout cleanup and wider attribution auditing remain separate hardening work
- worktree/runtime migration remains deferred and needs design work before adoption
- Gemini adapter support remains deferred

## Current blockers

- None at the repo/tooling level right now.
- The remaining risk is completeness, not broken infra:
  - Batch 1 server condensation has not started yet
  - physical checkout cleanup/reaping is still light
  - attribution auditing across every mutation path still deserves a deeper sweep
  - operator UX could use browser QA for the new transcript/config/startup flows

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
