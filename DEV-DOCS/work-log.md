# Work Log

## 2026-03-16

### Session: late March 15 docs sync

- Reviewed the post-`2026-03-15T13:00:15Z` `origin/development` window before updating DEV-DOCS.
- Grounded the update in these behavior-changing commits:
  - `bd43e51` `Trim OpenClaw gateway create URLs`
  - `9cba34a` `fix(server): preserve transcript lines across stream chunks`
  - `17ca926` `Expose roadmap status editing on goal detail`
  - `6ff2476` `fix: restore roadmap item controls on development`
  - `f5fabfe` `fix roadmap board lanes and delete modal`
  - `0cf4cd5` `Harden test coverage and CI gates`
  - `97b9d26` `Add paginated company issues query`
  - `9636895` `feat: paginate the top-level issues page`
  - `9845d17` `Fix repo review handoff without checkout metadata`
  - `24626f8` `Fix paginated issues page regression`
- Refreshed the DEV-DOCS operational spine so it now reflects:
  - roadmap item lifecycle controls and dependency-aware delete guardrails
  - transcript chunk preservation and fallback checkout persistence for repo-backed review handoff
  - the expanded verification contract (`typecheck`, `test:coverage`, `test:e2e`, `build`)
  - the new paginated `/issues` route and UI behavior
- No speculative entries were added for docs-only commits or merge-only commits.

## 2026-03-14

### Session: OpenClaw agent creation form fix

- Fixed the `openclaw_gateway` new-agent flow so create mode now exposes the gateway token and other gateway-specific configuration instead of only the WebSocket URL.
- Extended the shared create-form state and OpenClaw config builder so create-mode values serialize into the server-required adapter config shape, including `headers.x-openclaw-token`.
- Added UI regression coverage for:
  - create-mode rendering of the OpenClaw token/config fields
  - config serialization of gateway token, scopes, wait timeout, and fixed-session overrides
- Re-ran:
  - `pnpm exec vitest run ui/src/adapters/openclaw-gateway/config-fields.test.tsx`
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

### Session: repo review handoff and structured run observability

- Added lockfile-aware workspace bootstrap in `server/src/services/heartbeat.ts` for repo-backed issue checkouts:
  - detects `pnpm`, `npm`, `yarn`, and `bun` lockfiles
  - skips reinstall when the saved bootstrap metadata still matches the checkout
  - fails early with a bootstrap error when the required package manager is missing or install fails
- Extended the repo-backed local-adapter runtime contract so execution now receives checkout-specific env such as:
  - `PAPERCLIP_WORKSPACE_CWD`
  - `PAPERCLIP_WORKSPACE_CHECKOUT_ID`
  - `PAPERCLIP_WORKSPACE_BRANCH`
  - `PAPERCLIP_WORKSPACE_REPO_URL`
  - `PAPERCLIP_WORKSPACE_REPO_REF`
- Added `reviewSubmission` to issue update contracts for repo-backed handoffs to `in_review` / `done`:
  - active checkouts now require branch name, head commit SHA, and PR URL when the assignee agent hands work back
  - `workspace_checkouts` now persist branch/remote/PR metadata plus `submittedForReviewAt`
  - handoff comments append the review-submission details for the human creator, project lead, or manager reviewer
- Structured run observability is now first-class for supported local adapters:
  - machine-readable stdout now persists as `heartbeat_run_events`
  - agent detail prefers those structured events for transcripts and the Events panel while older runs still fall back to raw log parsing
- Added focused coverage in:
  - `server/src/__tests__/heartbeat-bootstrap.test.ts`
  - `server/src/__tests__/issues-routes.test.ts`
  - `server/src/__tests__/run-transcript-events.test.ts`
  - `ui/src/lib/run-events.test.ts`
  - `ui/src/components/planning-mode-ui.test.tsx`

### Session: follow-up hardening for redaction boundaries and issues-list assignee helpers

- Reviewed the 2026-03-14 `origin/development` commits that changed shipped behavior or regression coverage:
  - `494b867` `fix redaction home-path prefix collision`
  - `2f6bec2` `fix(redaction): redact delimited home-dir roots`
  - `7e08582` `Add issues list assignee filter tests`
- Tightened operator-facing redaction in `server/src/redaction.ts` so:
  - sibling paths that only share a home-directory prefix are left untouched
  - exact home-directory roots still redact to `~` when delimited by punctuation or quotes
- Added regression coverage in `server/src/__tests__/redaction.test.ts` for both home-path edge cases.
- Extracted shared issues-list assignee behavior into `ui/src/lib/issues-list.ts`:
  - assignee filtering
  - assignee grouping keys and labels
  - group-derived defaults for new issue creation
