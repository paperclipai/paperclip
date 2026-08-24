---
title: Release Notes
summary: Curated release notes for each Paperclip release
version: docs-v1
last_updated: 2026-08-23
---

# Release Notes

Paperclip ships continuously. This page documents each release to the main branch with curated, customer-facing notes.

---

## M5 A/B Pricing Experiment — August 23, 2026

**Status: Implementation complete. Awaiting Code Review and QA.**

### Highlights

- **Server-side A/B pricing test** — Companies are deterministically assigned to control (current pricing) or treatment (adjusted lower pricing) on first visit to the pricing page. Assignment is persisted — the same company always sees the same variant.
- **Variant B pricing** — Lower entry price: Adventurer $19/mo ($190/yr), Explorer $69/mo ($690/yr), Elite $179/mo ($1,790/yr). All tiers reduced by $10-20/mo to reduce signup friction.
- **Env-var controlled** — Experiment is enabled/disabled via `PRICING_EXPERIMENT_CONFIG` JSON environment variable. No deploy needed to toggle.
- **Stripe metadata tracking** — Checkout sessions include `pricingExperimentVariant` metadata for per-variant conversion analysis in Stripe dashboard.
- **Graceful fallback** — When experiment is disabled, all companies see control pricing. If variant B tier overrides are not configured, variant B falls back to control prices.
- **Board-only results endpoint** — `GET /billing/experiment-results` provides per-variant enrollment counts and conversion stats.

### Implementation

- Migration `0230_pricing_experiment_columns.sql` adds experiment columns to companies table
- `pricing-experiment.ts` service handles deterministic assignment (SHA-256), config parsing, tier overrides
- `GET /billing/experiment-variant` — variant lookup for any company member
- `GET /billing/experiment-results` — board-only results summary
- `POST /billing/create-checkout-session` includes variant in Stripe metadata
- Full test suite: 14 unit tests + 14 integration tests

---

## SEO Metadata Infrastructure (v0.4.1) — August 23, 2026

[Full release notes →](/support/releases/v0-4-1-seo-metadata)

### Highlights

- **Dynamic Sitemap at `/sitemap.xml`** — Paperclip now generates a live XML sitemap listing active companies and public issue pages, serving it with proper caching headers. Search engines discover your content automatically.
- **Custom Robots.txt** — `/robots.txt` tells crawlers to index public content while blocking `/api/` paths, keeping internal APIs out of search results.
|- **Per-Page Titles and Meta Descriptions** — Every page now has a descriptive browser tab title (e.g., "Dashboard — Paperclip", "Agent Detail — Paperclip") and key pages include search-result summaries via `<meta name="description">`.
|- **Open Graph / Twitter Card Tags** — Every page with a title and description now automatically generates social media preview tags. Links shared on Slack, Twitter/X, LinkedIn, and Discord show a rich card with the page title, description, and optional image.
|- **No Configuration Required** — SEO improvements and social previews are automatic and server-side. Companies hosting on Paperclip get search-engine-friendly pages without any setup.
|- **Graceful Degradation** — If the database is temporarily unavailable, the sitemap returns an empty listing (HTTP 200) instead of an error, preventing crawler retry storms. Base social media tags in `index.html` provide fallback previews before React components render.

[Full release notes →](/support/releases/v0-4-1-seo-metadata)

---

## Feature Gating / Paywall — August 22, 2026

[Full release notes →](/support/releases/voy-1609-feature-gating)

### Highlights

- **Subscription Feature Gating** — Added `requireFeature` Express middleware that gates operations behind subscription tier features. Routes check `checkFeatureAccess` before proceeding; denied requests return `403 PAYWALL` with a descriptive message.
- **Four Gated Operations** — API key creation (`api_access`), advanced agent creation (`advanced_agents`), member invites past seat limit (`unlimited_seats`), and marketplace plugin installation (`custom_plugins` — free feature).
- **Ten Feature Keys** — The feature catalog includes `custom_plugins`, `advanced_agents`, `audit_logs`, `api_access`, `priority_support`, `extended_storage`, `sso`, `custom_roles`, `advanced_reporting`, and `unlimited_seats`.
- **Degradation Handling** — When a subscription cancels at period end, paid features are denied once the paid period elapses — even if Stripe still reports the subscription as active.
- **Free Feature Passthrough** — Features in the `FREE_FEATURES` set bypass all checks, ensuring core functionality is always available.

