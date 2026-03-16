# Task List

Last updated: 2026-03-16

## Done

- Add deep DEV-DOCS reference docs for:
  - infrastructure
  - cross-subsystem interaction map
- Produce a whole-repo condense audit:
  - scored hotspot inventory
  - five-batch simplification backlog
  - docs overlap map
  - do-not-condense guidance for canonical contracts
- Turn the old Goals surface into the roadmap layer:
  - `/roadmap` UI routes
  - legacy `/goals*` redirects
  - roadmap API aliases over the existing goal service
  - roadmap guidance, horizon, and ordering fields
- Add operator-facing health diagnostics:
  - subsystem health service
  - `/api/health/subsystems`
  - dashboard `System Health` section
- Add manager planning governance:
  - company default planning mode
  - agent override planning mode
  - resolved planning mode in agent reads
  - `approve_manager_plan` approval support
  - top-level issue creation enforcement via `approvalId`
- Add automated coverage for:
  - roadmap aliases
  - subsystem health service and route
  - manager-plan approval wakeups
  - manager planning mode resolution
  - approval-required issue creation
  - new roadmap/health/planning-mode UI rendering
- Add detailed `DEV-DOCS/ARCHITECTURE.md`
- Ship the first executive record layer:
  - `records`, `record_links`, `record_attachments`, `briefing_view_states`
  - `/briefings/board`, `/briefings/results`, `/briefings/plans`
  - shared record detail page
  - promotion to result from issue, approval, and run detail pages
- Harden generic file upload behavior for inert document types and `nosniff`
- Fix project-health aggregation on the executive board
- Add baseline DEV-DOCS snapshot for repo state and recent merged changes
- Add the all-phases data model foundation:
  - `briefing_schedules`
  - `knowledge_entries`
  - `project_milestones`
  - `workspace_checkouts`
- Add backend APIs for:
  - briefing schedules
  - knowledge library
  - portfolio summary
  - project milestones
- Add server-side scheduled briefing generation
- Add UI surfaces for:
  - briefing library
  - portfolio board
  - knowledge library
  - briefing detail schedule/generation controls
- Add checkout-aware workspace isolation for repo-backed issue work
- Improve issue, portfolio, and company cost pricing-truthfulness messaging
- Complete browser QA across the executive surface and operator drilldowns
- Fix workspace execution visibility gaps:
  - persist resolved workspace metadata onto stored runs
  - run process adapters in the resolved checkout cwd
  - normalize `knowledge` company routing
  - avoid misleading schedule defaults while record detail is still loading
- Add logical checkout release semantics when an issue is released, reassigned, or leaves active execution
- Move CI to a development-first branch model:
  - PR policy on `development`
  - PR verify on `development`
  - promotion verify on `master`
  - lockfile refresh bot on `development`
- Add repo-backed execution handoff and observability:
  - lockfile-aware checkout bootstrap before local adapter execution
  - checkout-scoped `PAPERCLIP_WORKSPACE_*` env for local adapters
  - required `reviewSubmission` metadata when repo-backed agents hand work back for review
  - structured local-adapter run events in the agent transcript/events UI
- Fix the `openclaw_gateway` create flow so new-agent setup exposes and serializes the full gateway configuration:
  - auth token header
  - Paperclip API URL override
  - role and scopes
  - wait timeout and session strategy/session key
- Trim surrounding whitespace from OpenClaw gateway create-form URL fields before serialization
- Backfill follow-up coverage and hardening for the 2026-03-14 integration fixes:
  - redaction edge cases around home-dir prefix collisions and punctuation-delimited roots
  - reusable issues-list assignee filter/group/default helpers with focused tests
- Restore roadmap item lifecycle controls on `development`:
  - inline status changes on detail
  - add-child action on detail
  - dependency-aware delete guardrails and modal copy
  - roadmap board lane menus and delete behavior
- Preserve structured transcript lines across chunked adapter stdout/stderr
- Persist repo-backed review submissions even when a fallback checkout row must be created lazily
- Add top-level issues pagination:
  - dedicated `/api/companies/:companyId/issues/page` contract
  - URL-backed filter/sort/page state in `/issues`
  - default terminal-age trimming with valid-page recovery
- Expand verification gates:
  - `pnpm test:coverage`
  - `pnpm test:e2e`
  - Playwright-backed board flow coverage in CI

## Partial

- Phase 5:
  - checkout reuse exists for repo-backed workspaces
  - issue and run UI show workspace metadata
  - logical checkout release exists
  - missing: physical cleanup/reaping lifecycle and deeper attribution review

## Next

- Execute Batch 1 from `DEV-DOCS/CONDENSE-AUDIT.md`:
  - `server/src/routes/access.ts`
  - `server/src/services/heartbeat.ts`
  - `server/src/routes/issues.ts`
  - `server/src/routes/agents.ts`
  - `server/src/services/issues.ts`
  - `server/src/services/company-portability.ts`
- Add status banners or an index for historical docs under `doc/plans/` and `doc/plan/`
- Do browser QA on:
  - dashboard health section
  - roadmap list/detail flows
  - roadmap lane menu and delete-modal flows
  - company settings planning mode controls
  - agent create/edit planning mode controls
  - repo-backed issue handoff to `in_review` / `done` with PR metadata
  - structured run transcript/events rendering in agent detail
  - paginated `/issues` filters, sorting, and page recovery
- Tighten checkout lifecycle semantics:
  - release/archive rules
  - cleanup policy
  - operator visibility when a checkout becomes stale
- Sweep remaining attribution paths to ensure every executive mutation carries consistent actor metadata
- Decide whether roadmap-aware manager guidance should also be seeded into default agent instructions/templates

## Later

- Execute Batch 2 through Batch 5 from `DEV-DOCS/CONDENSE-AUDIT.md`
- External delivery for briefings and alerts
  - Slack
  - email
  - Discord
  - webhooks beyond current event layer
- richer knowledge retrieval/search
- automated plan-to-issue decomposition beyond the current approval-governed manager-plan path
- broader multi-operator governance beyond current board model
