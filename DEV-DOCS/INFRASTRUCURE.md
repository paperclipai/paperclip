# Infrastructure

Last updated: 2026-03-15

## 1. Purpose

This document describes the infrastructure of the Paperclip application as it exists in this repository:

- the runtime processes
- the configuration layers
- the persistence and filesystem layout
- the auth, storage, secrets, adapter, and realtime subsystems
- the operational loops that keep the instance running

`DEV-DOCS/ARCHITECTURE.md` explains the domain model and product semantics.
This document focuses on the technical runtime and operational substrate underneath that model.

## 2. Runtime Topology

Paperclip is a single-instance control plane with one primary server process and multiple clients around it.

### Main runtime components

| Component | Runs where | Primary responsibility | Key code |
|---|---|---|---|
| Server | Node.js process | API, auth, orchestration, schedulers, websocket upgrades | `server/src/index.ts`, `server/src/app.ts` |
| UI | Browser app, served statically or via Vite middleware | Operator console for all board workflows | `ui/src/App.tsx` |
| CLI | Separate operator process | Onboarding, doctor, run, config, and client commands | `cli/src/index.ts` |
| Database | Embedded PostgreSQL by default, external Postgres optionally | System of record for all core entities | `packages/db/src/*` |
| Repo startup scripts | Local checkout process | Resolve startup profile, pin instance env, and record launch attempts | `scripts/start-local.mjs`, `scripts/dev-runner.mjs`, `scripts/startup-context.mjs` |
| Storage provider | Local disk or S3-compatible object storage | Asset and file storage | `server/src/storage/*` |
| Secret provider | Local encrypted provider by default, pluggable registry | Secret material resolution for agent env bindings | `server/src/secrets/*`, `server/src/services/secrets.ts` |
| Adapter runtime | In-process adapter registry, spawning local tools or gateway calls | Agent execution and environment diagnostics | `server/src/adapters/*`, `packages/adapters/*` |
| Realtime event hub | In-process `EventEmitter` plus websocket bridge | Pushes live events to the UI | `server/src/services/live-events.ts`, `server/src/realtime/live-events-ws.ts` |

### Deployment modes

Paperclip supports two deployment modes:

- `local_trusted`
  - board access is implicit on the local machine
  - requires loopback host binding
  - only supports `private` exposure
- `authenticated`
  - board access requires authenticated sessions
  - can run as `private` or `public`
  - private deployments enforce allowed-hostname rules

The canonical exposure model is:

- `private`
- `public`

In practice:

- `local_trusted` always resolves to `private`
- `authenticated/public` requires explicit auth public base URL configuration

## 3. Configuration Infrastructure

Configuration is resolved in layers:

1. built-in defaults
2. Paperclip config file
3. environment variables
4. CLI overrides for some workflows

For repo-root startup scripts there is an additional operator-facing layer before the server boots:

5. repo-local startup profile at `.paperclip/local-start.json`

### Config loading

`server/src/config.ts` builds the final runtime config. It reads:

- the Paperclip config file via `readConfigFile()`
- `.env` via the resolved Paperclip env path when present
- direct process environment overrides

### Important config domains

The runtime config currently covers:

- deployment mode and exposure
- host and port
- allowed hostnames
- auth base URL behavior
- database mode and connection
- embedded Postgres directory and port
- database backup schedule and retention
- UI serving mode
- secrets provider and strict mode
- storage provider and provider-specific options
- heartbeat scheduler interval
- briefing scheduler interval
- company deletion enablement

### Common environment-driven behavior

Important examples:

- `DATABASE_URL`
  - when present, the server uses external PostgreSQL
- `PAPERCLIP_DEPLOYMENT_MODE`
  - selects `local_trusted` or `authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE`
  - selects `private` or `public` in authenticated mode
- `PAPERCLIP_UI_DEV_MIDDLEWARE=true`
  - serves the UI through Vite middleware in dev
- `PAPERCLIP_STORAGE_PROVIDER`
  - selects `local_disk` or `s3`
- `PAPERCLIP_SECRETS_PROVIDER`
  - selects the secret provider
- `HEARTBEAT_SCHEDULER_INTERVAL_MS`
  - controls agent timer tick cadence
- `BRIEFING_SCHEDULER_INTERVAL_MS`
  - controls briefing schedule cadence

## 4. Process Startup Infrastructure

The runtime boot path lives in `server/src/index.ts`.

### Startup phases

1. Resolve startup context from env, repo-local profile, or interactive chooser.
2. Record a launch attempt for the resolved instance.
3. Load runtime config.
4. Normalize secrets-related env vars so downstream code sees a consistent view.
5. Resolve the database mode:
   - external Postgres if `DATABASE_URL` or config connection string exists
   - embedded PostgreSQL otherwise
