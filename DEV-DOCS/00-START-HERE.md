# Start Here

Last updated: 2026-03-11

## Current focus

Paperclip has already shipped the executive-layer sprint and now includes the next operational governance layer:

- `/roadmap` as the operator-facing strategy surface (backed by the existing `goals` model)
- dashboard `System Health` diagnostics
- company-level and agent-level manager planning modes
- approval-gated top-level manager issue creation via `approve_manager_plan`
- durable `records`, schedules, milestones, knowledge publication, and checkout-aware execution flows
- a whole-repo condense audit that identifies the next safe simplification batches
- selective upstream hardening adoption for startup, auth, adapters, and issue filtering
- repo-local startup profiles and launch-history auditing for dual-repo workflows
- a reusable agent runs transcript view with readable and raw modes
- a dedicated project `Configuration` tab with explicit-save behavior

## Current branch

- Working branch: `development`
- Integration branch: `development`

## Immediate priorities

1. Keep `DEV-DOCS/` aligned with the new startup-profile, launch-history, and runs/configuration UX behavior.
2. Execute Batch 1 from `DEV-DOCS/CONDENSE-AUDIT.md` against the highest-risk server hotspots.
3. Preserve the compatibility contract:
   - internal `goals` persistence
   - operator-facing `Roadmap` language
4. Keep manager governance rules easy to audit in code reviews.
5. Treat upstream adoption as selective:
   - take correctness fixes
   - manually adapt UX ideas
   - defer worktree/runtime and Gemini work
6. End with full verification for any code-changing batch:
   - `pnpm -r typecheck`
   - `pnpm test:run`
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
- Agent detail is the primary run-analysis surface via `Dashboard / Configuration / Runs`.
- Project detail uses a dedicated `Configuration` tab so project-level config changes can be reviewed before save.
- `development` is the active integration branch in this workspace.

## Read next

1. `DEV-DOCS/DEVELOPMENT-STATUS.md`
2. `DEV-DOCS/01-task-list.md`
3. `DEV-DOCS/ARCHITECTURE.md`
4. `DEV-DOCS/UPSTREAM-COMPARISON-2026-03-11.md`
5. `DEV-DOCS/CONDENSE-AUDIT.md`