[Full release notes →](/support/releases/voy-1609-feature-gating)

---

## P1-2 TOCTOU Billing Fix — August 22, 2026

[Full release notes →](/support/releases/voy-1669-toctou-billing-fix)

### Highlights

- **TOCTOU Race Fix in Subscription Creation** — Two concurrent subscription creation requests can no longer produce duplicate subscriptions. The INSERT now uses `ON CONFLICT` — if the race is lost, the orphan Stripe subscription is cancelled and the winner's record is returned. No more double-billing risk from rapid button clicks or race conditions.
- **Usage Report Race Fix** — Concurrent usage reports for the same metric and billing period are now handled safely via `INSERT ... ON CONFLICT DO UPDATE` (upsert). No more duplicate usage records.
- **Seven More Stripe Calls Gain Retry** — `subscriptions.retrieve()`, `subscriptions.update()`, `subscriptions.create()`, `subscriptionItems.createUsageRecord()`, and `invoices.list()` are now wrapped in `withStripeRetry` for automatic exponential-backoff retry on transient Stripe failures. All 10 Stripe API call sites in the billing service are now protected.
- **Zero Downtime/API Impact** — No endpoint changes, no request/response changes, no new environment variables, no configuration changes. All fixes are server-side.

[Full release notes →](/support/releases/voy-1669-toctou-billing-fix)

---

## Post-v0.5.0 Incremental — August 21, 2026

[Full release notes →](/support/releases/prx-46-heartbeat-failure-webhook)

### Highlights

- **Heartbeat Failure Webhook** — Server operators can now configure a webhook URL (`PAPERCLIP_HEARTBEAT_FAILURE_WEBHOOK_URL`) to receive real-time JSON POST notifications when a heartbeat run reaches a terminal failure status. Four failure paths covered: process lost, agent not found, adapter failure, and setup failure. Fire-and-forget delivery — never breaks the triggering operation. Webhook status is shown in the server startup banner.

---

## v0.5.0 Market Readiness Release — August 20, 2026

[Full release notes →](/support/releases/v0.5.0-market-readiness)

### Highlights

- **Self-Service Onboarding** — New users can sign up with email/password and create a company in minutes via the onboarding wizard. `POST /api/start` creates a company, CEO agent, goal, project, and starter task in one request. Twelve role packs with tailored skills and knowledge assets.

- **Stripe Billing Integration** — Full Stripe subscription management: tier plans, create/update/cancel/reactivate subscriptions, usage reporting (seats, agent runs, storage), invoice sync, and Stripe webhooks. Billing mutations are board-user-only — agents are blocked with 403.

- **Multi-Channel Notifications** — Five notification types delivered via in-app panel, SMTP email, or web push (VAPID). Per-type preferences with instant/daily/weekly digest options. Delivery telemetry with per-channel status tracking. Fire-and-forget dispatch — failures never break the triggering operation.

- **Agent Marketplace** — Browse pre-built agents and hire them with one click. Each agent ships with curated skills, default adapter config, and permissions. Hires are gated behind `agents:create` permission and board-approval policy.

- **Company Templates (Production-Stable)** — Four pre-built templates (Travel Concierge, Support Ops, Engineering Team, CPA Firm) with atomic all-or-nothing deployment. Already graduated from alpha in Phase 1 with this release adding documentation and polish.

- **Knowledge Starter Packs** — Pre-curated knowledge document bundles (Engineering, Travel Industry) that install directly into a company's knowledge base. Title-based deduplication, operator-extensible via JSON data files.

- **Multi-User Invites** — Company invites with viewer/operator/admin roles, structured join-request flow, and a dedicated invite landing page.

