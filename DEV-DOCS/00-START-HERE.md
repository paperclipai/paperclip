# Start Here

Last updated: 2026-03-16

## Current focus

Paperclip has already shipped the executive-layer sprint and now includes the next operational governance layer:

- `/roadmap` as the operator-facing strategy surface (backed by the existing `goals` model)
- roadmap detail lifecycle controls:
  - inline status changes on the hero row
  - add-child action on detail
  - delete confirmation with dependency-aware guardrails for child items, projects, issues, and historical cost records
- roadmap board lane controls restored on `development`, including lane menus and safer delete-modal behavior
- dashboard `System Health` diagnostics
- company-level and agent-level manager planning modes
- approval-gated top-level manager issue creation via `approve_manager_plan`
- durable `records`, schedules, milestones, knowledge publication, and checkout-aware execution flows
- a whole-repo condense audit that identifies the next safe simplification batches
- selective upstream hardening adoption for startup, auth, adapters, and issue filtering
- follow-up hardening for operator-facing redaction edge cases and issues-list assignee filter coverage
- repo-backed checkout bootstrap, review handoff, and structured run-event observability
- transcript event parsing that now preserves stdout/stderr lines when adapter output arrives across chunk boundaries
- fallback checkout materialization for repo-backed review submissions when a run used a shared workspace before a checkout row existed
- an OpenClaw gateway create flow that now exposes the full gateway config instead of only the base URL
- top-level `/issues` pagination with URL-backed filters, sorting, terminal-age trimming, and valid-page recovery when filters shrink the result set
- expanded verification gates:
  - `pnpm test:coverage`
  - `pnpm test:e2e`
  - Playwright browser install in PR verification
- repo-local startup profiles and launch-history auditing for dual-repo workflows
- a reusable agent runs transcript view with readable and raw modes
- a dedicated project `Configuration` tab with explicit-save behavior

## Branch baseline

- Integration branch: `development`
- Docs maintenance branch: `documentation-update`
- Feature and docs PRs should merge into `development`

## Immediate priorities

1. Execute Batch 1 from `DEV-DOCS/CONDENSE-AUDIT.md` against the highest-risk server hotspots.
2. Preserve the compatibility contract:
   - internal `goals` persistence
   - operator-facing `Roadmap` language
3. Keep manager governance rules easy to audit in code reviews.
4. Preserve the repo-backed checkout contract:
   - lockfile-aware bootstrap before local adapter execution
   - review handoff requires branch/commit/PR metadata for repo-backed work, even if the checkout row has to be materialized during handoff
   - structured run events stay readable in the operator UI
5. Treat upstream adoption as selective:
   - take correctness fixes
   - manually adapt UX ideas
   - defer worktree/runtime and Gemini work
6. End with full verification for any code-changing batch:
   - `pnpm -r typecheck`
   - `pnpm test:coverage`
   - `pnpm test:e2e`
   - `pnpm build`

## Important current truths

- `/dashboard` is still the operator telemetry page, but it now also surfaces instance-level subsystem health.
- The old Goals tab is now the Roadmap surface.
- Managers resolve planning mode from company default plus optional agent override.
- Approval-required managers must attach an approved `approvalId` when creating top-level issues.
- The safe-simplification backlog is now documented in `DEV-DOCS/CONDENSE-AUDIT.md`.
- `pnpm start` and `pnpm dev` now pin checkout-specific startup context in `.paperclip/local-start.json`.
- Launch attempts are recorded at `<paperclipHome>/instances/<instanceId>/logs/launch-history.jsonl`.
- `pnpm paperclipai doctor --launch-history` shows the repo-local startup profile plus recent launch records.
- Repo-backed issue checkouts now bootstrap Node dependencies before local adapter execution and persist the result under `workspace_checkouts.metadata.workspaceBootstrap`.
- Repo-backed agent handoffs to `in_review` or `done` now require `reviewSubmission` metadata for repo-backed work, and the checkout row stores branch/commit/PR details for the reviewer even when the run needs a fallback checkout row created during handoff.
- Local adapters now receive checkout-scoped env such as `PAPERCLIP_WORKSPACE_CWD`, `PAPERCLIP_WORKSPACE_CHECKOUT_ID`, `PAPERCLIP_WORKSPACE_BRANCH`, `PAPERCLIP_WORKSPACE_REPO_URL`, and `PAPERCLIP_WORKSPACE_REPO_REF`.
- Agent detail is the primary run-analysis surface via `Dashboard / Configuration / Runs`.
- Agent run transcripts and the Events panel now prefer structured `heartbeat_run_events` for supported local adapters and preserve transcript lines when the adapter emits partial stdout/stderr chunks.
- Project detail uses a dedicated `Configuration` tab so project-level config changes can be reviewed before save.
- Operator-facing redaction now preserves sibling paths that merely share a home-dir prefix and still collapses exact home-dir roots to `~` when punctuation-delimited.
- Issue-list assignee filtering/grouping/default behavior now lives in `ui/src/lib/issues-list.ts` with focused regression coverage.
- The `openclaw_gateway` create flow now exposes token, Paperclip API URL, role, scopes, wait-timeout, and session-strategy inputs and serializes the token into `headers.x-openclaw-token`.
- The `openclaw_gateway` config builder now trims surrounding whitespace from create-form URL fields before serialization.
- `/issues` now reads from a dedicated paginated API route, defaults to 25 rows per page, trims terminal issues older than 48 hours unless requested otherwise, and keeps filters/sort/page in the URL.
- `development` is the active integration branch in this workspace.

## Read next

1. `DEV-DOCS/DEVELOPMENT-STATUS.md`
2. `DEV-DOCS/01-task-list.md`
3. `DEV-DOCS/ARCHITECTURE.md`
4. `DEV-DOCS/UPSTREAM-COMPARISON-2026-03-11.md`
5. `DEV-DOCS/CONDENSE-AUDIT.md`
