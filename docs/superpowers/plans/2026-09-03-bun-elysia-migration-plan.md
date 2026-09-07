# Bun + Elysia Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Do not start implementation from this plan until the official documentation and repository inventory have been reviewed.

**Goal:** Migrate Paperclip's HTTP/runtime boundary from Node.js + Express to Bun + Elysia without changing domain behavior, authorization, persistence, operational semantics, or API contracts.

**Architecture:** Brownfield migration with a compatibility boundary. The existing Express application remains the behavioral oracle while Elysia plugins are introduced behind feature/configuration gates. Each migrated route group must prove contract parity before cutover. Domain services, Drizzle schema/migrations, PostgreSQL, and React/Vite remain unchanged unless an isolated compatibility probe proves adaptation is required.

**Tech Stack:** Bun version selected only after official Bun documentation and runtime probes; Elysia version selected only from official release/documentation evidence; existing Drizzle/PostgreSQL, Better Auth, React 19, Vite, OpenTelemetry, Sentry, plugins, and native dependencies validated individually.

**Spec:** `docs/superpowers/plans/2026-09-04-bun-elysia-migration-inventory.md`, `AGENTS.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, `doc/DATABASE.md`.

## Global Constraints

- Preserve all 67 route paths, methods, status codes, response shapes, error codes, auth rules, activity records, side effects, and operational behavior.
- Port actor/auth context before authenticated route handlers.
- Preserve company isolation and responsible-user intersection checks.
- Preserve database migration/startup, plugin lifecycle, scheduler, WebSocket, readiness, hot restart, graceful shutdown, backup/restore, and observability behavior.
- Keep the Express implementation and pnpm/Node rollback path until repository-wide parity and release gates pass.
- Do not replace working domain services or DB schema as part of a framework migration.
- Do not upgrade every dependency to “latest” blindly; record official version evidence, compatibility, licensing, and regression results per dependency.
- Do not introduce Astro into the existing React/Vite SPA without a separately approved SSR/SSG requirement.
- Do not delete a file or dependency until repository-wide reference search, tests, docs, CI, packaging, and rollback checks prove it is dead.
- No placeholder handlers, omitted authorization, omitted activity logging, fake persistence, or unverified success claims.

## Official documentation work

Before each implementation task, read the relevant official documentation and record:

- source URL;
- version/date consulted;
- API used;
- compatibility result under Bun;
- known gaps or unresolved questions.

Minimum sources:

- Bun runtime and package manager: `https://bun.com/docs`
- Elysia: `https://elysiajs.com/table-of-content.html`
- Elysia OpenAPI plugin: official Elysia OpenAPI repository/docs
- Drizzle ORM PostgreSQL: official Drizzle documentation
- Better Auth: official Better Auth documentation
- Vite: `https://vite.dev/guide/`
- Astro setup: `https://docs.astro.build/es/install-and-setup/`

If a documentation MCP/source is unavailable, mark the task blocked; do not infer unsupported API behavior from memory.

## Phase 0 — Inventory and baseline

### Task 0.1 — Baseline the current implementation

**Files:**

- Read: `server/src/app.ts`, `server/src/index.ts`, `server/src/middleware/auth.ts`, `server/src/middleware/*.ts`
- Read: `server/src/routes/*.ts`, `server/src/realtime/*.ts`, `server/src/services/*.ts`
- Read: `packages/db/src/client.ts`, `packages/db/src/schema/*.ts`, migrations
- Read: `ui/package.json`, `ui/src/main.tsx`, `ui/src/api/client.ts`, `cli/package.json`, `Dockerfile`, `.github/workflows/*`

**Verification:**

```sh
find server/src/routes -maxdepth 1 -name '*.ts' | wc -l
find server/src/services -maxdepth 1 -name '*.ts' | wc -l
find packages/db/src/schema -maxdepth 1 -name '*.ts' | wc -l
find ui/src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l
find .github/workflows -type f | wc -l
```