6. Inspect migrations and apply or prompt when needed.
7. Validate deployment-mode constraints.
8. Initialize auth mode:
   - local implicit board bootstrap in `local_trusted`
   - Better Auth setup in `authenticated`
9. Create the storage service.
10. Build the Express app with mounted routes and UI mode.
11. Create the HTTP server.
12. Attach websocket upgrade handling.
13. Start scheduler loops:
    - heartbeat timers and orphan-run reap
    - briefing schedule generation
    - automatic database backups
14. Listen on the resolved host and port and append a `ready` launch-history row.

### UI serving modes

The server can run in three UI modes:

- `none`
  - API only
- `static`
  - serves prebuilt UI assets from `ui/dist` or packaged `ui-dist`
- `vite-dev`
  - injects Vite middleware for local development

## 5. Database Infrastructure

### Default database mode

If no explicit Postgres connection string is supplied, Paperclip uses embedded PostgreSQL.

Default local location:

- `~/.paperclip/instances/default/db`

Default embedded database name:

- `paperclip`

### External database mode

When `DATABASE_URL` or the config file provides a Postgres connection string:

- the server skips embedded database boot
- the same Drizzle schema and migration system still apply

### Migration management

`packages/db/src/client.ts` owns:

- DB client creation
- migration discovery
- migration journal inspection
- fallback manual migration application
- migration drift repair for missing journal entries

The server startup path uses that package to:

- inspect whether the schema is current
- automatically apply first-run embedded migrations
- prompt or auto-apply other pending migrations depending on runtime conditions

### Core persisted domains

The DB schema exports group into these logical areas:

- instance and auth:
  - `authUsers`
  - `authSessions`
  - `authAccounts`
  - `authVerifications`
  - `instanceUserRoles`
- company and access:
  - `companies`
  - `companyMemberships`
  - `principalPermissionGrants`
  - `invites`
  - `joinRequests`
- agents and runtime:
  - `agents`
  - `agentConfigRevisions`
  - `agentApiKeys`
  - `agentRuntimeState`
  - `agentTaskSessions`
  - `agentWakeupRequests`
- planning and execution:
  - `goals`
  - `projects`
  - `projectGoals`
  - `projectWorkspaces`
  - `projectMilestones`
  - `issues`
  - `issueLabels`
  - `issueApprovals`
  - `issueComments`
  - `issueReadStates`
  - `workspaceCheckouts`
- execution telemetry:
  - `heartbeatRuns`
  - `heartbeatRunEvents`
  - `costEvents`
  - `activityLog`
- durable records:
  - `records`
  - `recordLinks`
  - `recordAttachments`
  - `briefingViewStates`
  - `briefingSchedules`
  - `knowledgeEntries`
- storage and attachments:
  - `assets`
  - `issueAttachments`
- secrets:
  - `companySecrets`
  - `companySecretVersions`

## 6. Filesystem and Instance Layout

The local instance layout under `<paperclipHome>/instances/<instance-id>/` is part of the infrastructure.

Important default locations:

- embedded DB:
  - `~/.paperclip/instances/default/db`
- storage:
  - `~/.paperclip/instances/default/data/storage`
- database backups:
  - `~/.paperclip/instances/default/data/backups`
- secrets master key:
  - `~/.paperclip/instances/default/secrets/master.key`
- fallback agent workspaces:
  - `~/.paperclip/instances/default/workspaces/<agent-id>`
- launch history:
  - `<paperclipHome>/instances/<instance-id>/logs/launch-history.jsonl`
- plugins, when that system lands later:
  - planned under the same instance root

Repo checkout state that points at one of those instances lives at:

- `.paperclip/local-start.json`

These paths are resolved through `server/src/home-paths.ts`, `server/src/paths.ts`, the CLI home/config helpers, and `scripts/startup-context.mjs`.

## 7. Server Infrastructure

### Express assembly

`server/src/app.ts` assembles the HTTP stack:

- JSON parsing
- HTTP logging middleware
- private-hostname guard
- actor resolution middleware
- board mutation guard
- route modules
- UI static or Vite middleware
- error handler

### Middleware responsibilities

Key middleware layers:

- `actorMiddleware`
  - resolves whether the caller is the board or an agent
- `privateHostnameGuard`
  - enforces private-hostname access in authenticated/private mode
- `boardMutationGuard`
  - blocks board-origin mutations that violate deployment expectations
- `validate`
  - applies shared Zod schemas to request payloads
- `errorHandler`
  - normalizes API error responses

### Route infrastructure

Major route families:

- health
- companies
- access and onboarding
- agents
- issues
- goals / roadmap
- projects
- approvals
- records and knowledge
- costs
- activity
- dashboard
- assets
- secrets
- sidebar badges
- model listing

The route layer is intentionally thin by design, even if some route files are currently too large. It validates, scopes, authorizes, then delegates to services.

