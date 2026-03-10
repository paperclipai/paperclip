# Task List

Last updated: 2026-03-09

## Done

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

## Partial

- Phase 5:
  - checkout reuse exists for repo-backed workspaces
  - issue and run UI show workspace metadata
  - logical checkout release exists
  - missing: physical cleanup/reaping lifecycle and deeper attribution review

## Next

- Tighten checkout lifecycle semantics:
  - release/archive rules
  - cleanup policy
  - operator visibility when a checkout becomes stale
- Sweep remaining attribution paths to ensure every executive mutation carries consistent actor metadata
- Extend pricing-state treatment into any remaining historical cost surface that still assumes exact dollars
- Decide whether briefing delivery stays in-app only or expands into Slack/email/webhook delivery

## Later

- External delivery for briefings and alerts
  - Slack
  - email
  - Discord
  - webhooks beyond current event layer
- richer knowledge retrieval/search
- automated plan-to-issue decomposition
- broader multi-operator governance beyond current board model