Record baseline test/build/typecheck commands and their output before changing runtime behavior.

### Task 0.2 — Runtime compatibility probes

Create disposable probes outside production source for:

- `Bun.serve` request/response behavior;
- Elysia `app.handle(new Request(...))` behavior;
- Elysia plugin composition and context derivation;
- request body/query/params/cookie/header parsing;
- `Bun.spawn` exit/signal/stdout/stderr/timeout behavior;
- native WebSocket upgrade/auth/close behavior;
- `Bun.file` and static response behavior;
- `embedded-postgres` initialization/start/stop/query;
- Drizzle's exact PostgreSQL driver;
- Better Auth's exact request/response bridge;
- OpenTelemetry/Sentry startup and shutdown;
- native modules (`acpx`, `sharp`, `ssh2`) used by production paths.

Every probe must be isolated, reproducible, and removed or stored as a documented compatibility test.

## Phase 1 — Elysia foundation without behavior loss

### Task 1.1 — Define typed Elysia application context

**Files:**

- Create: `server/src/elysia/context.ts`
- Create: `server/src/elysia/actor-context.ts`
- Test: `server/src/elysia/context.test.ts`
- Test: `server/src/elysia/actor-context.test.ts`

Port the actor model from `server/src/middleware/auth.ts` into a typed Elysia context. The context must represent `none`, board/session/local-implicit/cloud actors, board API keys, agent API keys, and signed agent JWTs. It must preserve run id binding, responsible user memberships, key scopes, instance roles, and company ids.

Use Elysia's documented `derive`/`resolve`/lifecycle mechanism selected by the compatibility probe. Do not use the generic Elysia JWT plugin as a replacement for Better Auth or Paperclip's agent-key verification.

**Acceptance:** all existing auth middleware tests have equivalent cases for unauthenticated, board, agent-key, agent-JWT, cloud, mismatched run, terminated/pending agents, responsible-user denial, and cross-company denial.

### Task 1.2 — Port cross-cutting middleware

**Files:**

- Create/modify: `server/src/elysia/middleware/*.ts`
- Tests: one parity suite per middleware

Port, in order:

1. request/auth actor resolution;
2. private-hostname and trust-proxy policy;
3. board mutation/origin/CSRF guard;
4. body limits and multipart parsing;
5. compression/cache/ETag behavior;
6. error mapping/redaction;
7. cloud identity;
8. request logging/correlation ids.

Each middleware must preserve execution order and error/status shapes. Route handlers cannot be migrated until this task passes.

### Task 1.3 — Build the Elysia shell

**Files:**

- Create: `server/src/elysia/app.ts`
- Create: `server/src/elysia/server.ts`
- Tests: `server/src/elysia/app.test.ts`, `server/src/elysia/server.test.ts`

The shell owns Elysia/Bun HTTP serving only. Existing startup services remain behind explicit interfaces. Do not duplicate DB initialization, scheduler startup, plugin loading, or shutdown logic. The shell must expose a testable `app.handle()` and a production `Bun.serve` boundary with readiness and shutdown hooks.

OpenAPI must be generated using the current official Elysia OpenAPI plugin and schemas that accurately describe the existing API. Do not invent route paths or response schemas.

## Phase 2 — Route-group migration

Each route task must:

1. read the complete existing Express route;
2. map every handler/middleware/service side effect;
3. create a failing parity test;
4. implement the Elysia plugin with typed params/query/body/headers and response/error mapping;
5. run the parity test against both Express and Elysia implementations where possible;
6. run the existing regression suite;
7. pass independent critic review;
8. enter `in_review` before any deletion or cutover.

Migration groups:

1. health/OpenAPI/read-only catalogs;
2. companies/projects/goals/folders;
3. agents/access/authz;
4. issues/comments/blockers/documents/work products;
5. costs/budgets/activity/dashboard/attention;
6. approvals/governed actions;
7. secrets/assets;
8. environments/execution workspaces;
9. routines/pipelines/heartbeat wakeups;
10. plugins/tool gateway/connection intents;
11. auth/cloud/onboarding/import/export/specialized routes.

