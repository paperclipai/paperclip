# Paperclip System Architecture Guide

Version inspected: repository state on 2026-04-26

This document explains the current architecture of the Paperclip repository as it exists in code today. It is written for a developer who is new to the project and wants to understand how to run it, debug it, extend it, and design new features safely.

This guide is based on direct inspection of the repository, especially:

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `doc/DEVELOPING.md`
- `doc/DATABASE.md`
- `server/src/index.ts`
- `server/src/app.ts`
- `ui/src/main.tsx`
- `packages/db/src/client.ts`
- `packages/db/src/schema/*.ts`
- `server/src/routes/*.ts`
- `server/src/services/*.ts`

## How to read this guide

Each major section starts with:

- Simple explanation: what the thing means in plain words
- Technical explanation: how it is implemented in this repository

The goal is not just to describe folders. The goal is to explain how the system actually behaves.

## Unknown / Not Found

The repo instructions mention Graphify artifacts, but they were not present in usable form during inspection:

- `graphify-out/GRAPH_REPORT.md`: not found
- `graphify-out/wiki/index.md`: not found

So this guide is based on direct source inspection rather than the generated knowledge graph.

Other things that were not found as first-class subsystems:

- No dedicated queue infrastructure like BullMQ, RabbitMQ, SQS consumer workers, or Temporal
- No separate `controllers/` or `repositories/` folders; route handlers call services directly
- No Kubernetes manifests or Terraform in the inspected repo root
- No Apify integration exists yet in the current codebase

---

## 1. Project Overview

### Simple explanation

Paperclip is a control plane for AI-agent companies.

That means Paperclip is the software that helps a human board operator:

- create companies
- hire and organize AI agents
- assign work to those agents
- track what they are doing
- approve sensitive decisions
- monitor cost and budgets
- inspect output, logs, and progress

Paperclip is not mainly the place where AI work is executed. It is the place where AI work is governed, tracked, and coordinated.

### Technical explanation