- Added focused coverage in `ui/src/lib/issues-list.test.ts` for:
  - agent assignee filters
  - explicit user filters
  - `Me` and unassigned filters
  - assignee-group labels and new-issue defaults
- Kept the change scoped to correctness and coverage:
  - no new route, API, or product surface was introduced by these commits
## 2026-03-13

### Session: QoL upstream adoption for assignee UX, dialog flow, and privacy hardening

- Added shared assignee-selection helpers so operator-facing issue surfaces can treat agent and user assignees consistently.
- Updated issue lists and issue properties to support:
  - `Me`
  - `No assignee`
  - requester shortcuts that stay visible when requester and current operator differ
  - clearer user-assignee labels (`Me`, `Board`, short stable id)
- Refactored the new issue dialog to store a stable assignee selection value instead of an agent-only id:
  - user assignees now persist through local draft restore
  - legacy drafts with raw agent ids still restore correctly
  - title `Tab` flow now skips prefilled assignee and project fields
- Broadened operator-facing redaction:
  - transcript and run-detail surfaces now hide current-user identifiers and home-directory paths while keeping surrounding context readable
  - live event payloads pass through the same redaction layer before reaching the UI
- Hardened CLI env-file writing so generated `.env` values quote spaces, `#`, quotes, and other shell-significant characters safely.
- Added focused automated coverage for:
  - assignee helper parsing/formatting
  - new issue dialog focus/draft helpers
  - UI-side operator log redaction
  - server-side path and username redaction
  - env-file quoting round trips

## 2026-03-11

### Session: selective upstream adoption, startup safety, and docs sync

- Adopted the upstream hardening items that fit this fork cleanly:
  - secure cookies disabled for HTTP auth deployments
  - nested Claude env stripping for child processes
  - stronger Windows/local adapter wrapper handling
  - parent-aware issues list filtering
  - lighter heartbeat run summaries for operator surfaces
- Added repo-local startup safety for `pnpm start` and `pnpm dev`:
  - `.paperclip/local-start.json` profile resolution
  - `--choose-startup` and `--clear-startup-profile`
  - append-only launch history at `instances/<id>/logs/launch-history.jsonl`
  - server-side ready recording plus CLI doctor history output
- Tightened run and configuration UX:
  - extracted a reusable transcript renderer with readable and raw modes
  - kept agent detail as the primary run-analysis surface
  - added a project `Configuration` tab with explicit-save behavior
  - removed the conflicting side-panel/project-properties path while the config tab is active
- Added automated coverage for:
  - startup profile resolution helpers
  - doctor launch-history/profile rendering
  - transcript rendering modes
  - heartbeat summary and issue filter behavior
  - HTTP auth cookie configuration
- Refreshed user docs and DEV-DOCS so startup, runtime paths, run UX, and selective upstream adoption are all described consistently.
- Repaired the local dependency installation and re-ran:
  - `pnpm install --force`
  - `pnpm -r typecheck`
  - `pnpm test:run`

## 2026-03-10

### Session: simplify local startup command

- Added a root `pnpm start` wrapper at `scripts/start-local.mjs`.
- Updated the main startup docs so there is one clear answer to "how do I start this app?":
  - `README.md`
  - `doc/DEVELOPING.md`
  - `doc/DATABASE.md`
  - `AGENTS.md`
  - `DEV-DOCS/repo-state.md`
- Added a startup preflight so incomplete local installs fail with a direct remediation message instead of a raw module-resolution stack.
- Clarified the split between:
  - `pnpm start` for the simplest local startup
  - `pnpm dev` for active code changes with watch mode
- Verified that `pnpm start` currently fails fast with a clear preflight in this workspace because required dependency payloads are missing under `server/node_modules`.

### Session: infrastructure and system-map docs

- Added `DEV-DOCS/INFRASTRUCURE.md`:
  - runtime topology
  - configuration layers
  - database and filesystem layout
  - auth, storage, secrets, adapter, realtime, scheduler, UI, and CLI infrastructure
- Added `DEV-DOCS/MAP.md`:
  - topology map
  - startup sequence
  - operator request path
  - manager roadmap governance flow
  - issue execution flow
  - records/briefings flow
  - asset, secret, and live-update maps
- Updated the DEV-DOCS spine so the new docs are discoverable from `README.md` and reflected in status/task tracking.
- Verified the doc-only change set with:
  - `git diff --check`

### Session: full condense audit and backlog

- Ran a whole-repo safe-simplification audit across:
  - `server/src`
  - `ui/src`
  - `packages/shared/src`
  - `packages/db/src`
  - `DEV-DOCS/`
  - `doc/`
  - `docs/`