No group may remove the Express version until all routes in that group pass parity, security, integration, and end-to-end tests.

## Phase 3 — Runtime/process/transport adaptations

### Task 3.1 — Process and native runtime boundary

Adapt only the call sites that require Bun APIs. Preserve process groups, cancellation, signal escalation, exit codes, timeout behavior, logs, orphan cleanup, path containment, and restart semantics. Target likely files include plugin workers, agent adapters, workspace runtime services, embedded PostgreSQL supervision, CLI runners, and release/dev scripts.

### Task 3.2 — WebSocket boundary

Port each realtime server independently. Preserve authentication, company/run scope, upgrade denial, reconnect semantics, event ordering, backpressure, close behavior, and graceful shutdown. Keep the `ws` implementation until all three server paths have equivalent tests.

### Task 3.3 — Better Auth boundary

Implement and test the documented Better Auth request/response bridge for Elysia. Preserve cookies, trusted origins, session lookup, exchange routes, handoff tickets, instance-scoped cookie names, and redaction. A generic JWT plugin is not an acceptable substitute.

### Task 3.4 — Startup/shutdown integration

Split `server/src/index.ts` into testable lifecycle services without changing ordering. Prove DB migration, embedded PG ownership, instrumentation readiness, plugin startup, heartbeat recovery, readiness, backups, hot-restart adoption, scheduler drain, WebSocket close, and process shutdown.

## Phase 4 — Tooling and frontend

### Task 4.1 — Bun package manager migration

Run `bun install` in an isolated worktree. Compare dependency graph, patches, workspace links, optional peers, native packages, and lockfile behavior. Update manifests only after the comparison is reviewed. Keep pnpm lock/scripts for rollback until cutover.

### Task 4.2 — Test runner migration

Migrate tests only after proving `bun:test` equivalents for mocks, fake timers, module isolation, serial workers, embedded DB setup/teardown, Supertest replacement, and Playwright integration. Keep Vitest regression coverage during the transition.

### Task 4.3 — Vite + React validation

Keep `ui/` on Vite + React. Validate Bun execution of Vite dev/build/typecheck and preserve same-origin API/WebSocket behavior, service worker updates, Storybook, Playwright, and static asset packaging. Astro remains excluded unless a separate SSR/SSG requirement is approved.

### Task 4.4 — CLI/scripts/CI/Docker

Adapt `cli/`, `scripts/`, `.github/workflows/`, `Dockerfile`, release tooling, and docs only after runtime and test gates pass. Replace Node/pnpm commands with Bun equivalents one path at a time. Preserve shell portability, signing/release behavior, and rollback instructions.

## Phase 5 — Removal and final gates

A deletion candidate is eligible only when all are true:

- repository-wide production/test/reference search returns no required references;
- replacement has the same behavior and security properties;
- unit/integration/contract/E2E suites pass;
- security and red-team reviews pass;
- QA verifies critical flows;
- performance and reliability evidence is collected;
- docs/runbooks/CI/package/release paths are updated;
- rollback is documented and tested.

Potential deletions are reviewed individually, not as a single `rm` batch:

- Express and Express types;
- `server/src/app.ts` after route parity;
- old HTTP bootstrap after lifecycle parity;
- `multer`, `pino-http`, `supertest`, `tsx`, Vitest, `ws` only if truly unused;
- pnpm manifests/lockfile only after Bun CI/release cutover;
- obsolete compatibility files only after reference proof.

## Mandatory review pipeline

For every implementation group:

```text
Producer
  → Independent Critic
  → Code Review Team
  → QA Team
  → Security Review
  → Red Team
  → Performance/Reliability Review
  → GitHub/Release Specialist
  → Orchestrator disposition
```

The task is not complete until the evidence, findings, dispositions, and unresolved risks are recorded. No production-ready claim is allowed while any critical gate is missing or any required route remains unverified.
