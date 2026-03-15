# Recent Changes Snapshot

Date: 2026-03-15

This file explains the current state of the repo in product and operational terms so a human can look at the running app and understand what is actually new.

## March 14 development-window follow-up

The reviewed window on `origin/development` changed repo-backed execution behavior, review handoff metadata, and one agent-setup flow. It did not add a new top-level board destination or API family.

Reviewed merged commits:

1. `1abd1e0` `Implement repo review handoff and run observability`
2. `04e3a55` `Fix OpenClaw gateway agent creation config`
3. `494b867` `fix redaction home-path prefix collision`
4. `2f6bec2` `fix(redaction): redact delimited home-dir roots`
5. `7e08582` `Add issues list assignee filter tests`

Excluded from this snapshot:

- `1b425441` `feat(ui): ship cyberpunk operator console overhaul`
  - present only on `origin/blu-26-cyberpunk-ui-overhaul`
  - not merged into `origin/development` as of this review

## Repo-backed execution and review handoff

Actual code touchpoints:

- `server/src/services/heartbeat.ts`
- `server/src/routes/issues.ts`
- `server/src/services/run-transcript-events.ts`
- `packages/adapter-utils/src/server-utils.ts`
- `packages/shared/src/types/issue.ts`
- `packages/shared/src/validators/issue.ts`
- `packages/db/src/schema/workspace_checkouts.ts`
- `ui/src/lib/run-events.ts`
- `ui/src/pages/AgentDetail.tsx`

What changed in practice:

- repo-backed issue checkouts now bootstrap Node dependencies before local adapter execution instead of immediately failing later with missing-module noise
- bootstrap is lockfile-aware and records its result under `workspace_checkouts.metadata.workspaceBootstrap`
- local adapters now receive checkout-scoped env with the resolved checkout id, branch, repo URL, and repo ref
- when an assignee agent hands repo-backed work back as `in_review` or `done`, the issue update must include `reviewSubmission` metadata with the branch, head commit SHA, and PR URL
- Paperclip persists that PR metadata onto the active checkout row and appends it to the handoff comment so the next reviewer has the branch and PR context inline
- supported local adapters now emit structured `heartbeat_run_events`, and the operator transcript/events UI prefers those structured events over raw-log heuristics when available

What did not change:

- no new company-scoped top-level route was introduced
- the review handoff rides the existing issue update flow rather than a separate review API

## OpenClaw gateway create flow

Actual code touchpoints:

- `ui/src/adapters/openclaw-gateway/config-fields.tsx`
- `packages/adapters/openclaw-gateway/src/ui/build-config.ts`
- `ui/src/components/agent-config-defaults.ts`
- `packages/adapter-utils/src/types.ts`

What changed in practice:

- the `openclaw_gateway` create flow no longer hides required gateway fields behind edit-only behavior
- operators can now set the gateway token, Paperclip API URL override, role, scopes, wait timeout, and session strategy/session key when creating a new agent
- the create-form serializer now turns the token into the header shape the server expects: `headers.x-openclaw-token`

What did not change:

- no new adapter type landed
- the server-side runtime contract for `openclaw_gateway` is unchanged; this was a create-form correctness fix

## March 14 correctness hardening

- `server/src/redaction.ts`
- `server/src/__tests__/redaction.test.ts`
- `ui/src/lib/issues-list.ts`
- `ui/src/lib/issues-list.test.ts`
- `ui/src/components/IssuesList.tsx`

What changed in practice:

- operator-facing log redaction no longer rewrites sibling paths that merely share the local home-directory prefix
- exact home-directory roots still collapse to `~` when they appear inside quotes or other punctuation-delimited text
- issues-list assignee filtering, assignee grouping labels, and group-derived new-issue defaults now share one helper module with focused regression tests for agent, explicit-user, `Me`, and unassigned cases

What did not change:

- no new API surface
- no new route
- no new product destination in the board UI from these hardening commits alone

## Post-merge CI update

The executive-layer sprint is now merged into `development`.

The current follow-up change is operational rather than product-facing:

- feature branches are expected to open PRs into `development`
- PR policy and PR verification now run for `development`
- promotion PRs into `master` still rerun verification
- the lockfile bot now refreshes `pnpm-lock.yaml` on pushes to `development`, not pushes to `master`

Why this changed:

- `development` is where integration and beta/live soak happen
- `master` is the promotion branch
- the old workflow shape was backwards for that branch model

## Merged executive sprint summary

Merged implementation branch:

- `codex/all-phases-executive-sprint`

Key commits from that merged branch:

1. `3a609e3 docs(dev-docs): align current state and roadmap`
2. `007037e feat(briefings): add executive sprint data contracts`
3. `f38c5c3 feat(briefings): add schedule, knowledge, and portfolio apis`
4. `8c8f7be feat(briefings): wire scheduled briefing execution`
5. `0c6072f feat(briefings-ui): add briefing library, portfolio, and knowledge surfaces`
6. `28ed287 feat(workspaces): add checkout-aware workspace isolation`
7. `6f079ad fix(workspaces): run process adapter in resolved workspace`

## What changed in the product

### 1. Briefings is now a real product surface, not just a board tab

Before this sprint branch:

- `/briefings/board` existed
- `/briefings/results` existed
- `/briefings/plans` existed
- briefing records were mostly managed through record detail

Now:

- `/briefings/board`
- `/briefings/briefings`
- `/briefings/results`
- `/briefings/plans`
- `/briefings/portfolio`
- `/briefings/records/:recordId`