- **Documentation Expansion** — New setup guides for billing, notifications, marketplace, templates, and knowledge packs. Full FAQ. Updated quickstart covering the entire v0.5.0 feature surface. All new API reference docs for onboarding, billing, notifications, marketplace, company templates, and knowledge starter packs.

[Full release notes →](/support/releases/v0.5.0-market-readiness)

---

## Async UX Release — August 20, 2026

[Full release notes →](/support/releases/voy-1474-async-ux)

### Highlights

- **Background Jobs Framework** — Long-running operations (activity search, auto-assessment, PDF/ICS export, semantic search) now run as background jobs. Clients receive a job ID immediately and track progress via polling or Server-Sent Events (SSE). No more UI blocking on slow backend processes.

- **Process Visibility** — A consolidated **BackgroundProcessTray** in the sidebar shows all background work across a company with live progress bars. Research items gain **FreshnessCue** indicators (green = fresh, amber = stale, grey = unknown) so you can see at a glance how current your data is.

- **Faster Search** — `/research/search` returns keyword-first results instantly and optionally upgrades them with semantic ranking asynchronously via SSE. The keyword results are available immediately; semantic enhancement arrives when ready.

- **PDF & iCalendar Exports** — Generate PDF documents and iCalendar (.ics) files as background jobs. Requests return immediately with a job ID; the rendered output is available from the job result. Payloads over 512 KB are rejected with a clear error message.

- **Non-Blocking Page Loading** — Trip pages now use skeleton loading (`SkeletonBone` / `SkeletonText` + `FadeIn` wrapper) so the page renders instantly and content fades in as data arrives.

- **Reliability Hardening** — Job claims are transaction-atomic (`FOR UPDATE SKIP LOCKED` inside a `db.transaction()`), processors have a configurable 5-minute timeout, transient failures retry with exponential backoff, and the SSE endpoint now enforces `company_scope:read` authorization.

[Full release notes →](/support/releases/voy-1474-async-ux)

---

## M-Series Technical Debt Release — August 19, 2026

[Full release notes →](/support/releases/voy-1460-m-series-tech-debt)

### Highlights

- **Atomic Company Template Deployment** — Deploying a pre-built company template is now all-or-nothing. If any critical step fails (skill install, agent creation, knowledge pack, goal, project, or starter issue), the entire deployment rolls back cleanly — no partially-created company to clean up.

- **Configurable Timeouts** — 50+ previously hardcoded timeout, TTL, and interval values across the server are now configurable via `PAPERCLIP_*` environment variables. Defaults are unchanged, so existing deployments behave identically out of the box, but operators can now tune performance and reliability characteristics per their infrastructure.

- **Server Reliability Fixes** — Notification and board-chat fixes from the recent merge, plus cleanup of dead code and unused imports (M-series audit findings). The HTTP headers timeout is now automatically derived from the keep-alive timeout, preventing misconfiguration that could crash the server.

- **Database Client Hardening** — Prepared statement caching disabled in the Postgres client to prevent connection-pooling issues during migrations.

[Full release notes →](/support/releases/voy-1460-m-series-tech-debt)

---

## Documentation Site v1 — August 19, 2026

[Full release notes →](/support/releases/docs-site-case-studies-and-community)

### Highlights

- **Four Published Case Studies** — Real stories of AI agents in production: Voyonder's customer-zero dogfooding story, how AI agents built Paperclip, the autonomous agent economy, and Trail Life Troop WA-0337 using AI for volunteer organization management.

- **Discord Community Launch** — Community Discord link now live in the documentation site navigation. Server structure, roles, and moderation guidelines are ready for the early-adopter community.

- **Outreach Materials Published** — Beta customer outreach assets, demo scripts, case study variants, and community launch posts are drafted and ready for the launch sequence.

- **Documentation Expansion** — Case Studies navigation tab with 4 in-depth articles and a curated index. Knowledge Starter Packs support assessment completed. All v0.5.0 features now have full support case coverage (7 assessments).

[Full release notes →](/support/releases/docs-site-case-studies-and-community)

---