### Service infrastructure

The service layer owns most of the cross-entity behavior:

- `agentService`
- `issueService`
- `projectService`
- `recordService`
- `heartbeatService`
- `approvalService`
- `costService`
- `knowledgeService`
- `secretService`
- `subsystemHealthService`

These services are where company scoping, orchestration, and invariants converge.

## 8. Auth and Access Infrastructure

Paperclip currently supports two board-access models and one agent-access model.

### Board access in `local_trusted`

- there is no external login flow
- the server bootstraps a local board principal
- board requests are treated as trusted local operator traffic

The local board bootstrap logic ensures:

- an auth user exists
- the user has instance-admin role
- the user is a member of every company

### Board access in `authenticated`

Authenticated mode uses Better Auth infrastructure:

- session routes are mounted under `/api/auth/*`
- Better Auth session resolution is used both for normal HTTP requests and websocket upgrades
- public deployments require explicit trusted origins and public base URL configuration

### Agent access

Agents authenticate with bearer API keys:

- plaintext shown once at creation
- hashes stored in `agent_api_keys`
- last-use timestamps updated on use
- company boundary checked during request and websocket authorization

### Company-scoped access model

Infrastructure-level access checks enforce:

- all business data belongs to a company
- cross-company agent access is forbidden
- board users need either company membership or instance-admin authority in authenticated mode

## 9. Secrets Infrastructure

Secrets are first-class infrastructure, not just config strings.

### Provider model

The secret provider registry currently exposes:

- `local_encrypted`
- stubbed external providers for:
  - AWS Secrets Manager
  - GCP Secret Manager
  - Vault

### Secret storage model

Paperclip stores:

- secret metadata in `company_secrets`
- versioned secret material references in `company_secret_versions`

The provider handles actual create/resolve behavior for each version.

### Agent env normalization

`server/src/services/secrets.ts` normalizes adapter env config before persistence:

- enforces valid env-key names
- supports plain bindings and secret refs
- optionally enforces strict mode for sensitive keys
- resolves secret refs during runtime use

### Strict mode

When secrets strict mode is enabled:

- sensitive keys such as API keys and tokens cannot be saved as inline plain strings
- secret references must be used instead

## 10. Storage Infrastructure

Storage is provider-backed and selected by config.

### Providers

- `local_disk`
  - default in dev
  - stores files under the Paperclip instance data directory
- `s3`
  - S3-compatible object storage
  - configurable bucket, region, endpoint, prefix, and path-style behavior

### Service shape

The storage stack is:

1. `server/src/storage/provider-registry.ts`
   - chooses the provider from config
2. `server/src/storage/service.ts`
   - exposes a stable service API to the rest of the server
3. routes such as `/assets/files`
   - call the storage service instead of touching provider details directly

### Current storage uses

The storage provider currently backs:

- generic file uploads
- asset attachments
- issue attachments through asset indirection
- any other future durable file references

## 11. Adapter and Execution Infrastructure

Agent execution is registry-based.

### Server adapter registry

`server/src/adapters/registry.ts` maps adapter types to modules. Current built-ins:

- `claude_local`
- `codex_local`
- `cursor`
- `opencode_local`
- `pi_local`
- `openclaw_gateway`
- `process`
- `http`

Each adapter may expose:

- `execute`
- `testEnvironment`
- `sessionCodec`
- static model list or dynamic model discovery
- agent configuration docs

### Local adapters

Local adapters run tools directly on the host machine and can support:

- environment testing
- resumable sessions through session codecs
- local agent JWT support

### Gateway adapter

`openclaw_gateway` is the main external/gateway-style adapter in the current tree.

### Runtime orchestrator

`heartbeatService` is the runtime orchestrator. It handles:

- wakeup queueing
- timer ticks
- on-demand wakes
- workspace resolution
- lockfile-aware checkout bootstrap for repo-backed local runs
- run creation and status changes
- adapter invocation
- structured run-event persistence
- review-submission metadata persistence onto active checkout rows
- log/event publishing
- orphan-run reaping

### Repo-backed local execution contract

When the resolved working directory is an isolated repo checkout:

- Paperclip detects the checkout package manager from the lockfile before invoking the local adapter
- bootstrap state is cached on `workspace_checkouts.metadata.workspaceBootstrap`
- local adapters receive checkout env including cwd, checkout id, branch, repo URL, and repo ref
- review handoff metadata from issue updates persists back onto the active checkout row so the reviewer can recover the exact branch/PR context

## 12. Realtime Infrastructure

Realtime updates are implemented inside the main server process.

### Event bus

`server/src/services/live-events.ts` uses an in-process `EventEmitter` keyed by company ID.

Event producers include:

- activity logging
- heartbeat status changes
- other mutation paths that need UI updates