What that means:

- `Board` is still the exception-and-decision summary view
- `Briefings` is now the library of briefing records themselves
- `Results` is the durable output library
- `Plans` is the non-ticket planning library
- `Portfolio` is the project/program board

### 2. Scheduled briefing generation now exists

New server-side concept:

- `briefing_schedules`

What it does:

- briefing records can act as templates
- schedules can generate child briefing instances on a cadence
- generated instances can auto-publish
- the scheduler runs inside the server process

Visible user impact:

- briefing detail pages now expose generation controls
- briefing detail pages now expose schedule controls
- generated records carry source/template metadata

### 3. Knowledge publishing now exists

New server-side concept:

- `knowledge_entries`

New UI route:

- `/knowledge`

What it does:

- published results and published briefings can be promoted into a knowledge library
- one source record updates its existing knowledge entry instead of duplicating it
- the knowledge page is now a durable published-artifact library rather than a future idea

### 4. Portfolio board and milestones now exist

New server-side concept:

- `project_milestones`

New API surface:

- `/api/companies/:companyId/briefings/portfolio`
- `/api/projects/:id/milestones`

What it does:

- projects now have milestone records
- the portfolio board can show:
  - project health
  - lead agent
  - budget burn
  - pricing truthfulness
  - milestone status
  - current blocker
  - last meaningful result
  - next board decision
  - confidence

### 5. Worktree-aware workspace isolation has started shipping

New server-side concept:

- `workspace_checkouts`

What it does:

- repo-backed project workspaces can now resolve to issue-specific reusable worktrees
- the isolation key is effectively `(project workspace, issue, agent)`
- when isolation is unavailable, the runtime marks that honestly and falls back to the shared workspace or agent home

Visible user impact:

- agent run detail now shows workspace path, branch, and isolation status
- issue detail now shows workspace-isolation information derived from linked runs

### 6. Cost reporting is more honest in executive and issue views

What changed:

- board anomalies already used `pricingState`
- portfolio rows now show `budgetPricingState`
- issue detail no longer implies priced spend when only token usage exists
- the dedicated `Costs` page now carries `pricingState` through summary, agent rows, and project rows
- agent run history now labels unpriced token usage explicitly instead of leaving the cost column blank

Practical effect:

- unpriced token-heavy work is now labeled as `Unpriced token usage`
- mixed priceable/non-priceable cases can be shown as `estimated`

### 7. Workspace execution context is now visible end to end

This checkpoint fixed a subtle but important operational gap:

- repo-backed issue runs already resolved into worktree checkouts
- but the resolved checkout metadata was not always persisted back into the stored run context

What changed:

- heartbeat execution now writes the enriched `paperclipWorkspace` context back onto the run row before adapter execution continues
- process adapters now execute in the resolved checkout cwd instead of accidentally honoring a stale configured cwd
- process adapters also receive explicit workspace env vars such as:
  - `PAPERCLIP_WORKSPACE_CWD`
  - `PAPERCLIP_WORKSPACE_SOURCE`
  - `PAPERCLIP_WORKSPACE_ID`
  - `PAPERCLIP_WORKSPACES_JSON`

Visible effect:

- issue detail and run detail now show the actual checkout path and branch that the run used
- the workspace-isolation UI is grounded in persisted run metadata, not just in-memory runtime state
- when an issue is released, reassigned, or moved out of active execution, its active checkout rows are now marked `released`

### 8. Briefing and routing polish removed misleading UI states

Two smaller but important UX fixes also landed during verification:

- the record-detail schedule card no longer flashes fake default values while the saved schedule is still loading
- `knowledge` is now treated as a real company-scoped board route root, so `/EXE/knowledge` works correctly from nav and path normalization

## New DB/API/UI footprint

### New database tables on this branch

- `briefing_schedules`
- `knowledge_entries`
- `project_milestones`
- `workspace_checkouts`

### New server/API surface on this branch

- `GET /api/companies/:companyId/briefings/portfolio`
- `GET /api/records/:recordId/schedule`
- `PUT /api/records/:recordId/schedule`
- `DELETE /api/records/:recordId/schedule`
- `GET /api/companies/:companyId/knowledge`
- `GET /api/knowledge/:entryId`
- `POST /api/records/:recordId/publish-to-knowledge`
- milestone CRUD under `/api/projects/:id/milestones`

### New UI surface on this branch

- `Briefings` tab for briefing-library management
- `Portfolio` tab for program/project rollups
- `Knowledge` sidebar destination and library page
- schedule and generation controls inside record detail

## What to click in the app now

If you are looking at the running app and want the shortest useful tour:

1. Open `/dashboard`
   - still telemetry only
2. Open `/briefings/board`
   - executive exception view
3. Open `/briefings/briefings`
   - briefing templates and generated instances
4. Open `/briefings/portfolio`
   - project/program board
5. Open `/knowledge`
   - published durable knowledge
6. Open any result or briefing record detail
   - generate, schedule, publish, attach files, publish to knowledge
7. Open any agent run detail
   - inspect the workspace path/branch/isolation state

## What is still not done

This branch moves far past the original Phase 1 merge, but some gaps still remain:

- no Slack/email/Discord delivery for briefings
- no automatic plan-to-issue decomposition
- no full worktree lifecycle management yet
  - logical checkout release now exists, but physical cleanup/reaping is still minimal
- attribution audit hardening still deserves a deeper sweep across every mutation path
- the knowledge layer is lightweight by design
  - it is not a semantic search/retrieval system yet