## v0.5.0 Phase 1 — August 18, 2026

[Full release notes →](/support/releases/v0.5.0-phase-1)

### Highlights

- **Security Hardening (VOY-1367)** — Three review-blocker fixes landed: billing routes now require board-user context (agents blocked), memory HNSW vector indexes restored after migration 0137 dropped them, and execution-error notifications are now idempotent via database-backed dedup. Marketplace hire routes gained the `agents:create` permission gate and board-approval check.

- **Marketplace Agent Hiring** — Hire pre-built agents from the Paperclip Marketplace with one API call. Gated behind standard `agents:create` permissions and company board-approval policy. No more manual agent configuration for common roles.

- **Onboarding Role Packs** — New onboarding asset packs for eleven organizational roles (Troop Master, Trail Master, Treasurer, Chaplain, Ranger, and more), each with tailored skills, knowledge packs, and a starter issue.

- **Company Templates (Production-Stable)** — One-click company deployment graduated from alpha. Travel Concierge, Support Ops, Engineering Team, and CPA Firm templates are ready for production use.

- **Documentation Expansion** — Full API reference docs for billing, chat, company templates, marketplace, notifications, and onboarding. Six new support case assessments cover the entire feature surface.

[Full release notes →](/support/releases/v0.5.0-phase-1)

---

## v0.4.0-alpha (RC-4) — August 17, 2026

[Full release notes →](/support/releases/v0.4.0-alpha-deep-planning)

### Highlights

- **Deep Planning (Workstream A)** — Structured plan documents with sections, milestones, revision history, and approval gates. Plans are now revisioned, gate-approved, and decomposable into child issues. Replaces ad-hoc plan descriptions.

- **Plan Review Gates** — Approval gates on plan revisions with per-milestone acceptance criteria. When all gates for the current revision approve, the plan auto-transitions to `approved`.

- **Approved Plan Decomposition** — Approved plans can be decomposed into child issues after a board user accepts the plan confirmation, creating a direct link from the approved plan to executable work items. Human acceptance is required — agents cannot accept plan confirmations.

- **Agent Memory (pgvector)** — A durable, queryable agent memory system. Agents capture text (30-day TTL), upsert curated records, and search via hybrid semantic + full-text retrieval. Memory is scoped per-agent with shared company-wide records.

- **Knowledge Documents** — A full knowledge base with lifecycle management (draft → review → published → archived), revision history, diff, backlinks to issues, and full-text search.

- **Knowledge Browser UI** — A new Knowledge Base page at `/knowledge` for searching, browsing, reviewing, diffing revisions, and creating knowledge documents — no API needed. Also fixes a critical bug where the knowledge search endpoint was unreachable.

- **Chat-to-Work Resolution Cards** — In the Conference Room chat, the board assistant's created/updated work objects (issues, plans, approvals, memory records, knowledge articles) now appear as clickable resolution cards with type badges and direct links, instead of only conversational mentions.

- **Manager-Chain Issue Permissions** — Managers can now comment on and mutate issues assigned to agents in their reporting subtree, so leadership can close, reassign, and unblock their team's work.

- **C-Fixes** — Zod validation of LLM action signals (C-1), a TOCTOU safety net preventing duplicate SLA alerts (C-2), and special-character-safe knowledge search via `plainto_tsquery` (C-3).

- **Memory Extraction Jobs** — New API and UI for monitoring background memory extraction jobs, with one-click retry of failed jobs.

- **Batch Gate Counts + Live Events** — Plan cards now show active gate counts, and plan gate creation/resolution events stream to the UI in real time.

- **Billing System** — Full Stripe-integrated subscription management: tier plans, usage reporting (seats, agent runs, storage), invoice syncing, and Stripe webhooks. Subscription mutations require a board-user context; agents are blocked from billing changes.

- **Multi-Channel Notifications** — Board users receive notifications for reviews requested, approvals needed, completed work, budget thresholds, and execution errors — delivered in-app, by email, or via web push with instant/daily/weekly digest options.