### Websocket server

`server/src/realtime/live-events-ws.ts` attaches a websocket upgrade handler to the main HTTP server.

Important characteristics:

- websocket endpoint is company-scoped
- board connections may use session auth
- agent connections may use bearer API keys
- heartbeat pings keep connections healthy
- each socket subscribes only to its company event stream

### UI consumer

The browser consumes live events through `ui/src/context/LiveUpdatesProvider.tsx`.

That provider:

- opens the websocket
- listens for `LiveEvent` payloads
- invalidates query caches
- emits operator toasts for important activity

## 13. Scheduler and Automation Infrastructure

Three independent timer-driven loops currently exist in the main server process.

### Heartbeat scheduler

Controlled by:

- `HEARTBEAT_SCHEDULER_ENABLED`
- `HEARTBEAT_SCHEDULER_INTERVAL_MS`

Default cadence:

- every `30000ms`

Responsibilities:

- enqueue due agent wakeups
- periodically reap orphaned runs

### Briefing scheduler

Controlled by:

- `BRIEFING_SCHEDULER_ENABLED`
- `BRIEFING_SCHEDULER_INTERVAL_MS`

Default cadence:

- every `60000ms`

Responsibilities:

- generate due briefing records
- auto-publish eligible briefing outputs to knowledge
- log those system-driven publications

### Database backup scheduler

Controlled by DB backup config and env vars.

Default cadence:

- every `60` minutes

Responsibilities:

- run one-off backup job
- prune expired backups
- prevent overlapping backup runs

## 14. Health and Observability Infrastructure

### Health endpoints

- `/api/health`
  - lightweight bootstrap and deployment health
- `/api/health/subsystems`
  - deeper subsystem diagnostics

### Subsystem diagnostics

`server/src/services/subsystem-health.ts` checks:

- database connectivity and migration readiness
- deployment/auth/bootstrap readiness
- `qmd` availability on PATH
- local adapter environment readiness for first-party runtimes

Each subsystem check returns normalized fields:

- `status`
- `summary`
- `detail`
- `hint`
- `blocking`
- `testedAt`

### Other observability channels

- activity log persisted to DB
- heartbeat run events persisted to DB
- server logs through the logger middleware and services
- CLI doctor diagnostics for environment setup

## 15. UI Infrastructure

The UI is a React application that is tightly coupled to the REST and websocket surfaces, but it remains a separate runtime boundary from the server.

### Routing

`ui/src/App.tsx` defines:

- company-prefixed routes
- redirects from unprefixed routes
- auth gating in authenticated mode
- onboarding behavior when no companies exist

### Data access

`ui/src/api/client.ts` provides a single `/api`-based fetch wrapper that:

- uses `credentials: include` for board sessions
- throws normalized `ApiError` instances
- is wrapped by domain-specific API modules

### Shared UI infrastructure

Main UI infrastructure layers include:

- React Query for server-state caching
- company selection context
- breadcrumb, dialog, sidebar, panel, toast, and theme contexts
- live updates provider for websocket-fed invalidation

### Adapter-aware UI

The UI has its own adapter registry so the same adapter types can render:

- configuration forms
- run transcripts
- adapter-specific labels and metadata

## 16. CLI Infrastructure

The CLI is both a local operator tool and a client for the control plane API.

### Main command families

- `onboard`
- `doctor`
- `configure`
- `env`
- `db:backup`
- `allowed-hostname`
- `run`
- `heartbeat run`
- client commands for:
  - companies
  - issues
  - agents
  - approvals
  - activity
  - dashboard
  - context profiles

### Key operational workflows

- `paperclipai run`
  - bootstrap local instance directories
  - run onboarding if config is missing
  - run doctor checks
  - import and start the server
- `paperclipai doctor`
  - validates config, auth mode, JWT secret, secrets, storage, database, LLM access, logs, and port availability
- `paperclipai auth bootstrap-ceo`
  - creates the first instance-admin invite URL in authenticated mode

## 17. Test Infrastructure

The repo has first-party test coverage across:

- server route behavior
- server services
- adapter behavior
- UI components
- CLI configuration and command logic

Particularly infrastructure-relevant tests cover:

- health and subsystem routes
- adapter environment checks
- storage providers
- websocket and live-event behavior indirectly through consumers
- secrets and JWT env behavior
- issue and approval governance paths

## 18. Operational Truths

The most important infrastructure truths to keep in mind are:

- the server process is the control-plane brain; there is no separate worker fleet yet
- the same server process owns API, schedulers, and websocket upgrades
- embedded PostgreSQL is the default local runtime, not a throwaway mock
- storage, secrets, and adapters are all provider/registry driven
- the UI and CLI are clients of the same `/api` contract
- company scope is the primary boundary that every infrastructure layer must preserve