- Produced `DEV-DOCS/CONDENSE-AUDIT.md` with:
  - hotspot scoring
  - a five-batch implementation backlog
  - a docs overlap map
  - explicit do-not-condense guidance for canonical contract files
- Updated the DEV-DOCS operational spine so Batch 1 server condensation is the next documented maintainability step.
- Verified the doc-only change set with:
  - `git diff --check`

### Session: roadmap, health, and manager-governance implementation

- Extended the `goals` model into the operator-facing roadmap surface:
  - added `planningHorizon`, `sortOrder`, and `guidance`
  - added roadmap alias routes while preserving goal compatibility
  - renamed the UI surface from Goals to Roadmap
- Added system-health diagnostics:
  - new subsystem health service
  - `GET /api/health/subsystems`
  - dashboard `System Health` section
- Added manager planning governance:
  - company default planning mode
  - agent override planning mode
  - resolved planning mode in agent reads
  - `approve_manager_plan`
  - top-level issue creation enforcement with `approvalId`
- Added focused automated coverage for:
  - subsystem health service and route
  - roadmap alias routes
  - approval-required issue creation
  - manager-plan approval wakeups
  - manager planning mode resolution
  - roadmap/health/planning-mode UI rendering
- Refreshed DEV-DOCS and added a detailed architecture document grounded in the current code.
- Re-ran:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

### Session: development-first CI alignment

- Updated GitHub Actions to match the intended branch model:
  - PR policy now runs for `development` and `master`
  - PR verification now runs for `development` and `master`
  - lockfile refresh moved from `master` pushes to `development` pushes
- Preserved the lockfile policy for promotion PRs:
  - manual `pnpm-lock.yaml` edits are still blocked
  - `development` -> `master` promotion PRs may carry the CI-owned lockfile update
- Updated `doc/DEVELOPING.md` and the DEV-DOCS operational spine so the branch/CI contract is explicit instead of implied.
- Re-ran:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## 2026-03-09

### Session: executive-layer status and sprint baseline

- Verified the repo state on `development` after the merged executive briefings work.
- Documented the current shipped product shape:
  - telemetry dashboard
  - executive board
  - durable plans/results
  - record detail and promotion flows
- Added the missing DEV-DOCS operational spine so the next sprint work has a trustworthy status ledger.
- Marked the roadmap truthfully:
  - Phase 1 shipped
  - Phases 2, 4, and 5 partial
  - Phase 3 not started

### Session: all-phases sprint implementation

- Added shared/data-model contracts for:
  - briefing schedules
  - knowledge entries
  - project milestones
  - workspace checkouts
- Added backend APIs and services for:
  - schedule CRUD
  - schedule execution
  - knowledge publication
  - portfolio summaries
  - milestone CRUD
- Added UI surfaces for:
  - briefing library
  - portfolio board
  - knowledge library
  - briefing detail generation/schedule controls
- Added repo-backed workspace checkout resolution in heartbeat execution.
- Surfaced workspace metadata into run and issue detail pages.
- Improved issue-level and portfolio-level cost truthfulness messaging for unpriced usage.
- Re-ran:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

### Session: QA hardening and sprint verification

- Fixed the process adapter so repo-backed issue runs execute in the resolved checkout cwd instead of falling back to stale config cwd.
- Persisted enriched `paperclipWorkspace` context back onto heartbeat runs so issue detail and run detail can show the real checkout path and branch after the run completes.
- Fixed company route handling for `/knowledge`.
- Fixed record detail so schedule controls do not flash misleading default values before the saved schedule loads.
- Extended cost truthfulness into the dedicated `Costs` page and agent run cost rows.
- Added focused automated coverage for:
  - process adapter workspace cwd/env propagation
  - record schedule routes
  - cost pricing-state aggregation
  - company route handling for `/knowledge`
- Completed browser QA against:
  - briefing board
  - briefing library
  - plans/results libraries
  - portfolio board
  - knowledge library
  - issue detail
  - approval detail
  - agent run detail
- Final verification passed:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

### Session: checkout lifecycle follow-through

- Added a logical checkout release boundary in `issues.ts`.
- Active workspace checkout rows now transition to `released` when an issue:
  - leaves `in_progress`
  - changes assignee
  - is explicitly released back to `todo`
- Added focused unit coverage for the release-decision helper.
- Re-ran focused verification:
  - `pnpm --filter @paperclipai/server typecheck`
  - `pnpm vitest run server/src/__tests__/issues-user-context.test.ts server/src/__tests__/costs-service.test.ts server/src/__tests__/process-adapter-workspace.test.ts`