- **Company Templates** — One-click deployment of pre-built companies (Travel Concierge, Support Ops, Engineering Team, CPA Firm), each with agents, skills, knowledge packs, and a starter issue.

- **Board Chat & Template APIs** — New API reference coverage for the Conference Room chat streaming endpoint and the company templates gallery/deploy endpoints.

[Full release notes →](/support/releases/v0.4.0-alpha-deep-planning)

---

## v2026.722.0 — July 22, 2026

[Full release notes →](/releases/v2026.722.0)

### Highlights

- **Run-bound agent secret access** — Agents can now fetch secrets they've been granted on demand through a run-bound API, instead of relying only on ambient environment injection. A new `access.*` delivery mode exposes API-only secrets, and a new Secret Access editor lets you manage per-agent grants from agent settings.
- **Local agents on Windows** — The embedded ACPX engine no longer wraps local agent commands in a generated Bash script, so Claude, Codex, Gemini, and custom ACP adapters now spawn natively on Windows as well as Linux.
- **Connections v3 foundation (experimental)** — The groundwork for one-click Connected Apps lands: a v3 schema, AppDefinition catalog, and runtime authorization layer, gated behind the Apps experimental setting.

[Full release notes →](/releases/v2026.722.0)

---

## v2026.720.0 — July 20, 2026

[Full release notes →](/releases/v2026.720.0)

### Highlights

- **Skill Studio & skill organization** — A three-pane skill IDE with sandboxed test runs for authoring and editing skills without leaving Paperclip. Skills organize into nested folders, with import from projects, open-by-default company policy, and fork prechecks.
- **Attention queue & Decisions** — A new attention queue and Decisions surface brings everything that needs your input into one place, with faster scrolling and mobile-friendly decision rows.
- **Better search** — Search gains filters, sorting, and operators with command-palette parity, plus a new bulk extract endpoint.
- **Tougher, self-healing runs** — Run restart recovery, workspace self-heal, quota-aware retries, and failed-run metrics mean your instance tries harder before it involves you. Recovery is routed by failure cause, waits for provider quota resets, and throttles serial repeats.

[Full release notes →](/releases/v2026.720.0)

---

## v2026.707.0 — July 7, 2026

[Full release notes →](/releases/v2026.707.0)

### Highlights

- **User-specific runtime secrets** — Secrets can now be scoped to the individual human operator, not just the company. Paperclip deterministically checks that the human behind a run has actually supplied the value a run needs before it dispatches.
- **Work Timeline** — A new company-scoped Work Timeline page renders a compact, Gantt-style SVG view of when your agents worked, how handoffs happened, and where work overlapped.
- **Custom sandbox images with built-in SSH terminal** — Build reusable custom sandbox images with an embedded SSH terminal directly from the environment configuration flow.
- **Redesigned environment variables editor** — A single reusable editor replaces the legacy env-var editor, used consistently across agents, projects, routines, and company environments.
- **One-click recovery for diverged work** — The recovery card diagnoses when a task's branch has diverged from its base and offers a one-click isolated re-issue.
- **Starred resources in the sidebar** — Pin the projects, agents, and tasks you use most to a dedicated starred section in the sidebar.

[Full release notes →](/releases/v2026.707.0)

---

## v2026.626.0 — June 26, 2026

[Full release notes →](/releases/v2026.626.0)

### Highlights

- **Hermes, now built in (local & remote gateway)** — Hermes is a first-class adapter. Hire `hermes_local` agents that run on your own machine, or `hermes_gateway` agents that run Hermes remotely through a gateway, with secure onboarding defaults.
- **Task watchdogs** — A first-class watchdog control plane lets you attach automated checks to a task and have Paperclip watch it for you, surfacing watchdog state and outcomes right in the issue thread.
- **Ask work mode** — Issues can now run in an "ask" work mode for question-and-answer tasks, so you can point an agent at a question and get an answer back without full execution workflow.
- **Sandbox runtime status, live in your threads** — Ephemeral sandbox runtimes now report their status directly in issue threads, and Daytona sandbox leases are reused across runs.
- **Workspace file downloads & external object references** — Download files your agents produced straight from the workspace, and reference external objects across issue surfaces.

