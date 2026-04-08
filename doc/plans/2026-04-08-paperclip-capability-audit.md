# 2026-04-08 Paperclip Capability Audit

Status: Draft
Date: 2026-04-08
Audience: Product and engineering
Related:
- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `doc/DEPLOYMENT-MODES.md`
- `doc/plans/2026-02-21-humans-and-permissions.md`
- `doc/plugins/PLUGIN_SPEC.md`

## 1. Purpose

This document records a code-validated audit of Paperclip's current product and platform surface.

It exists to answer a recurring question that comes up in repo reviews and external summaries:

- what Paperclip clearly supports today
- which claims are directionally right but overstated
- which gaps are real product gaps versus deliberate V1 tradeoffs
- which roadmap items make the most sense from the current architecture

This is not a replacement for `doc/SPEC-implementation.md`.
That file remains the V1 build contract.
This audit is a repo snapshot and correction layer for current-state analysis.

## 2. Existing Source Documents

There is no single existing document that already says all of this in one place.

Current facts are spread across:

- `doc/SPEC-implementation.md` for the original V1 contract and explicit out-of-scope decisions
- `doc/PRODUCT.md` and `doc/GOAL.md` for product intent
- `doc/plans/2026-02-21-humans-and-permissions.md` for the permissions and multi-human direction
- `doc/plugins/PLUGIN_SPEC.md` for the plugin architecture
- code under `server/`, `ui/`, and `packages/db/` for features that moved beyond the original V1 scope

Because of that split, repo summaries can accidentally mix:

- original V1 intent
- shipped features added later
- proposed roadmap items

## 3. High-Level Verdict

The common summary that "Paperclip is already a strong AI-agent control plane with real governance and extensibility" is fair.

The common summary that it is already a fully enterprise-complete company operating system is not yet fair.

The codebase shows:

- a strong company-scoped control-plane core
- real agent orchestration, issue tracking, approvals, budgets, routines, realtime, import/export, and plugin extensibility
- a meaningful permissions foundation
- several missing organizational and enterprise operations layers that would be needed for a broader company OS story

## 4. What Is Clearly Supported Today

The following statements are supported by the current docs and code:

### 4.1 Core product model

- Paperclip is company-first and company-scoped.
- The primary operator experience is a control plane for autonomous agents.
- The core work loop is goals, agents, issues, comments, approvals, heartbeats, costs, and budgets.