The product intent is stated clearly in:

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`

The implementation follows that intent with a monorepo containing:

- an Express backend in `server/`
- a React frontend in `ui/`
- a shared PostgreSQL schema in `packages/db/`
- shared types, constants, and validators in `packages/shared/`
- adapter packages in `packages/adapters/` for agent runtimes
- a plugin platform in `packages/plugins/` and server plugin services

At runtime, Paperclip acts like a company orchestration system:

1. A human board uses the UI or API.
2. The backend reads and writes company-scoped data in PostgreSQL.
3. Services enforce company boundaries, budgets, approvals, and issue workflow rules.
4. Heartbeat execution services invoke adapters that run or wake agents.
5. Results are written back as runs, logs, comments, work products, cost events, and live events.
6. The UI updates via API polling and WebSocket live events.

### Main modules and responsibilities

| Module | Purpose |
|---|---|
| `server/` | API server, orchestration, auth, scheduling, plugins, live updates |
| `ui/` | Board UI for companies, agents, issues, budgets, approvals, plugins |
| `packages/db/` | Drizzle schema, migrations, DB client, embedded Postgres support |
| `packages/shared/` | Shared types, validators, constants, route contracts, telemetry types |
| `packages/adapters/` | Agent runtime adapters like Claude, Codex, Cursor, Gemini, OpenClaw, OpenCode, PI |
| `packages/adapter-utils/` | Shared utilities used by adapters and server adapter integration |
| `packages/plugins/` | Plugin SDK, plugin examples, plugin creation tooling |
| `cli/` | Paperclip CLI entry point and commands |
| `doc/` | Core project documentation and specs |
| `tests/` | Playwright end-to-end and release smoke tests |

### End-to-end workflow in simple words

1. Start Paperclip.
2. Paperclip boots its DB and HTTP server.
3. The UI loads from the same server.
4. The board creates a company and agents.
5. Work is represented mainly as projects, goals, issues, comments, approvals, and routines.
6. An agent heartbeat is triggered manually, by scheduler logic, or by a wakeup.
7. The backend chooses the adapter for that agent and invokes it.
8. Output is captured as run logs, comments, state changes, workspace operations, and costs.
9. The board sees updates on the dashboard, issue pages, org pages, and activity feeds.

---

## 2. Repository / Folder Structure

### Simple explanation

This is a pnpm monorepo. Different folders own different layers of the system, but they are designed to work together.

### Workspace definition

The workspace is defined in `pnpm-workspace.yaml`:

- `packages/*`
- `packages/adapters/*`
- `packages/plugins/*`
- `packages/plugins/examples/*`
- `server`
- `ui`
- `cli`

### Top-level structure

| Path | What it contains |
|---|---|
| `package.json` | Root scripts for dev, build, test, db migration, release |
| `pnpm-workspace.yaml` | Monorepo package layout |
| `tsconfig.base.json` / `tsconfig.json` | Shared TS configuration |
| `server/` | Express backend |
| `ui/` | React frontend |
| `packages/db/` | DB layer |
| `packages/shared/` | Shared contracts |
| `packages/adapters/` | Runtime adapter implementations |
| `packages/plugins/` | Plugin SDK and examples |
| `cli/` | CLI program |
| `docker/` | Compose files, Docker support, quadlet definitions |
| `.github/workflows/` | CI/CD pipelines |
| `doc/` | Primary product and engineering docs |
| `tests/` | Browser-based tests |
| `scripts/` | Release, build, smoke, migration, and maintenance scripts |

### Important entry points

| Entry point | Role |
|---|---|
| `server/src/index.ts` | Main server bootstrap |
| `server/src/app.ts` | Express app composition |
| `ui/src/main.tsx` | React app bootstrap |
| `ui/src/App.tsx` | Frontend route tree |
| `cli/src/index.ts` | CLI entry point |
| `packages/db/src/client.ts` | DB client creation and migration support |
| `packages/db/src/schema/index.ts` | Central export of DB tables |

### Root package scripts

`package.json` at repo root is the operational hub. Important scripts:

- `pnpm dev`
- `pnpm dev:once`
- `pnpm build`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm db:generate`
- `pnpm db:migrate`
- `pnpm paperclipai`
- `pnpm test:e2e`
- `pnpm test:release-smoke`

### Backend structure: `server/`

Important backend folders and files:

| Path | Responsibility |
|---|---|
| `server/src/index.ts` | Startup orchestration: config, DB, auth, server, scheduler, WS |
| `server/src/app.ts` | Middleware, routes, plugin runtime, UI serving |
| `server/src/routes/` | HTTP route definitions |
| `server/src/services/` | Business logic and orchestration |
| `server/src/middleware/` | Request middleware: auth, logging, validation, errors, host guard |
| `server/src/auth/` | Better Auth integration |
| `server/src/adapters/` | Server-side adapter registry and execution hooks |
| `server/src/storage/` | Asset storage abstraction and providers |
| `server/src/realtime/` | WebSocket live events server |
| `server/src/secrets/` | Secret provider registry and local encrypted provider |
| `server/src/errors.ts` | Custom HTTP error types |
| `server/src/config.ts` | Runtime configuration loading and normalization |
| `server/src/startup-banner.ts` | Startup UX/logging |
| `server/src/__tests__/` | Backend unit and integration tests |

#### Route layer

There is no separate controller folder. The route files act like controllers.

Examples:

- `server/src/routes/companies.ts`
- `server/src/routes/agents.ts`
- `server/src/routes/issues.ts`
- `server/src/routes/projects.ts`
- `server/src/routes/approvals.ts`
- `server/src/routes/plugins.ts`

These route files usually:

1. read params/body
2. validate body with Zod middleware
3. call a service
4. return JSON

#### Service layer

Most core business logic lives in `server/src/services/`.

Examples:

- `companies.ts`
- `agents.ts`
- `issues.ts`
- `heartbeat.ts`
- `approvals.ts`
- `budgets.ts`
- `costs.ts`
- `routines.ts`
- `execution-workspaces.ts`
- `plugin-loader.ts`

This is the real application core.

### Frontend structure: `ui/`

Important frontend folders:

| Path | Responsibility |
|---|---|
| `ui/src/main.tsx` | React mount + providers |
| `ui/src/App.tsx` | App route tree |
| `ui/src/pages/` | Page-level screens |
| `ui/src/components/` | Reusable UI components |
| `ui/src/api/` | API client wrappers for backend endpoints |
| `ui/src/context/` | Global state providers such as company and live updates |
| `ui/src/lib/` | Frontend domain utilities |
| `ui/src/plugins/` | UI plugin bridge and plugin launcher integration |
| `ui/public/` | Static assets and service worker |

Important page entry points:

- `ui/src/pages/Dashboard.tsx`
- `ui/src/pages/Companies.tsx`
- `ui/src/pages/Agents.tsx`
- `ui/src/pages/AgentDetail.tsx`
- `ui/src/pages/Projects.tsx`
- `ui/src/pages/ProjectDetail.tsx`
- `ui/src/pages/Issues.tsx`
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/pages/Approvals.tsx`
- `ui/src/pages/Costs.tsx`
- `ui/src/pages/PluginManager.tsx`
- `ui/src/pages/AdapterManager.tsx`

### Database package: `packages/db/`

Important files:

| Path | Responsibility |
|---|---|
| `packages/db/src/client.ts` | Create Drizzle client and migration helpers |
| `packages/db/src/runtime-config.ts` | Resolve DB target from env/config |
| `packages/db/src/schema/*.ts` | Individual table definitions |
| `packages/db/src/schema/index.ts` | Export all schemas |
| `packages/db/src/migrations/*.sql` | DB migrations |
| `packages/db/src/migrate.ts` | Migration runner |
| `packages/db/src/seed.ts` | Example seed script |
| `packages/db/src/backup-lib.ts` | Backup/restore utilities |

### Shared package: `packages/shared/`

This package prevents frontend and backend drift.

Important subareas:

| Path | Responsibility |
|---|---|
| `packages/shared/src/constants.ts` | Shared enums and string constants |
| `packages/shared/src/types/` | Shared DTOs and domain types |
| `packages/shared/src/validators/` | Shared Zod validators |
| `packages/shared/src/api.ts` | Shared API prefix constants |
| `packages/shared/src/telemetry/` | Telemetry event types/helpers |

### Adapter packages: `packages/adapters/`

Each adapter package follows a common structure and usually exports:

- root entry
- `server` integration
- `ui` integration
- `cli` helpers

Current adapter packages found:

- `packages/adapters/claude-local`
- `packages/adapters/codex-local`
- `packages/adapters/cursor-local`
- `packages/adapters/gemini-local`
- `packages/adapters/openclaw-gateway`
- `packages/adapters/opencode-local`
- `packages/adapters/pi-local`

These adapters let Paperclip work with different agent execution environments without hardcoding execution logic into the core service layer.

### Plugin packages: `packages/plugins/`

Important folders:

| Path | Responsibility |
|---|---|
| `packages/plugins/sdk/` | Public SDK for Paperclip plugins |
| `packages/plugins/create-paperclip-plugin/` | Scaffolding tool |
| `packages/plugins/examples/` | Example plugins |

This repo already has a substantial plugin runtime. It is not a future idea; it is part of the current architecture.

---

## 3. System Architecture

### Simple explanation

Paperclip is a full-stack application with four major runtime layers:

1. Board UI
2. API server
3. PostgreSQL database
4. Agent execution and extension runtime

The UI is for humans.
The backend is for orchestration.
The database stores company state.
Adapters and plugins let the system interact with agent runtimes and extension code.

### High-level architecture diagram

```mermaid
flowchart LR
  U[Board User Browser]
  UI[React UI\nui/src]
  API[Express API Server\nserver/src]
  DB[(PostgreSQL)]
  WS[Live Events WebSocket]
  ADP[Adapter Runtime Layer\npackages/adapters + server/src/adapters]
  AGENTS[Agent CLIs / external agents]
  PLUG[Plugin Runtime\nworker processes]
  STORAGE[Storage\nlocal_disk or S3]

  U --> UI
  UI -->|HTTP /api| API
  UI -->|WS /api/companies/:id/events/ws| WS
  WS --> API
  API --> DB
  API --> STORAGE
  API --> ADP
  ADP --> AGENTS
  API --> PLUG
  API --> UI
  API --> WS
```

### Layer-by-layer explanation

#### Frontend layer

The frontend is a React 19 + Vite application in `ui/`.

It is responsible for:

- navigation
- querying the backend
- rendering company/agent/project/issue views
- handling live event updates
- rendering plugin UI contributions
- managing company-scoped navigation and selection

#### Backend layer

The backend is an Express 5 application in `server/`.

It is responsible for:

- auth and actor identification
- company-scoped API access
- business rules
- scheduling
- heartbeat orchestration
- plugin process hosting
- asset upload and retrieval
- live event broadcasting
- DB access through Drizzle

#### Database layer

PostgreSQL is the system of record.

The repo supports:

- embedded Postgres for local/dev when `DATABASE_URL` is unset
- external Postgres via `DATABASE_URL`

Drizzle is used for:

- schema definitions
- type-safe queries
- migrations

#### Agent execution layer

Paperclip does not assume one agent runtime. Instead it uses adapters.

The heartbeat service in `server/src/services/heartbeat.ts` invokes server adapters registered through `server/src/adapters/`.

Execution can involve:

- local CLI tools like Codex or Claude Code
- external gateways like OpenClaw
- adapter-specific session handling
- run logs and usage collection

#### Plugin layer

Paperclip also has a plugin runtime:

- plugin discovery
- installation
- worker process startup
- plugin jobs
- plugin UI slots
- plugin tools and bridge actions

This is implemented mainly in:

- `server/src/services/plugin-loader.ts`
- `server/src/routes/plugins.ts`
- `server/src/routes/plugin-ui-static.ts`
- `ui/src/plugins/`
- `packages/plugins/sdk/`

### Request flow

### Simple explanation

When the UI makes a request:

1. Express receives it
2. middleware identifies the caller
3. middleware logs and validates the request
4. a route handler calls a service
5. the service talks to PostgreSQL
6. JSON comes back to the UI

### Technical request flow diagram

```mermaid
sequenceDiagram
  participant Browser
  participant UI as React UI
  participant App as Express App
  participant MW as Middleware
  participant Route as Route Handler
  participant Svc as Service
  participant DB as PostgreSQL

  Browser->>UI: Click or submit form
  UI->>App: fetch(/api/...)
  App->>MW: json parser, logger, host guard, actor auth
  MW->>Route: validated request
  Route->>Svc: call business method
  Svc->>DB: Drizzle query
  DB-->>Svc: rows/result
  Svc-->>Route: domain response
  Route-->>UI: JSON
  UI-->>Browser: render new state
```

### Heartbeat execution flow

```mermaid
sequenceDiagram
  participant Board as Board/UI/Scheduler
  participant API as API Server
  participant HB as Heartbeat Service
  participant ADP as Adapter
  participant CLI as Agent Runtime / CLI
  participant DB as PostgreSQL
  participant WS as Live Events

  Board->>API: invoke heartbeat or wake agent
  API->>HB: start run
  HB->>DB: create heartbeat_run
  HB->>ADP: execute agent via adapter
  ADP->>CLI: run command / call gateway
  CLI-->>ADP: output, usage, status
  ADP-->>HB: structured result
  HB->>DB: save run updates, comments, cost events
  HB->>WS: publish live event
  WS-->>Board: live update
```

---

## 4. Tech Stack

### Simple explanation

Paperclip uses a modern TypeScript full-stack setup:

- Node.js for the server
- Express for the API
- React for the UI
- PostgreSQL for data
- Drizzle for typed DB access
- Zod for validation
- Better Auth for authenticated mode
- Pino for logging
- Vitest and Playwright for testing

### Complete stack identified from the repo

| Category | Technology | Why it is used here |
|---|---|---|
| Runtime | Node.js 20+ | Server runtime, scripts, CLI |
| Package manager | pnpm 9 | Monorepo workspace management |
| Language | TypeScript | Shared typing across server, UI, and packages |
| Backend framework | Express 5 | REST API and middleware composition |
| Frontend framework | React 19 | Board UI |
| Frontend build tool | Vite 6 | Fast dev server and production builds |
| Data fetching | TanStack Query | Server-state caching and refetching |
| Routing | React Router-compatible layer in `ui/src/lib/router.tsx` | SPA routing |
| Database | PostgreSQL | Primary relational datastore |
| Local DB mode | embedded-postgres | Zero-config local development |
| ORM | Drizzle ORM | Typed schema and SQL querying |
| Validation | Zod | Request and data validation |
| Auth | Better Auth | Human authentication in authenticated mode |
| API auth | Bearer tokens, board API keys, agent API keys, local JWTs | Board and agent access paths |
| Logging | Pino + pino-http + pino-pretty | Structured server and HTTP logging |
| File upload | Multer | Assets and attachments |
| Image processing | Sharp | Likely asset/logo/image handling |
| Object storage | AWS SDK S3 client | S3-compatible storage provider |
| Live updates | WebSocket via `ws` | Company-scoped live events |
| JSON schema validation | AJV + ajv-formats | Plugin/config schema support |
| File watching | chokidar | Dev/plugin watchers |
| Testing | Vitest | Unit and integration tests |
| Browser testing | Playwright | E2E and release smoke tests |
| Styling | Tailwind CSS 4 | Frontend styling |
| UI primitives | Radix UI | Accessible UI building blocks |
| Drag and drop | dnd-kit | Interactive UI behavior |
| Markdown/editor | react-markdown, MDXEditor, Lexical | Rich text and docs/work product editing |
| Mermaid | mermaid | Rendering diagrams in UI/docs |

### Authentication choices

Paperclip has two main human auth modes:

- `local_trusted`
- `authenticated`

In `local_trusted`, the board is implicitly trusted.
In `authenticated`, Better Auth sessions are used and board membership/instance roles are checked.

Agent auth is separate:

- bearer agent API keys from `agent_api_keys`
- local JWTs for adapter-managed local runs

### Queue / worker / automation tools

There is no external queue system. Instead:

- the server process itself runs timer loops
- plugin workers are separate processes
- heartbeat logic is orchestrated in-process
- routine trigger scheduling is in-process

This matters for architecture decisions: Paperclip is currently a single-process control plane with helper worker processes, not a distributed multi-service queue architecture.

---

## 5. Application Flow

## 5.1 How the application starts

### Simple explanation

Startup does more than just open a port.

Paperclip:

1. loads config
2. resolves database mode
3. starts embedded Postgres if needed
4. runs migrations if needed
5. sets up auth
6. creates the Express app
7. starts WebSocket live events
8. starts scheduler loops
9. loads plugins

### Technical startup path

Main entry point: `server/src/index.ts`

Core startup responsibilities there:

- `loadConfig()`
- initialize telemetry
- resolve and boot database
- auto-apply migrations when needed
- ensure local trusted board principal in `local_trusted`
- initialize Better Auth in `authenticated`
- create the app through `createApp(...)`
- create HTTP server
- attach WebSocket server via `setupLiveEventsWebSocketServer(...)`
- recover runtime services
- recover heartbeat runs
- start scheduler intervals

### DB startup behavior

If `DATABASE_URL` is set:

- Paperclip uses external Postgres.

If `DATABASE_URL` is not set:

- Paperclip boots embedded Postgres in the instance directory.

This is implemented in `server/src/index.ts` using helpers from `@paperclipai/db`.

### Config loading flow

Config is loaded in `server/src/config.ts`.

It loads from:

1. Paperclip instance `.env`
2. current working directory `.env`
3. config file values
4. process environment overrides

Important config concerns handled there:

- deployment mode
- exposure mode
- bind host
- auth base URL
- DB mode
- storage provider
- secrets provider
- scheduler flags
- telemetry flags

## 5.2 Express app composition

Main file: `server/src/app.ts`

The app setup order is important:

1. `express.json(...)`
2. HTTP logger
3. private hostname guard
4. actor auth middleware
5. auth session endpoints
6. auth handler for Better Auth
7. LLM helper routes
8. `/api` router with board mutation guard and feature routes
9. plugin static UI routes
10. static built UI or Vite middleware
11. `errorHandler`

### Middleware flow

```mermaid
flowchart TD
  A[Incoming request]
  B[express.json]
  C[httpLogger]
  D[privateHostnameGuard]
  E[actorMiddleware]
  F[boardMutationGuard on /api]
  G[Route handler]
  H[Service]
  I[errorHandler]

  A --> B --> C --> D --> E --> F --> G --> H
  G --> I
  H --> I
```

### Example app bootstrap snippet

From `server/src/app.ts`:

```ts
app.use(express.json({ limit: "10mb" }));
app.use(httpLogger);
app.use(privateHostnameGuard(...));
app.use(actorMiddleware(db, ...));
app.use("/api", api);
app.use(errorHandler);
```

This shows the basic mental model: middleware first, routes second, centralized error handling last.

## 5.3 Routing flow

### Simple explanation

The backend uses route files as controller modules.

Each route file groups endpoints by domain.

### Important route groups

| Route file | Domain |
|---|---|
| `server/src/routes/health.ts` | health, bootstrap state |
| `server/src/routes/companies.ts` | company CRUD, import/export |
| `server/src/routes/agents.ts` | agents, heartbeats, keys, instructions, org |
| `server/src/routes/projects.ts` | projects and project workspaces |
| `server/src/routes/issues.ts` | issues, comments, documents, approvals, attachments |
| `server/src/routes/routines.ts` | automation routines and triggers |
| `server/src/routes/approvals.ts` | approval workflows |
| `server/src/routes/costs.ts` | costs, finance, budgets |
| `server/src/routes/activity.ts` | activity and run references |
| `server/src/routes/execution-workspaces.ts` | execution workspaces |
| `server/src/routes/plugins.ts` | plugin install, config, jobs, tools, bridge |
| `server/src/routes/adapters.ts` | adapter management |
| `server/src/routes/access.ts` | invites, board claim, CLI auth, memberships |
| `server/src/routes/secrets.ts` | company secrets |

## 5.4 Service/data-access flow

### Important architectural note

Paperclip does not use a separate repository layer.

Instead, the common pattern is:

`route -> service -> Drizzle query`

Example:

- `server/src/routes/issues.ts`
- `server/src/services/issues.ts`
- DB tables from `@paperclipai/db`

This keeps the code direct, but it means business rules and data access are often mixed inside service functions.

## 5.5 Error handling flow

Central handler: `server/src/middleware/error-handler.ts`

Handled cases:

- `HttpError` -> returns its explicit status
- `ZodError` -> returns `400 Validation error`
- unknown errors -> `500 Internal server error`

The handler also attaches extra error context to the response object so the logger can include:

- method
- URL
- body
- params
- query

### Example custom error type

From `server/src/errors.ts`:

```ts
export class HttpError extends Error {
  status: number;
  details?: unknown;
}
```

This is the main domain error mechanism in the server.

## 5.6 Logging flow

Logging is implemented in `server/src/middleware/logger.ts`.

Key facts:

- uses Pino
- console output is pretty-printed
- file output is written to a server log file
- authorization headers are redacted
- HTTP logs are added by `pino-http`

Logs include both:

- interactive human-readable console logs
- persistent file logs for debugging later

## 5.7 Live updates flow

Paperclip supports company-scoped live events using WebSockets.

Main files:

- `server/src/services/live-events.ts`
- `server/src/realtime/live-events-ws.ts`
- `ui/src/context/LiveUpdatesProvider.tsx`

The server:

- emits company live events in memory
- authorizes the socket connection
- pushes events to subscribed clients

The UI:

- opens a company-specific socket
- updates relevant query cache entries
- shows toasts for important events

This is useful for:

- heartbeat progress
- comment updates
- activity updates
- run changes

---

## 6. Database Architecture

## 6.1 Database type and connection model

### Simple explanation

Paperclip stores its application state in PostgreSQL.

In local development you usually do not need to install Postgres manually, because Paperclip can boot an embedded Postgres instance for you.

### Technical explanation

DB setup lives in:

- `packages/db/src/client.ts`
- `packages/db/src/runtime-config.ts`
- `server/src/index.ts`

DB client creation is very small:

```ts
export function createDb(url: string) {
  const sql = postgres(url);
  return drizzlePg(sql, { schema });
}
```

That is from `packages/db/src/client.ts`.

### Database concepts explained simply

#### Relational database

Simple: a database that stores data in tables with rows and columns.

Why Paperclip uses it: Paperclip has lots of structured relationships:

- a company has many agents
- an issue belongs to a company and maybe a project
- an approval can link to an issue
- a heartbeat run belongs to an agent and company

This kind of connected, structured data is a strong fit for PostgreSQL.

#### Transaction

Simple: a group of DB changes that should succeed together or fail together.

Why it matters here: approval flows, secret rotation, config revisions, and many workflow transitions need consistency.

#### Migration

Simple: a versioned change to the database structure.

Why it matters here: the schema evolves often, and Paperclip keeps those changes in `packages/db/src/migrations/`.

#### ORM

Simple: a library that lets code work with DB tables in a typed way instead of writing raw SQL everywhere.

Why it matters here: Drizzle gives type-safe schema access shared across backend and tooling.

#### Index

Simple: a helper structure that makes common lookups faster.

Why it matters here: Paperclip often queries by company, status, assignee, issue identifier, and search text.

### What kind of databases are used in this repo

Paperclip uses one database engine in normal application flow:

- PostgreSQL

But it supports multiple deployment styles of that same engine:

1. Embedded PostgreSQL
2. External PostgreSQL
3. Hosted PostgreSQL

This distinction is important:

- it is not using multiple different application databases like MongoDB + Redis + Postgres
- it is using one main database model, but with different hosting modes

### Database modes in Paperclip

#### 1. Embedded PostgreSQL

Simple: Paperclip starts a local Postgres instance for you.

Use case:

- solo development
- easiest local setup
- one-machine installs

Characteristics:

- stored under the Paperclip instance directory
- zero manual DB setup
- migrations can auto-apply on first boot

#### 2. External PostgreSQL

Simple: Paperclip connects to a Postgres server you manage.

Use case:

- local Docker Postgres
- staging/prod environments
- more control over DB ops

Characteristics:

- configured with `DATABASE_URL`
- useful for closer-to-production testing

#### 3. Hosted PostgreSQL

Simple: a cloud provider runs Postgres for you.

Use case:

- cloud deployment
- shared team environment
- backups and managed operations

Examples mentioned in repo docs:

- Supabase
- any Postgres-compatible hosted provider

### What Paperclip is not using as a core DB

During inspection, the current main application architecture did not show:

- MongoDB as primary store
- Redis as a required cache/queue store
- Elasticsearch/OpenSearch as a required search backend
- SQLite as the main app DB

So the mental model should be:

`Paperclip = PostgreSQL-centric control plane`

## 6.2 DB target resolution

`packages/db/src/runtime-config.ts` resolves the DB target from:

- `DATABASE_URL`
- Paperclip `.env`
- config file
- otherwise embedded Postgres defaults

Important default embedded DB location:

- `~/.paperclip/instances/default/db`

## 6.3 Schema organization

Schemas are defined one-table-per-file in `packages/db/src/schema/`.

Central export:

- `packages/db/src/schema/index.ts`

This makes the DB model discoverable and importable across the repo.

## 6.4 Important tables

The repo contains many tables. The most important operational ones are below.

### Company and access

| Table | Purpose |
|---|---|
| `companies` | Top-level tenant object |
| `company_memberships` | Which human principals belong to which companies |
| `instance_user_roles` | Instance-wide roles like instance admin |
| `board_api_keys` | Board bearer key auth |
| `invites` / `join_requests` | Human/company joining flows |

### Agents and execution

| Table | Purpose |
|---|---|
| `agents` | AI employees |
| `agent_api_keys` | Agent bearer keys |
| `agent_config_revisions` | Version history of agent config |
| `agent_runtime_state` | Runtime/session state |
| `agent_task_sessions` | Task session tracking |
| `agent_wakeup_requests` | Wakeup requests |
| `heartbeat_runs` | Each heartbeat execution |
| `heartbeat_run_events` | Event stream for heartbeat runs |

### Work management

| Table | Purpose |
|---|---|
| `goals` | Goal hierarchy |
| `projects` | Projects linked to goals |
| `issues` | Core task/work item entity |
| `issue_comments` | Conversation on issues |
| `issue_relations` | Dependencies / issue relationships |
| `labels` / `issue_labels` | Tagging |
| `issue_approvals` | Links between issues and approvals |
| `issue_read_states` | Read tracking |
| `issue_inbox_archives` | Inbox archive state |

### Work output

| Table | Purpose |
|---|---|
| `documents` | Stored document entities |
| `document_revisions` | Document history |
| `issue_documents` | Issue-linked docs |
| `issue_work_products` | Work artifacts linked to issues |
| `assets` | Stored uploaded assets |
| `issue_attachments` | Issue file attachments |

### Governance and budgets

| Table | Purpose |
|---|---|
| `approvals` | Approval requests |
| `approval_comments` | Approval discussion |
| `cost_events` | Usage cost tracking |
| `finance_events` | Wider finance records |
| `budget_policies` | Budget rules |
| `budget_incidents` | Violations/incidents |
| `activity_log` | Auditable mutations |

### Automation and runtime

| Table | Purpose |
|---|---|
| `routines` | Reusable automation definitions |
| `routine_triggers` | Cron/webhook/public trigger config |
| `routine_runs` | Routine execution history |
| `project_workspaces` | Project-scoped workspaces |
| `execution_workspaces` | Execution workspace records |
| `workspace_operations` | Workspace operation history |
| `workspace_runtime_services` | Runtime process/service persistence |

### Plugin subsystem

| Table | Purpose |
|---|---|
| `plugins` | Installed plugin records |
| `plugin_config` | Plugin config values |
| `plugin_company_settings` | Company-specific plugin settings |
| `plugin_state` | Persisted plugin state |
| `plugin_entities` | Plugin-created entities |
| `plugin_jobs` / `plugin_job_runs` | Plugin background jobs |
| `plugin_webhooks` | Plugin webhook delivery state |
| `plugin_logs` | Plugin log records |

## 6.5 Core relationships

### Simple explanation

Everything important belongs to a company.

That is the core multitenancy rule.

### Relationship diagram

```mermaid
erDiagram
  COMPANIES ||--o{ AGENTS : has
  COMPANIES ||--o{ GOALS : has
  COMPANIES ||--o{ PROJECTS : has
  COMPANIES ||--o{ ISSUES : has
  COMPANIES ||--o{ APPROVALS : has
  COMPANIES ||--o{ COST_EVENTS : has
  COMPANIES ||--o{ HEARTBEAT_RUNS : has
  COMPANIES ||--o{ ROUTINES : has

  AGENTS ||--o{ AGENTS : reports_to
  AGENTS ||--o{ HEARTBEAT_RUNS : runs
  AGENTS ||--o{ ISSUES : assigned_to

  GOALS ||--o{ GOALS : parent
  GOALS ||--o{ PROJECTS : linked
  GOALS ||--o{ ISSUES : linked

  PROJECTS ||--o{ ISSUES : contains
  ISSUES ||--o{ ISSUES : parent
  ISSUES ||--o{ ISSUE_COMMENTS : has
  ISSUES ||--o{ ISSUE_ATTACHMENTS : has
  ISSUES ||--o{ ISSUE_DOCUMENTS : has
  ISSUES ||--o{ ISSUE_WORK_PRODUCTS : has
```

## 6.6 Key schema examples

### `companies`

Defined in `packages/db/src/schema/companies.ts`.

Important fields:

- `name`
- `status`
- `issuePrefix`
- `issueCounter`
- `budgetMonthlyCents`
- `requireBoardApprovalForNewAgents`

### `agents`

Defined in `packages/db/src/schema/agents.ts`.

Important fields:

- `companyId`
- `name`
- `role`
- `status`
- `reportsTo`
- `adapterType`
- `adapterConfig`
- `runtimeConfig`
- `permissions`

### `issues`

Defined in `packages/db/src/schema/issues.ts`.

Important fields:

- `companyId`
- `projectId`
- `goalId`
- `parentId`
- `status`
- `priority`
- `assigneeAgentId`
- `checkoutRunId`
- `executionRunId`
- `executionPolicy`
- `executionWorkspaceId`

This table is central. In practice, issues are the heart of the work system.

## 6.7 Indexes and constraints

### Simple explanation

Indexes make common queries fast.
Unique constraints enforce business rules.

### Examples found in schema

`packages/db/src/schema/issues.ts` includes:

- company + status index
- assignee + status index
- project index
- execution workspace index
- unique identifier index
- trigram GIN indexes for title, identifier, description search
- a conditional unique index for open routine execution issues

`packages/db/src/schema/companies.ts` includes:

- unique issue prefix index

`packages/db/src/schema/routines.ts` includes:

- unique public ID on routine triggers

These are useful signals about how the app is queried in practice:

- by company
- by status
- by assignee
- by search text
- by routine identity/idempotency

## 6.8 Migrations

Migrations live in:

- `packages/db/src/migrations/*.sql`
- `packages/db/src/migrations/meta/*.json`

Generation workflow from repo docs:

1. edit schema files
2. export schema from `packages/db/src/schema/index.ts`
3. run `pnpm db:generate`
4. run typecheck

Startup also inspects and may apply pending migrations, especially for embedded Postgres first-run cases.

## 6.9 Seed data

There is a seed script at `packages/db/src/seed.ts`.

It is a simple example that inserts:

- a company
- CEO and engineer agents
- a goal
- a project
- a few issues

This is useful as a learning example, but it does not look like a required production seeding pipeline.

## 6.10 CRUD behavior

CRUD is performed directly through Drizzle in services.

Common pattern:

```ts
await db.insert(issues).values({...}).returning();
await db.select().from(issues).where(...);
await db.update(issues).set({...}).where(...);
await db.delete(...).where(...);
```

Services often wrap these operations with:

- company ownership checks
- workflow validation
- side effects
- activity logging

## 6.11 Connection lifecycle

There is no separate DB microservice. The server process owns DB access.

Startup sequence:

1. resolve config
2. create or connect DB
3. inspect/apply migrations
4. create Drizzle client
5. pass client into app/services

---

## 7. API Architecture

## 7.1 API style

### Simple explanation

Paperclip uses a REST-style JSON API under `/api`.

### Technical explanation

Shared prefix constant:

- `packages/shared/src/api.ts`

Base path:

- `/api`

Response style:

- JSON for success
- JSON with `error` and sometimes `details` for failure

Common error statuses used in code/docs:

- `400`
- `401`
- `403`
- `404`
- `409`
- `422`
- `500`

## 7.2 Actor model at the API layer

The server identifies the actor in `server/src/middleware/auth.ts`.

Possible actors:

- board
- agent
- none

Board actor sources:

- implicit local board in `local_trusted`
- session-based user in `authenticated`
- board API key

Agent actor sources:

- agent API key
- local agent JWT

## 7.3 Validation

Request validation is done with Zod via `server/src/middleware/validate.ts`.

Pattern:

```ts
router.post("/...", validate(schema), async (req, res) => {
  ...
});
```

## 7.4 Important endpoint groups

Below are the most important endpoint groups found during inspection.

### Health and instance state

File: `server/src/routes/health.ts`

Key endpoint:

- `GET /api/health`

Returns:

- service status
- deployment mode
- bootstrap state
- version
- optional dev server state

### Companies

File: `server/src/routes/companies.ts`

Important endpoints:

- `GET /api/companies`
- `GET /api/companies/:companyId`
- `POST /api/companies`
- `PATCH /api/companies/:companyId`
- `POST /api/companies/:companyId/archive`
- `DELETE /api/companies/:companyId`
- `POST /api/companies/:companyId/export`
- `POST /api/companies/import`

### Agents and heartbeats

File: `server/src/routes/agents.ts`

Important endpoints:

- `GET /api/companies/:companyId/agents`
- `GET /api/agents/:id`
- `POST /api/companies/:companyId/agents`
- `PATCH /api/agents/:id`
- `POST /api/agents/:id/pause`
- `POST /api/agents/:id/resume`
- `POST /api/agents/:id/terminate`
- `GET /api/agents/:id/keys`
- `POST /api/agents/:id/keys`
- `POST /api/agents/:id/wakeup`
- `POST /api/agents/:id/heartbeat/invoke`
- `GET /api/companies/:companyId/heartbeat-runs`
- `GET /api/heartbeat-runs/:runId`
- `POST /api/heartbeat-runs/:runId/cancel`
- `GET /api/heartbeat-runs/:runId/log`

### Projects

File: `server/src/routes/projects.ts`

Important endpoints:

- `GET /api/companies/:companyId/projects`
- `GET /api/projects/:id`
- `POST /api/companies/:companyId/projects`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`
- workspace-related runtime control endpoints

### Issues

File: `server/src/routes/issues.ts`

Important endpoints:

- `GET /api/companies/:companyId/issues`
- `GET /api/issues/:id`
- `POST /api/companies/:companyId/issues`
- `PATCH /api/issues/:id`
- `DELETE /api/issues/:id`
- `POST /api/issues/:id/checkout`
- `POST /api/issues/:id/release`
- `GET /api/issues/:id/comments`
- `POST /api/issues/:id/comments`
- `GET /api/issues/:id/documents`
- `PUT /api/issues/:id/documents/:key`
- `POST /api/issues/:id/work-products`
- attachment endpoints
- issue approval link endpoints
- feedback trace/vote endpoints

### Approvals

File: `server/src/routes/approvals.ts`

Important endpoints:

- `GET /api/companies/:companyId/approvals`
- `GET /api/approvals/:id`
- `POST /api/companies/:companyId/approvals`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`
- `POST /api/approvals/:id/resubmit`
- `GET /api/approvals/:id/comments`
- `POST /api/approvals/:id/comments`

### Costs and budgets

File: `server/src/routes/costs.ts`

Important endpoints:

- `POST /api/companies/:companyId/cost-events`
- `POST /api/companies/:companyId/finance-events`
- `GET /api/companies/:companyId/costs/summary`
- `GET /api/companies/:companyId/costs/by-agent`
- `GET /api/companies/:companyId/budgets/overview`
- `PATCH /api/companies/:companyId/budgets`
- `PATCH /api/agents/:agentId/budgets`

### Routines

File: `server/src/routes/routines.ts`

Important endpoints:

- `GET /api/companies/:companyId/routines`
- `POST /api/companies/:companyId/routines`
- `GET /api/routines/:id`
- `PATCH /api/routines/:id`
- `POST /api/routines/:id/triggers`
- `PATCH /api/routine-triggers/:id`
- `DELETE /api/routine-triggers/:id`
- `POST /api/routines/:id/run`
- `POST /api/routine-triggers/public/:publicId/fire`

### Plugins

File: `server/src/routes/plugins.ts`

Important endpoints:

- `GET /api/plugins`
- `POST /api/plugins/install`
- `GET /api/plugins/:pluginId`
- `DELETE /api/plugins/:pluginId`
- `POST /api/plugins/:pluginId/enable`
- `POST /api/plugins/:pluginId/disable`
- `GET /api/plugins/:pluginId/config`
- `POST /api/plugins/:pluginId/config`
- `GET /api/plugins/:pluginId/jobs`
- `POST /api/plugins/:pluginId/jobs/:jobId/trigger`
- bridge action/data endpoints

### Adapters

File: `server/src/routes/adapters.ts`

Important endpoints:

- `GET /api/adapters`
- `POST /api/adapters/install`
- `PATCH /api/adapters/:type`
- `DELETE /api/adapters/:type`
- `POST /api/adapters/:type/reload`
- `GET /api/adapters/:type/config-schema`
- `GET /api/adapters/:type/ui-parser.js`

### Access / invites / CLI auth

File: `server/src/routes/access.ts`

Important endpoints:

- board claim endpoints
- CLI auth challenge endpoints
- invites and onboarding endpoints
- membership and join request endpoints
- skills discovery endpoints

## 7.5 Sequence diagrams for important API flows

### Create issue flow

```mermaid
sequenceDiagram
  participant UI
  participant Route as issues route
  participant Svc as issueService
  participant DB

  UI->>Route: POST /api/companies/:companyId/issues
  Route->>Route: validate(createIssueSchema)
  Route->>Svc: create(...)
  Svc->>DB: insert issue
  Svc->>DB: insert relations/labels if needed
  Svc-->>Route: issue row
  Route-->>UI: 201/200 JSON
```

### Heartbeat invoke flow

```mermaid
sequenceDiagram
  participant UI
  participant Route as agents route
  participant HB as heartbeatService
  participant ADP as adapter
  participant DB

  UI->>Route: POST /api/agents/:id/heartbeat/invoke
  Route->>HB: invokeHeartbeat(...)
  HB->>DB: create run
  HB->>ADP: execute
  ADP-->>HB: status, output, usage
  HB->>DB: update run and costs
  HB-->>Route: run
  Route-->>UI: JSON
```

### Approval decision flow

```mermaid
sequenceDiagram
  participant UI
  participant Route as approvals route
  participant Svc as approvalService
  participant DB

  UI->>Route: POST /api/approvals/:id/approve
  Route->>Svc: approve(...)
  Svc->>DB: update approval status
  Svc->>DB: write activity/comments/side effects
  Svc-->>Route: approval
  Route-->>UI: JSON
```

---

## 8. External Integrations

## 8.1 What integrations exist today

### Agent runtime integrations

These are the most important external integrations in practice.

Built-in adapter packages include:

- Claude local
- Codex local
- Cursor local
- Gemini local
- OpenClaw gateway
- OpenCode local
- PI local

These integrate Paperclip with:

- local agent CLIs
- external execution gateways
- adapter-specific runtime config and model discovery

### Authentication integration

- Better Auth for authenticated human sessions

### Storage integrations

- local disk storage
- S3-compatible object storage via AWS SDK

### Plugin ecosystem

- npm/local filesystem plugin packages
- plugin worker processes

### Other ecosystem packages

- `packages/mcp-hunter`
- `packages/mcp-outlook`
- `packages/mcp-sharepoint`
- `packages/mcp-server`

These suggest MCP-related integration work exists in the repo, though they are not central to the main server boot path inspected here.

## 8.2 Environment variables and configuration relevant to integrations

From docs and config code, important env/config values include:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | external Postgres connection |
| `BETTER_AUTH_SECRET` | Better Auth secret |
| `PAPERCLIP_AGENT_JWT_SECRET` | local agent JWT secret fallback |
| `PAPERCLIP_PUBLIC_URL` | public base URL |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | allowed private/public hostnames |
| `PAPERCLIP_STORAGE_PROVIDER` | `local_disk` or `s3` |
| `PAPERCLIP_STORAGE_LOCAL_DIR` | local storage base dir |
| `PAPERCLIP_STORAGE_S3_BUCKET` | S3 bucket |
| `PAPERCLIP_STORAGE_S3_REGION` | S3 region |
| `PAPERCLIP_STORAGE_S3_ENDPOINT` | custom S3 endpoint |
| `PAPERCLIP_STORAGE_S3_PREFIX` | S3 key prefix |
| `PAPERCLIP_SECRETS_PROVIDER` | secret provider |
| `PAPERCLIP_SECRETS_MASTER_KEY` | master key |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | key file path |
| `OPENAI_API_KEY` | needed for OpenAI-backed local tooling |
| `ANTHROPIC_API_KEY` | needed for Anthropic-backed local tooling |

## 8.3 Failure handling patterns

From inspected code:

- auth failures return `401` or `403`
- validation failures return `400`
- domain conflicts return `409` or `422`
- unknown server failures return `500`
- missing/misconfigured embedded Postgres errors are wrapped with friendlier messages
- plugin loading errors are logged and isolated
- heartbeat recovery logic tries to reap orphaned or stranded runs on startup
- live socket connections are pinged and terminated if dead

### Retry logic present

Current retry-related behavior found:

- heartbeat orphan recovery at startup
- queued run resume at startup
- issue comment retry tracking fields in `heartbeat_runs`
- plugin job scheduling/retrigger surfaces

### Retry logic not found as a generic subsystem

No general-purpose retry framework was found for:

- HTTP integrations
- job queues
- dead-letter processing

That means retries are currently subsystem-specific.

---

## 9. Apify Setup and Future Integration

## 9.1 What Apify is

### Simple explanation

Apify is a platform for running web automation and web data extraction jobs.

You can think of it as:

- hosted browser automation
- scraping job execution
- actor/task orchestration
- dataset/result storage

It is useful when you want Paperclip agents to collect structured data from the web without embedding all browser automation inside the main Paperclip server.

### Technical explanation

Apify revolves around:

- Actors
- Runs
- Datasets
- Key-value stores
- Webhooks

This maps well to Paperclip’s model of:

- issues
- heartbeat runs
- work products
- documents
- assets
- activity log entries

## 9.2 Where Apify should fit in Paperclip

### Recommendation

Apify should be added as an integration layer plus service module, not baked directly into route handlers and not mixed into core heartbeat code.

Best fit:

- a service module in `server/src/services/`
- optional trigger points from issues/routines/plugins/adapters
- persisted run/result records in the DB
- optionally invoked from routines or heartbeat workflows

### Why this fits the current architecture

Paperclip already organizes complex behavior through services, not controllers.

It already has:

- scheduler logic
- heartbeat run tracking
- work products/documents/assets
- plugin jobs
- external adapter concepts

So Apify belongs as a clean integration service that can be called by:

- issue automation
- routines
- plugins
- future agent tools

## 9.3 Recommended Apify architecture

```mermaid
flowchart TD
  Issue[Issue / Routine / Plugin action]
  Route[API Route or Scheduler]
  ApifySvc[apifyService]
  ApifyClient[Apify API client]
  ApifyRun[Apify Actor Run]
  Poll[Run status poll / webhook callback]
  DB[(PostgreSQL)]
  Assets[Storage]

  Issue --> Route
  Route --> ApifySvc
  ApifySvc --> ApifyClient
  ApifyClient --> ApifyRun
  ApifyRun --> Poll
  Poll --> ApifySvc
  ApifySvc --> DB
  ApifySvc --> Assets
```

## 9.4 Suggested folder structure

Recommended additions:

```text
server/src/integrations/apify/
  client.ts
  types.ts
  mappers.ts
  errors.ts
  webhook.ts

server/src/services/
  apify.ts

server/src/routes/
  apify.ts

packages/db/src/schema/
  apify_runs.ts
  apify_datasets.ts
  apify_items.ts

packages/shared/src/types/
  apify.ts

packages/shared/src/validators/
  apify.ts
```

If you want a thinner initial version, you can skip a public route file and keep it service-only first.

## 9.5 Recommended data model for Apify

Suggested new tables:

### `apify_runs`

Purpose:

- map Paperclip issue/routine/plugin context to an Apify actor run

Suggested fields:

- `id`
- `company_id`
- `issue_id` nullable
- `routine_run_id` nullable
- `heartbeat_run_id` nullable
- `requested_by_user_id` nullable
- `requested_by_agent_id` nullable
- `actor_id`
- `task_id` nullable
- `apify_run_id`
- `status`
- `input_json`
- `output_dataset_id` nullable
- `output_kv_store_id` nullable
- `started_at`
- `finished_at`
- `error`
- `created_at`

### `apify_items`

Purpose:

- optionally persist normalized result rows for search/filtering

Suggested fields:

- `id`
- `company_id`
- `apify_run_id`
- `item_index`
- `item_json`
- `created_at`

You may not need this table if storing result bundles as documents/assets is enough.

## 9.6 Recommended environment variables

Suggested env vars:

| Variable | Purpose |
|---|---|
| `APIFY_TOKEN` | Apify API token |
| `APIFY_BASE_URL` | optional override, default `https://api.apify.com` |
| `APIFY_WEBHOOK_SECRET` | verify webhook signatures if using webhooks |
| `APIFY_DEFAULT_TIMEOUT_SEC` | default actor timeout |
| `APIFY_POLL_INTERVAL_MS` | polling interval when not using webhooks |
| `APIFY_MAX_RETRIES` | retry count for transient failures |

Store `APIFY_TOKEN` as a Paperclip company secret if runs are company-specific.

## 9.7 How Apify should be triggered

Recommended trigger sources:

1. Manual board action from issue page
2. Routine trigger for scheduled scraping
3. Plugin action
4. Agent heartbeat tool call

### Best first version

Start with:

- manual issue-linked trigger
- routine-linked trigger

That fits existing Paperclip patterns and avoids overcoupling Apify to adapter internals too early.

## 9.8 How results should be stored

Recommended storage strategy:

1. Store run metadata in `apify_runs`
2. Store raw large outputs in:
   - `documents`
   - `issue_work_products`
   - `assets` if binary
3. Optionally store normalized extracted rows in `apify_items`
4. Add an issue comment summarizing completion and linking artifacts

This fits current Paperclip output-first behavior.

## 9.9 Retries, rate limits, failures, logs, and monitoring

### Retries

Use bounded retries for:

- network timeouts
- Apify 5xx errors
- transient rate limit responses

Do not blindly retry:

- invalid actor input
- auth failures
- permanently missing actor/task IDs

### Rate limits

Use:

- exponential backoff
- jitter
- status field updates in `apify_runs`

### Failure recording

On failure:

- update `apify_runs.status`
- persist `error`
- write activity log entry
- optionally comment on related issue

### Logs

Capture:

- request metadata
- actor/task used
- run ID
- duration
- result size
- error category

### Monitoring

Minimum useful metrics:

- runs started
- runs succeeded
- runs failed
- average duration
- retry count
- dataset item count

## 9.10 Pseudocode outline

```ts
// server/src/services/apify.ts
export function apifyService(db: Db, deps: { http: FetchLike }) {
  return {
    async startActorRun(input) {
      const run = await db.insert(apifyRuns).values({
        companyId: input.companyId,
        issueId: input.issueId ?? null,
        actorId: input.actorId,
        status: "queued",
        inputJson: input.payload,
      }).returning().then(rows => rows[0]);

      const remote = await apifyClient.startRun({
        actorId: input.actorId,
        token: await resolveApifyToken(input.companyId),
        input: input.payload,
      });

      await db.update(apifyRuns)
        .set({
          apifyRunId: remote.id,
          status: "running",
          startedAt: new Date(),
        })
        .where(eq(apifyRuns.id, run.id));

      return run;
    },

    async syncRun(runId: string) {
      const run = await getRun(runId);
      const remote = await apifyClient.getRun(run.apifyRunId);

      if (remote.status === "SUCCEEDED") {
        const items = await apifyClient.listDatasetItems(remote.defaultDatasetId);
        const document = await documentService(...).upsertIssueDocument(...);
        await addIssueComment(...);
        await markRunSucceeded(...);
        return { status: "succeeded", itemCount: items.length, documentId: document.id };
      }

      if (remote.status === "FAILED" || remote.status === "ABORTED") {
        await markRunFailed(...);
        return { status: "failed" };
      }

      return { status: "running" };
    },
  };
}
```

## 9.11 Best integration path for this repo

Recommended order:

1. Add DB table for `apify_runs`
2. Add shared types and validators
3. Add `server/src/services/apify.ts`
4. Add issue-level trigger endpoint
5. Add issue detail UI action
6. Add routine integration
7. Add optional webhook receiver
8. Add result-to-document/work-product mapping

That sequence matches the current architecture and avoids introducing a large new subsystem all at once.

---

## 10. Development Setup

## 10.1 Local setup

### Simple explanation

The easiest path is:

```sh
pnpm install
pnpm dev
```

That is enough for a normal local dev setup.

### Technical notes

From `doc/DEVELOPING.md`:

- Node.js 20+
- pnpm 9+

By default:

- API server runs on `http://localhost:3100`
- UI is served by the API server in dev middleware mode

## 10.2 Required dependencies

You need:

- Node.js
- pnpm

You do not need a manually installed Postgres instance for the default local path.

## 10.3 `.env` and config

Minimal example found in `.env.example`:

```env
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
PORT=3100
SERVE_UI=false
BETTER_AUTH_SECRET=paperclip-dev-secret
```

But local embedded Postgres usually works with `DATABASE_URL` unset.

## 10.4 Running frontend/backend/services

Typical commands:

- `pnpm dev`
- `pnpm dev:once`
- `pnpm dev:list`
- `pnpm dev:stop`
- `pnpm dev:ui`
- `pnpm dev:server`

## 10.5 Database modes

### Embedded local default

Leave `DATABASE_URL` unset.

### Local Docker Postgres

Use `docker/docker-compose.yml` and set `DATABASE_URL`.

### Hosted Postgres

Set `DATABASE_URL` to your managed Postgres connection string.

## 10.6 Common dev commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start full dev stack |
| `pnpm build` | Build all packages |
| `pnpm -r typecheck` | Typecheck workspace |
| `pnpm test:run` | Run Vitest |
| `pnpm test:e2e` | Run Playwright E2E |
| `pnpm test:release-smoke` | Run release smoke suite |
| `pnpm db:generate` | Generate Drizzle migration |
| `pnpm db:migrate` | Apply migrations |
| `pnpm paperclipai` | Run CLI |

## 10.7 Build/test expectations before handoff

From repo instructions, the preferred verification path is:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

---

## 11. Debugging Guide

## 11.1 General debugging strategy

### Simple explanation

When something breaks, first identify which layer is failing:

1. UI
2. API
3. auth
4. DB
5. heartbeat/adapter
6. plugin
7. storage

### Fast troubleshooting checklist

- Does `GET /api/health` return healthy?
- Is the correct company selected?
- Is the request failing before route logic or inside service logic?
- Is auth actor resolution correct?
- Is the DB reachable?
- Did a heartbeat run get created?
- Did the adapter actually execute?
- Did a plugin worker crash?

## 11.2 When APIs fail

Look in this order:

1. browser network tab
2. server console logs
3. server log file
4. matching route file in `server/src/routes/`
5. corresponding service in `server/src/services/`

Useful files:

- `server/src/middleware/logger.ts`
- `server/src/middleware/error-handler.ts`
- `server/src/routes/*.ts`
- `server/src/services/*.ts`

Typical API failure causes:

- Zod validation failure
- actor not authorized
- company mismatch
- missing record
- workflow conflict
- adapter prerequisite missing

## 11.3 When DB connection fails

Check:

- `DATABASE_URL`
- embedded Postgres data dir
- port collisions
- migration state
- startup logs from `server/src/index.ts`

Useful commands:

```sh
curl http://localhost:3100/api/health
pnpm db:migrate
```

Common causes:

- stale embedded Postgres lock file
- wrong external connection string
- stale schema versus code expectations

## 11.4 When heartbeat/agent execution fails

Look at:

- `server/src/services/heartbeat.ts`
- `server/src/routes/agents.ts`
- `server/src/adapters/`
- `packages/adapters/*`
- `GET /api/heartbeat-runs/:runId/log`

Important debugging questions:

- Was the run created?
- Did the adapter resolve?
- Did the local CLI exist on `PATH`?
- Was auth/secrets resolution successful?
- Was the workspace prepared correctly?
- Did costs/logs/result JSON persist?

## 11.5 When live updates fail

Check:

- `server/src/realtime/live-events-ws.ts`
- `server/src/services/live-events.ts`
- `ui/src/context/LiveUpdatesProvider.tsx`

Common causes:

- websocket auth rejection
- wrong company ID in socket path
- missing active session in authenticated mode
- socket reconnect suppression logic

## 11.6 When plugins fail

Check:

- `server/src/services/plugin-loader.ts`
- `server/src/services/plugin-worker-manager.ts`
- `server/src/routes/plugins.ts`
- plugin logs endpoints

Debug questions:

- was the plugin discovered?
- did manifest validation pass?
- did worker process start?
- did capabilities match runtime use?
- did UI static assets load?

## 11.7 Practical debugging checklists

### API failure checklist

- Confirm request URL and company ID
- Confirm response status/body
- Confirm route exists in `server/src/routes`
- Confirm request body matches validator schema
- Confirm `req.actor` should be allowed
- Confirm service throws expected error type

### DB failure checklist

- Check `GET /api/health`
- Check migration state
- Check embedded Postgres port/data dir
- Check external DB credentials
- Check schema file versus migration drift

### Adapter failure checklist

- Confirm adapter type on agent record
- Confirm adapter package exists
- Confirm local CLI or remote gateway is reachable
- Check heartbeat run log
- Check cost event persistence

### Plugin failure checklist

- Confirm plugin is installed/enabled
- Confirm worker is alive
- Confirm plugin config is valid
- Confirm plugin UI route/static path resolves
- Check plugin logs/job runs

---

## 12. Design and Extension Guide

## 12.1 How to add a new feature

### Recommended workflow in this repo

1. Read the spec/docs first.
2. Identify the company-scoped data involved.
3. Decide which route and service own the behavior.
4. Update shared types/validators if API shape changes.
5. Update DB schema/migrations if persistence changes.
6. Update UI API client and page/components.
7. Add tests.

### Core repo rule

If behavior changes cross layers, update all affected layers:

- `packages/db`
- `packages/shared`
- `server`
- `ui`

## 12.2 How to add a new API

Typical path:

1. Add shared request/response validators/types in `packages/shared/src/validators` and `types`
2. Add route in an existing `server/src/routes/*.ts` file or create a new route module
3. Add service logic in `server/src/services/*.ts`
4. Add frontend client wrapper in `ui/src/api/*.ts`
5. Use the new client in page/component code
6. Add tests

## 12.3 How to add a new database table/model

1. Add schema file in `packages/db/src/schema/`
2. Export it from `packages/db/src/schema/index.ts`
3. Run `pnpm db:generate`
4. Run `pnpm -r typecheck`
5. Use it from services/routes
6. Add shared types if exposed over API

## 12.4 How to add a new service

Place service in:

- `server/src/services/<domain>.ts`

Suggested structure:

- constructor function `fooService(db)`
- domain methods
- explicit checks for company scope and actor rules
- narrow helper functions inside module

This matches current code style.

## 12.5 How to add validation

Use Zod validators in `packages/shared/src/validators/`.

Then wire them into routes with:

```ts
router.post("/...", validate(schema), async (req, res) => ...)
```

## 12.6 How to add logging and error handling

Use:

- `logger` from `server/src/middleware/logger.ts`
- `HttpError` helpers from `server/src/errors.ts`

Prefer domain-specific errors like:

- `notFound(...)`
- `conflict(...)`
- `unprocessable(...)`

This keeps error responses consistent.

## 12.7 How to add tests

Use:

- Vitest for unit/integration tests near server/ui logic
- Playwright for browser flows

Examples:

- `server/src/__tests__/issues-service.test.ts`
- `server/src/__tests__/routines-e2e.test.ts`
- `ui/src/pages/*.test.tsx`
- `tests/e2e/`

## 12.8 Naming conventions and patterns observed

Patterns used in repo:

- service factory style: `fooService(db)`
- route module style: `fooRoutes(db)`
- shared package barrel exports
- table-per-file schema
- domain-oriented folders instead of strict MVC
- company-scoped route paths for multi-company entities

### Important architectural conventions

- company is first-order
- route handlers are thin-ish, services are thicker
- shared validators are preferred over server-only schemas when contracts are shared
- issue is the main work object
- heartbeats are explicit runs, not hidden background magic

---

## 13. Security and Configuration

## 13.1 Authentication

### Human auth

Implemented through:

- implicit local board in `local_trusted`
- Better Auth in `authenticated`

Relevant files:

- `server/src/auth/better-auth.ts`
- `server/src/middleware/auth.ts`

### Agent auth

Implemented through:

- agent bearer API keys
- local JWTs

Relevant tables:

- `agent_api_keys`

## 13.2 Authorization

Authorization is mostly enforced through:

- actor type checks
- company membership checks
- instance admin checks
- company scoping in routes/services

### Example security middleware

- `server/src/middleware/private-hostname-guard.ts`
- `server/src/middleware/board-mutation-guard.ts`

These protect:

- private deployment hostname access
- trusted browser-origin board mutations

## 13.3 Secrets management

Secrets are handled in:

- `server/src/services/secrets.ts`
- `server/src/secrets/`
- DB tables `company_secrets` and `company_secret_versions`

Default provider:

- `local_encrypted`

Important behavior:

- secret references can be used in env bindings
- strict mode can forbid inline sensitive env values
- secret material is stored encrypted through provider logic

## 13.4 Input validation and API security

Input validation uses Zod.

API security patterns found:

- auth middleware before routes
- origin checks for board mutations
- consistent structured errors
- authorization header redaction in logs
- company membership enforcement

## 13.5 DB security practices

Observed practices:

- hashed API keys at rest
- company-scoped foreign keys
- secret version separation
- no plain API key persistence after creation

## 13.6 External integration security

For Apify and similar systems:

- keep tokens in company secrets, not inline env strings
- validate webhooks
- record external run IDs
- store only needed outputs
- redact sensitive logs

---

## 14. Deployment / Infrastructure

## 14.1 Build and deploy model

### Simple explanation

Paperclip can run:

- locally from source
- in Docker
- in Docker Compose
- with Podman quadlet

### Docker

Main production image defined in:

- `Dockerfile`

Important details:

- multi-stage build
- builds UI, plugin SDK, and server
- production image installs agent CLIs
- defaults to authenticated private mode in container
- persists data under `/paperclip`

### Deployment mode concepts

Paperclip has explicit deployment concepts documented in `doc/DEPLOYMENT-MODES.md`.

There are two runtime modes:

1. `local_trusted`
2. `authenticated`

And `authenticated` has two exposure policies:

1. `private`
2. `public`

This gives three practical hosting shapes:

| Mode | Best use |
|---|---|
| `local_trusted` | local single-operator machine |
| `authenticated + private` | team/private network deployment, Tailscale, VPN, LAN |
| `authenticated + public` | internet-facing/cloud deployment |

### Reachability and hosting concepts

Paperclip separates auth model from bind/reachability.

Bind modes from `doc/DEPLOYMENT-MODES.md`:

- `loopback`
- `lan`
- `tailnet`
- `custom`

Simple meaning:

- `loopback`: only localhost can reach it directly
- `lan`: all network interfaces can reach it
- `tailnet`: a Tailscale IP is used
- `custom`: explicit host/IP

### How to host Paperclip as a server for broader usage

If you want one Paperclip instance to serve multiple human users and multiple companies from a central host, the clean model is:

1. run in `authenticated` mode
2. use external or hosted PostgreSQL
3. store files on durable storage
4. expose the app behind a reverse proxy or public URL
5. use `PAPERCLIP_PUBLIC_URL`
6. keep `BETTER_AUTH_SECRET` and other secrets stable

Recommended practical patterns:

#### Private team host

Best for:

- internal company deployment
- VPN/Tailscale office network

Recommended config:

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- bind via LAN, tailnet, or loopback behind private reverse proxy
- external or hosted Postgres

#### Public cloud host

Best for:

- internet-facing shared environment
- hosted control plane

Recommended config:

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=public`
- set `PAPERCLIP_PUBLIC_URL`
- usually bind to loopback and place behind reverse proxy/load balancer
- external/hosted Postgres
- S3 storage strongly preferred for persistence at scale

### Cloud-level hosting architecture recommendation

If you were deploying Paperclip as a proper cloud-hosted service, the clean architecture would be:

```mermaid
flowchart TD
  User[Browser / Board User]
  DNS[DNS]
  Proxy[Reverse Proxy / Load Balancer]
  App[Paperclip Server Container]
  DB[(Managed PostgreSQL)]
  Obj[(Object Storage / S3)]
  Logs[Central Logs]

  User --> DNS --> Proxy --> App
  App --> DB
  App --> Obj
  App --> Logs
```

### What "serve this as a host and use for all" means in Paperclip terms

In this repo’s architecture, that means:

- one running Paperclip server process
- one shared PostgreSQL database
- many companies stored inside that one Paperclip instance
- many human users authenticated against the same instance
- many agents belonging to those companies

That is already aligned with the product model:

- single Paperclip instance
- multi-company data model

So the cloud-hosted form is not a separate product design. It is the same control plane, just deployed centrally.

### Docker Compose

Files:

- `docker/docker-compose.quickstart.yml`
- `docker/docker-compose.yml`
- `docker/docker-compose.untrusted-review.yml`

Use cases:

- embedded single-container quickstart
- full stack with Postgres
- isolated PR review

## 14.2 CI/CD

GitHub workflows found:

- `.github/workflows/pr.yml`
- `.github/workflows/docker.yml`
- `.github/workflows/release.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/release-smoke.yml`

### PR workflow

`pr.yml` verifies:

- lockfile policy
- Docker deps stage sync
- dependency resolution
- typecheck
- tests
- build
- canary release dry run
- E2E tests

### CI/CD concepts explained simply

#### CI

Simple: Continuous Integration means every important change gets automatically checked.

In this repo, CI checks:

- dependency policy
- type safety
- tests
- build correctness
- some browser-level validation

#### CD

Simple: Continuous Delivery or Deployment means shipping is automated or semi-automated.

In this repo, CD is split into:

- automatic canary publishing on `master`
- manual stable release promotion
- automatic Docker image publishing

### End-to-end CI/CD pipeline in this repo

```mermaid
flowchart LR
  Dev[Developer push / PR]
  PR[PR workflow]
  Merge[Merge to master]
  Canary[Automatic canary release]
  Docker[Docker image publish]
  Smoke[Release smoke]
  Stable[Manual stable promotion]
  GitHubRel[GitHub Release]
  NPM[npm publish]

  Dev --> PR
  PR --> Merge
  Merge --> Canary
  Merge --> Docker
  Canary --> Smoke
  Smoke --> Stable
  Stable --> NPM
  Stable --> GitHubRel
```

### PR pipeline detail

From `.github/workflows/pr.yml`, pull requests to `master` go through:

1. policy checks
2. dependency/lockfile rules
3. Dockerfile deps-stage sync verification
4. typecheck
5. Vitest test run
6. build
7. canary dry-run check
8. E2E browser test run

This is a strong signal that the repo treats:

- build reproducibility
- package integrity
- release readiness

as first-class quality gates.

### Lockfile automation

From `.github/workflows/refresh-lockfile.yml`:

- lockfile updates are managed by automation
- PRs are not supposed to commit `pnpm-lock.yaml` manually
- a branch `chore/refresh-lockfile` is auto-maintained

This is part of the repository’s delivery discipline.

### Docker image delivery

From `.github/workflows/docker.yml`:

- images are built on pushes to `master`
- semver tags are supported
- images are pushed to GHCR
- multi-architecture builds are published:
  - `linux/amd64`
  - `linux/arm64`

That means the cloud/container distribution path is already in place.

### Release pipeline

From `.github/workflows/release.yml` and `doc/RELEASING.md`:

- every push to `master` triggers canary verification + canary publish
- stable releases are manual promotions from a chosen ref
- stable releases use changelog files in `releases/`
- GitHub Releases are only created for stable releases

### E2E and release smoke

Additional workflows:

- `.github/workflows/e2e.yml`
- `.github/workflows/release-smoke.yml`

These workflows are important because they test more realistic runtime behavior:

- browser flow correctness
- fresh-instance onboarding
- authenticated login
- containerized smoke behavior

### CI/CD setup if you host Paperclip in the cloud

A practical cloud rollout based on current repo mechanics would be:

1. PR opens
2. CI verifies typecheck/tests/build
3. merge to `master`
4. canary npm publish happens automatically
5. Docker image publishes to GHCR automatically
6. optional staging/smoke deployment pulls canary image
7. maintainers manually promote a tested commit to stable

This repo already contains most of that automation except the environment-specific deployment step into a cloud platform.

### What is not fully defined here

The repo shows build and release automation clearly, but not one single mandatory cloud platform.

Not found as first-class deployment definitions:

- Kubernetes manifests
- Helm charts
- Terraform
- ECS task definitions
- Fly.io config
- Render config

So the repo is opinionated about packaging and release, but not yet opinionated about one specific cloud host.

### Docker workflow

`docker.yml` builds and pushes multi-arch images to GHCR.

### Release workflow

`release.yml` supports:

- canary publish on push to master
- stable release via workflow dispatch

## 14.3 Logging and monitoring in production

What exists:

- Pino logs
- file logs
- health endpoint
- some telemetry hooks

What is not prominent in the inspected repo:

- dedicated observability stack configs
- Prometheus/Grafana manifests
- vendor-specific tracing integration configs

## 14.4 Production readiness concerns

Main concerns to watch:

- in-process scheduler means single-node behavior assumptions
- no external queue means process restarts matter
- plugin workers need supervision and clear failure isolation
- agent CLI prerequisites must exist on host/container
- auth/public URL config must be correct in authenticated mode
- storage mode must match deployment durability needs

### Suggested cloud environment split

If you were operating Paperclip seriously across environments, a sensible split would be:

#### Local

- embedded Postgres
- local disk storage
- `local_trusted`

#### Staging

- hosted Postgres
- S3 or S3-compatible storage
- `authenticated + private`
- GHCR canary image

#### Production

- managed Postgres
- S3 storage
- `authenticated + public` or `authenticated + private` behind company network
- reverse proxy / TLS terminator
- stable release image/tag

### Suggested host setup pattern

For a stable hosted deployment:

1. Run Paperclip in a container or VM.
2. Put Nginx, Caddy, Traefik, or a cloud load balancer in front.
3. Set `PAPERCLIP_PUBLIC_URL` to the canonical HTTPS URL.
4. Use hosted Postgres.
5. Use persistent object storage for assets.
6. Keep secrets outside the repo and inject via environment/config.

This is the cleanest way to turn the repo into a shared always-on host.

---

## 15. Glossary

### API

Simple: a way for one program to ask another program to do something.

Technical: HTTP endpoints under `/api` exposed by the Express server.

### Route

Simple: a URL + HTTP method combination like `GET /api/health`.

Technical: Express route handlers defined in `server/src/routes/*.ts`.

### Controller

Simple: code that receives a request and chooses what to do.

Technical in this repo: there is no separate controller layer; route files play that role.

### Service

Simple: business logic code.

Technical: modules in `server/src/services/` that implement domain behavior and DB operations.

### Middleware

Simple: code that runs before or after a request handler.

Technical: Express middleware such as auth, logging, validation, and error handling.

### Model

Simple: a representation of an important business object.

Technical: in this repo, models are mostly represented by Drizzle table schemas plus shared types.

### Schema

Simple: the shape of data.

Technical: DB schemas in `packages/db/src/schema/*.ts` and validation schemas in `packages/shared/src/validators/*.ts`.

### Database connection

Simple: the server’s connection to PostgreSQL.

Technical: created by `createDb()` in `packages/db/src/client.ts`.

### Environment variable

Simple: a named setting passed to the app from the shell or deployment environment.

Technical: values like `DATABASE_URL` or `BETTER_AUTH_SECRET` read in `server/src/config.ts`.

### ORM

Simple: a library that helps code talk to a database more safely.

Technical: Drizzle ORM is used here for typed PostgreSQL access.

### Queue

Simple: a list of jobs waiting to run.

Technical: no dedicated external queue system was found; scheduling is mostly in-process.

### Worker

Simple: a process that does background work.

Technical: plugin worker processes and adapter-invoked agent runtimes act as workers here.

### Actor

Simple: something that performs an action.

Technical: in this repo it can mean auth actor (`board`, `agent`) or Apify Actor in future integration discussions.

### Webhook

Simple: an HTTP callback sent automatically by one system to another.

Technical: Paperclip already supports webhook-like routine triggers and plugin webhooks.

### Cron job

Simple: work scheduled to happen at certain times.

Technical: routine triggers use cron expressions and in-process scheduler logic.

### Migration

Simple: a controlled change to the DB structure.

Technical: SQL files in `packages/db/src/migrations/`.

### Seed

Simple: starter data inserted into the DB.

Technical: `packages/db/src/seed.ts`.

### Authentication

Simple: proving who you are.

Technical: Better Auth sessions, board API keys, agent API keys, JWTs.

### Authorization

Simple: deciding what you are allowed to do.

Technical: actor checks, membership checks, company checks, origin checks.

### Logging

Simple: recording what the app did.

Technical: Pino-based structured and HTTP logging.

### Deployment

Simple: putting the app somewhere it can run for users.

Technical: local source run, Docker, Compose, quadlet, CI release flows.

### Monitoring

Simple: checking whether the system is healthy.

Technical: health endpoint, logs, telemetry hooks, live event visibility.

---

## 16. How to Learn This Repo in 7 Days

### Day 1

Read:

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`

Goal:

Understand what Paperclip is supposed to be.

### Day 2

Read:

- `server/src/index.ts`
- `server/src/app.ts`
- `server/src/routes/index.ts`

Goal:

Understand server startup and route composition.

### Day 3

Read:

- `packages/db/src/client.ts`
- `packages/db/src/runtime-config.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/schema/companies.ts`
- `packages/db/src/schema/agents.ts`
- `packages/db/src/schema/issues.ts`

Goal:

Understand the system of record.

### Day 4

Read:

- `server/src/services/agents.ts`
- `server/src/services/issues.ts`
- `server/src/services/heartbeat.ts`
- `server/src/services/approvals.ts`

Goal:

Understand the core domain logic.

### Day 5

Read:

- `ui/src/main.tsx`
- `ui/src/App.tsx`
- `ui/src/api/client.ts`
- `ui/src/context/CompanyContext.tsx`
- `ui/src/context/LiveUpdatesProvider.tsx`

Goal:

Understand how the UI talks to the backend.

### Day 6

Read:

- `server/src/services/plugin-loader.ts`
- `server/src/routes/plugins.ts`
- `packages/plugins/sdk/`
- `server/src/adapters/`
- one adapter package such as `packages/adapters/codex-local/`

Goal:

Understand extension and execution architecture.

### Day 7

Run and trace a full workflow:

1. `pnpm dev`
2. create a company
3. create an agent
4. create an issue
5. invoke a heartbeat
6. inspect run logs
7. inspect DB tables and activity

Goal:

Connect architecture to actual runtime behavior.

---

## Most Important Files to Read First

- `doc/SPEC-implementation.md`
- `server/src/index.ts`
- `server/src/app.ts`
- `packages/db/src/schema/issues.ts`
- `packages/db/src/schema/agents.ts`
- `server/src/services/heartbeat.ts`
- `server/src/services/issues.ts`
- `server/src/routes/agents.ts`
- `server/src/routes/issues.ts`
- `ui/src/App.tsx`
- `ui/src/main.tsx`
- `ui/src/api/client.ts`

---

## Common Mistakes to Avoid

- Forgetting that almost everything must be company-scoped
- Updating server behavior without updating `packages/shared`
- Changing schema without exporting it from `packages/db/src/schema/index.ts`
- Treating issues like a side feature instead of the core work object
- Adding logic in route handlers that should live in services
- Ignoring auth mode differences between `local_trusted` and `authenticated`
- Forgetting that startup may auto-manage embedded Postgres
- Assuming there is a generic background queue when most scheduling is in-process
- Adding external integrations directly inside route files instead of behind service boundaries
- Skipping activity logging or budget/approval side effects when changing mutating flows

---

## Recommended Next Steps for Apify Integration

1. Add an `apify_runs` schema and migration.
2. Add `packages/shared` types/validators for Apify run requests and results.
3. Implement `server/src/services/apify.ts`.
4. Add an issue-level trigger endpoint and issue detail UI action.
5. Persist result summaries as issue documents or work products.
6. Add routine-trigger support for scheduled Apify runs.
7. Add webhook support only after the polling version is stable.
8. Add cost/usage accounting only if Apify spend needs to appear in the budget system.
