# Recent Changes Snapshot

Date: 2026-03-09

This file explains the current sprint branch in product terms so a human can look at the running app and understand what is actually new.

## Sprint branch summary

Current branch:

- `codex/all-phases-executive-sprint`

Key local commits on this branch:

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
