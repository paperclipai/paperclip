# Contributing to `@paperclipai/server`

This document covers the development workflow for the Paperclip server package (`server/`). For overall Paperclip contributing guidelines, see the [root CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

- **Node.js** >= 20 (CI uses 24)
- **pnpm** 9.15.4 (enabled via Corepack: `corepack enable && corepack install`)
- **PostgreSQL 17** (optional — the server can run with embedded PostgreSQL)

## Setup

```bash
# From the repository root
corepack enable && corepack install
pnpm install
```

This installs all workspace dependencies, including the server and its sibling packages (`@paperclipai/db`, `@paperclipai/shared`, all adapter packages).

## Configuration

The server loads configuration from:

1. **Config file** — `~/.paperclip/instances/default/config.json` (or `$PAPERCLIP_CONFIG`)
2. **Environment files** — `.env` next to the config file, then `.env` in `server/`
3. **Environment variables**

Minimal `.env` for the server:

```env
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
PORT=3100
SERVE_UI=false
BETTER_AUTH_SECRET=paperclip-dev-secret
```

Without `DATABASE_URL`, the server starts an **embedded PostgreSQL** instance automatically (data directory: `~/.paperclip/embedded-postgres/`, port: 54329). This is the simplest way to get started.

## Running the Server

### Development mode (hot-reload)

```bash
# From repository root:
pnpm dev:server

# From server/ directory:
pnpm dev          # runs tsx src/index.ts
pnpm dev:watch    # tsx watch with smart ignore paths via scripts/dev-watch.ts
```

`dev:watch` uses `tsx watch` with exclusion patterns to avoid restarting on irrelevant file changes.

The server auto-applies pending database migrations on startup when `PAPERCLIP_MIGRATION_AUTO_APPLY=true` is set (default in dev mode).

### Production mode

```bash
pnpm build
node dist/index.js
```

### Docker

```bash
# Full setup (external PostgreSQL):
docker compose -f docker/docker-compose.yml up

# Quickstart (embedded PostgreSQL, no external DB):
docker compose -f docker/docker-compose.quickstart.yml up
```

## Project Architecture

```
server/src/
├── __tests__/       # Vitest test files (238+ tests)
│   ├── helpers/     # Shared test utilities (embedded-postgres builder, etc.)
│   ├── fixtures/    # Test fixture data
│   └── setup-supertest.ts
├── adapters/        # External adapter integrations (Claude, Codex, Cursor, Gemini, etc.)
├── auth/            # Authentication (BetterAuth integration)
├── lib/             # Miscellaneous utilities
├── middleware/      # Express middleware stack
│   ├── auth.ts      # Actor resolution (board user, agent, cloud tenant)
│   ├── error-handler.ts
│   ├── logger.ts    # Pino logger
│   ├── private-hostname-guard.ts
│   └── validate.ts  # Zod schema validation
├── realtime/        # WebSocket (live events)
├── routes/          # Express route handlers (one file per domain)
│   ├── issues.ts, companies.ts, agents.ts, projects.ts, ...
│   └── index.ts     # Re-exports all route factories
├── secrets/         # Secret providers (local encrypted, AWS Secrets Manager)
├── services/        # Business logic layer (one file per domain)
│   ├── issues.ts, companies.ts, agents.ts, heartbeat.ts, ...
│   └── index.ts     # Re-exports all service factories
├── storage/         # Storage backends (local disk, S3)
├── types/           # TypeScript type augmentation
├── app.ts           # Express app factory — mounts middleware + routes
├── config.ts        # Configuration loader (env, config file, .env)
├── index.ts         # Server entry point — DB init, auth setup, listen
├── errors.ts        # HTTP error classes (badRequest, notFound, conflict, etc.)
└── telemetry.ts     # Telemetry client
```

### Patterns

- **Routes** export a factory function `(db, opts?) => Router` — mounted in `app.ts` under `/api`
- **Services** are instantiated per-request or composed in route factories
- **Middleware chain** per request: `json()` → `httpLogger` → `privateHostnameGuard` → `actorMiddleware` → `boardMutationGuard` → route handler → `errorHandler`
- **Validation** uses Zod schemas with the `validate` middleware
- **Authz** helpers in `routes/authz.ts`: `assertBoard()`, `assertCompanyAccess()`, `assertInstanceAdmin()`, `getActorInfo()`

## Running Tests

The server uses **Vitest** for unit and integration tests.

```bash
# From server/ directory:
pnpm exec vitest run              # Run all server tests
pnpm exec vitest run --reporter=verbose  # Verbose output
pnpm exec vitest watch            # Watch mode

# Run a specific test file:
pnpm exec vitest run src/__tests__/issues-service.test.ts

# Run tests matching a pattern:
pnpm exec vitest run -t "checkout"
```

From the repository root:

```bash
pnpm test:run                     # Full suite with preflight checks
pnpm test:run:general             # Parallel-safe general tests
pnpm test:run:serialized          # Serialized tests (single worker)
pnpm test:watch                   # Watch mode
```

### Test conventions

- Tests live in `server/src/__tests__/` with a flat naming convention: `{module}-routes.test.ts` or `{module}-service.test.ts`
- Tests are single-threaded (1 worker, 1 fork, no concurrency) — many tests share database state
- Tests that need PostgreSQL must use `./helpers/embedded-postgres.ts` (not the `embedded-postgres` package directly) to avoid corrupting the live Paperclip Postgres

## Database Migrations

The server uses **Drizzle ORM** for schema management. Migrations live in `packages/db/src/migrations/`.

```bash
# Generate a new migration:
pnpm --filter @paperclipai/db generate

# Apply pending migrations:
pnpm --filter @paperclipai/db migrate
```

On server startup, pending migrations are detected and can be auto-applied (`PAPERCLIP_MIGRATION_AUTO_APPLY=true`) or prompted interactively.

## Making Changes

1. Ensure prerequisites are installed and the server starts in dev mode
2. Write your change following the established patterns (fat models, thin routes, services layer for orchestration)
3. Add tests for new logic — route tests for endpoints, service tests for business logic
4. Run the relevant tests before committing
5. Open a pull request against `master` using the [PR template](../.github/PULL_REQUEST_TEMPLATE.md)

### PR requirements

- Use the PR template with all required sections (Thinking Path, What Changed, Verification, Risks, Model Used, Checklist)
- All tests must pass and CI must be green
- Greptile code review score must be 5/5 with all comments addressed
- One logical change per PR

## Additional Resources

- [Root CONTRIBUTING.md](../CONTRIBUTING.md) — general Paperclip contribution guidelines
- [Test README](src/__tests__/README.md) — server test conventions
- `.github/PULL_REQUEST_TEMPLATE.md` — required PR template
- `ROADMAP.md` — project roadmap