This matches:

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`

### 4.2 Backend, frontend, and data stack

- Backend: Node.js, Express, TypeScript
- Frontend: React, Vite, Tailwind, shadcn-style component setup
- Database: PostgreSQL via Drizzle
- Monorepo: pnpm workspaces with server, UI, CLI, database/shared packages, adapters, and plugin packages

### 4.3 Implemented feature areas

The repo has real support for:

- agents and org hierarchy
- issues/tasks with comments and workflow states
- projects and goals
- approvals with approve, reject, request revision, and resubmit flows
- routines with schedule and webhook triggers plus concurrency policy
- cost tracking and budget enforcement
- inbox and notification workflows
- realtime live updates over WebSocket
- portable company export as Markdown package plus ZIP download
- plugin runtime, plugin jobs, plugin UI slots, and plugin state
- local disk and S3-compatible object storage

### 4.4 Multi-user and permission foundations

Paperclip is no longer only "admin/member".

It already has:

- `company_memberships`
- `principal_permission_grants`
- `instance_user_roles`
- service-layer permission checks

That means the correct description is:

- there is a real permissions foundation
- there is not yet a polished, enterprise-grade role model with organizational scoping and strong admin UX

## 5. Corrections to Common Overstatements

The following claims should be corrected when describing the current repo.

### 5.1 Auth

Do not describe current auth as "Better Auth + JWT + GitHub/Google OAuth".

A more accurate statement is:

- human auth uses Better Auth sessions
- the shipped human auth flow is email/password
- JWT support exists for agent execution/auth contexts, not as the primary human auth story

Social login and enterprise SSO remain future-facing directions, not current core behavior.

### 5.2 Approvals

Do not describe approvals as multi-signature.

A more accurate statement is:

- Paperclip has a complete single-decision approval workflow with revision and resubmission
- the schema does not model a general multi-signature approval chain

### 5.3 Org chart rendering

Do not describe the org chart as canvas-based.

A more accurate statement is:

- the product has a real interactive org chart
- the implementation is SVG/DOM-based with pan and zoom behavior

### 5.4 Jobs and scheduling

Do not describe background work as purely in-memory.

A more accurate statement is:

- scheduling is server-process and tick-based today
- job and run data are persisted in the database
- the current limitation is scale and worker architecture, not total lack of persistence

### 5.5 RBAC

Do not describe RBAC as absent.

A more accurate statement is:

- Paperclip has grants and permission checks already
- what is missing is a mature role system, richer scopes, department-aware access patterns, and a stronger admin product surface

### 5.6 Backup and restore

Do not describe backups as present without automated restore coverage.

A more accurate statement is:

- backup and restore logic exist
- restore behavior is covered by tests
- the open question is production-grade restore operations and operational maturity, not the absence of restore verification in code

### 5.7 Security wording

Do not overstate current security posture as if the product already has all enterprise controls.

A more accurate statement is:

- origin-based mutation protection exists for board mutations
- secret-handling safeguards and redaction exist
- a narrow secret-resolution rate limit exists
- a general API-wide rate limiting and observability/security hardening layer is still incomplete

### 5.8 Snapshot numbers

Avoid hard-coding exact counts in externally shared summaries unless they are recalculated at the time of writing.

Counts such as:

- number of adapters
- number of tables
- number of migrations
- number of tests
- number of contributors
- number of commits

drift quickly and turn otherwise solid analysis into a partially stale one.

## 6. Real Gaps That Still Matter

These product gaps remain real and strategically important.

### 6.1 Organizational model

Paperclip is still missing first-class organizational entities such as:

- departments
- teams as managed entities
- department memberships
- department-scoped ownership and visibility rules

This is the biggest structural gap if the goal is to model a fuller company operating system.

### 6.2 Mature role product

Even with grants in place, the product still lacks:

- named reusable roles
- clean permission bundles
- department-scoped or org-scoped admin UX
- enterprise-friendly permission management flows

### 6.3 SLA and deadline operations

Issues do not yet present a full operational layer for:

- due dates
- SLA targets
- lateness alerts
- escalation policies

### 6.4 Enterprise reporting and exports

Portable Markdown export exists, but typical operator reporting still lacks:

- CSV export
- XLSX export
- PDF reporting
- scheduled report workflows aimed at business operators

### 6.5 Observability

Paperclip does not yet show a standard enterprise observability stack such as:

- OpenTelemetry tracing
- Prometheus metrics
- prebuilt Grafana dashboards
- alerting integrations

### 6.6 Internationalization

The UI is still effectively English-only today.

### 6.7 Queue and worker architecture

The current process-local scheduler is a reasonable V1/V1.5 choice, but it is not yet the final shape for:

- high availability
- horizontal workers
- resilient retries
- dead-letter workflows

## 7. Recommended Roadmap Priority

From the current architecture, the next steps that make the most sense are:

1. Add first-class departments and team structure.
2. Evolve the existing permission foundation into a stronger role product.
3. Add SLA, due-date, and escalation mechanics to issues and inbox flows.
4. Add outbound integrations and operator-facing exports.
5. Add stronger observability and production operations tooling.
6. Move to external queue and worker infrastructure when scale or reliability demands it.

Items such as i18n, calendar UI, and extensive customizable dashboards are still reasonable, but they are less foundational than organizational structure, permissions, and operations.

## 8. Recommended External Summary Language

If a concise current-state description is needed, this wording is closer to the codebase reality:

> Paperclip already ships a strong company-scoped AI-agent control plane: agents, org hierarchy, issues, approvals, budgets, routines, realtime updates, portable export, and a substantial plugin system are all present. The largest remaining gaps are not the core control-plane loop, but the broader organizational and enterprise layers: first-class departments, more mature RBAC, SLA/deadline operations, standard business exports, and production observability.

## 9. Bottom Line

The underlying architecture is strong.

The biggest mistake in external analyses is usually not missing the strengths.
It is blending together:

- current shipped behavior
- older V1 assumptions
- future enterprise ambitions

This audit should be used as the repo-aligned correction layer for that problem.
