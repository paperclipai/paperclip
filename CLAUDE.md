# Paperclip

Paperclip is an open-source orchestration platform for autonomous AI companies. It manages AI agents, LLM adapters, plugins, and human oversight in a unified system.

## Project Structure

This is a **pnpm monorepo** (pnpm 9.15.4, Node 20+, TypeScript 5.7, ESM-only).

```
server/          → Express 5 backend (port 3100)
ui/              → React 19 + Vite frontend (port 5173)
cli/             → CLI tool (Commander + esbuild)
packages/
  shared/        → Shared types & Zod schemas
  db/            → Drizzle ORM + PostgreSQL (embedded PG for local dev)
  adapter-utils/ → Common adapter utilities
  adapters/      → LLM adapters (claude-local, codex-local, cursor-local, etc.)
  plugins/       → Plugin SDK, scaffolding tool, examples
skills/          → Pre-built agent skill collections
docs/            → Mintlify documentation (adapters, API, CLI, deploy, companies, specs)
tests/           → Playwright E2E tests
scripts/         → Build, dev, release scripts
```

## Key References

- @AGENTS.md — Agent configuration, roles, and orchestration rules
- @CONTRIBUTING.md — Contribution guidelines and PR process
- `docs/` — Full Mintlify documentation covering:
  - `docs/adapters/` — LLM adapter docs
  - `docs/api/` — API reference
  - `docs/cli/` — CLI usage
  - `docs/companies/` — Agent company specs
  - `docs/agents-runtime.md` — Agent runtime behavior
  - `docs/specs/` — System specifications
  - `docs/deploy/` — Deployment guides
  - `docs/guides/` — How-to guides

## Common Commands

```bash
pnpm dev              # Start dev environment (watch mode)
pnpm dev:server       # Server only
pnpm dev:ui           # UI only (Vite dev server)
pnpm build            # Build all packages
pnpm typecheck        # Type-check all packages
pnpm test             # Vitest (watch mode)
pnpm test:run         # Vitest (single run)
pnpm test:e2e         # Playwright E2E tests
pnpm db:generate      # Generate Drizzle migrations
pnpm db:migrate       # Run pending migrations
```

## Tech Stack

- **Backend:** Express 5, PostgreSQL, Drizzle ORM, Better Auth, Pino logging, WebSockets
- **Frontend:** React 19, Vite 6, Tailwind CSS 4, Radix UI, TanStack Query, React Router
- **CLI:** Commander, esbuild bundling
- **Testing:** Vitest, Playwright, Supertest
- **Validation:** Zod schemas throughout

## Code Conventions

- TypeScript strict mode everywhere
- ES2023 target, NodeNext module resolution
- Adapters export `./server`, `./ui`, `./cli` entry points
- Database schema in `packages/db/src/schema/`
- UI path alias: `@/` → `./src/`
- All packages output to `dist/`

## Contributing

See @CONTRIBUTING.md for full details. Key points:

- **Small changes:** One clear fix, minimal files, all checks pass → fast merge
- **Bigger changes:** Discuss in Discord #dev first, include screenshots/before-after, address all review comments
- **PR messages:** Include a "thinking path" that explains from the top of the project down to what you fixed:
  > - Paperclip orchestrates ai-agents for zero-human companies
  > - [context about the area you're changing]
  > - [what the problem/need is]
  > - [what this PR does]
  > - [why it matters]
- One PR = one logical change
- Run tests locally before submitting
- Write clear commit messages
- All automated checks must pass (including Greptile comments)