[Full release notes →](/releases/v2026.626.0)

---

## v2026.618.0 — June 18, 2026

[Full release notes →](/releases/v2026.618.0)

### Highlights

- **Skills Store** — Browse, install, and manage agent skills from a dedicated in-app store. Skills are now a first-class, installable unit with install counts and a company-scoped catalog.
- **Self-hostable sandbox execution** — A self-hostable Kubernetes sandbox provider plugin lands alongside server-side K8s execution integration and hardened agent-runtime images. Run your agents in an isolated sandbox on your own infrastructure.
- **Per-company multi-tenant isolation** — Each company now gets its own JWT signing keys, cloud tenants are strictly company-scoped, and plugin data is isolated per tenant.
- **Workspace file viewer and artifact links** — Inspect files your agents produced directly from the issue with a built-in workspace file viewer plus artifact links.
- **Env-driven gateway routing for local adapters** — Codex, Pi, OpenCode, and Gemini local adapters can now route through custom providers and gateways via environment configuration.

[Full release notes →](/releases/v2026.618.0)

---

## v2026.609.0 — June 9, 2026

[Full release notes →](/releases/v2026.609.0)

### Highlights

- **Company Artifacts** — Files, media, and documents your agents produce are now first-class. A new company-scoped Artifacts page indexes every work product across issues and runs.
- **Collapsible sidebar rail and takeover panes** — The primary navigation can now collapse to a persisted rail with hover/focus peek, giving contextual pages far more horizontal room.
- **Rich issue attachments with video** — Issues now accept video attachments and render rich inline previews, including standalone PWA browser controls.
- **Checkbox confirmation interactions** — Issue-thread interactions can now ask the board or user to confirm options via a structured checkbox payload.
- **Information Architecture refresh (experimental)** — An opt-in visual refresh of the project and agent surfaces makes high-frequency workflows easier to scan.
- **Automated PR quality and security gates** — `commitperclip` now runs automated quality and security gates on incoming PRs.

[Full release notes →](/releases/v2026.609.0)

---

## v2026.529.0 — May 29, 2026

[Full release notes →](/releases/v2026.529.0)

### Highlights

- **Inline document annotations and comments** — Issue documents now support inline, revision-aware annotation threads with comments and stable anchor snapshots.
- **Company skills CLI and catalog management** — Skills are now first-class: install, reset, audit, export, and assign company skills with a new CLI and board UI.
- **Hide projects and agents from your sidebar** — User-scoped resource membership lets each user leave projects and agents they don't want cluttering their sidebar.
- **First-admin claim flow for fresh self-hosted deployments** — Private, unclaimed deployments now get a one-time browser claim so operators can create the first admin before any invite exists.
- **Live Claude model discovery** — The Claude Local adapter can refresh its Anthropic model catalog from the UI, so newly released Claude models show up without waiting for a code release.

[Full release notes →](/releases/v2026.529.0)

---

## v2026.525.0 — May 25, 2026

[Full release notes →](/releases/v2026.525.0)

### Highlights

- **Modal sandbox provider is now a first-party plugin** — Paperclip ships a Modal sandbox-provider plugin alongside E2B, Cloudflare, and Daytona.
- **Workspace diffs are a first-class viewer plugin** — The new workspace diff plugin renders staged, unstaged, head, renamed, binary, oversized, and untracked changes.
- **Routines can carry their own secrets** — Routine env now flows through the runtime contract with persisted revisions and `agent < project < routine` precedence.
- **Local Cloud Upstream sync** — A new Cloud Upstream flow with shared types, server routes, persisted run schema, CLI sync helpers, and board UI.
- **ACPX-Claude adapter works seamlessly out of the box** — The `acpx_local` adapter now resolves bare Claude model IDs and surfaces real diagnostic detail.

[Full release notes →](/releases/v2026.525.0)

---

## Earlier Releases

Release notes for earlier versions are available in the [releases directory](/releases/).