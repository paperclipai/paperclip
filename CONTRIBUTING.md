# Contributing to Paperclip

Thanks for your interest in contributing. Paperclip is an open-source orchestration platform for multi-agent companies — contributions that improve reliability, extend the adapter ecosystem, or sharpen the developer experience are most welcome.

## Before You Start

- **Bug fixes, docs, and targeted enhancements** — open a PR directly.
- **New features** — check [`ROADMAP.md`](ROADMAP.md) first, then discuss in [Discord `#dev`](https://discord.gg/paperclipai) before building. Uncoordinated feature PRs may be closed.
- **New agent adapters** — welcome without prior discussion; follow the existing adapter pattern in `server/adapters/`.
- **Core architectural changes** — always discuss first.

Prefer extending Paperclip via the **plugin system** (`adapter-plugin.md`) over modifying core directly when possible.

---

## Setup

**Prerequisites:** Node.js 20+, pnpm 9.15+

```sh
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

- API server: `http://localhost:3100`
- UI: served by the API server at the same origin in dev mode

No database configuration needed — an embedded PostgreSQL instance starts automatically and persists at `~/.paperclip/instances/default/db`.

**Useful dev commands:**

```sh
pnpm dev:list          # list running dev processes
pnpm dev:stop          # stop dev processes
pnpm dev:once          # run once without file watching (applies pending migrations)
pnpm storybook         # UI component explorer on port 6006
```

**Reset the dev database:**

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

**Worktree-isolated instances** (recommended for PR work):

```sh
paperclipai worktree init
pnpm paperclipai worktree:make paperclip-pr-<number>
```

---

## Making Changes

### Branch naming

Use descriptive branch names tied to the change:

```
fix/heartbeat-status-filter
feat/ollama-adapter
docs/contributing-guide
chore/lockfile-refresh
```

### Commit style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(adapters): add ollama-local adapter
fix(heartbeat): respect status filter in heartbeat-runs query
docs: expand contributing guide
chore(lockfile): refresh pnpm-lock.yaml
```

### Lockfile policy

**Do not commit `pnpm-lock.yaml`** in your PR. GitHub Actions regenerates it automatically on merge to `master`.

### Keeping contracts in sync

If your change touches any of these layers, update **all** of them together:

- `packages/db` — database schema and migrations
- `packages/shared` — shared types
- `server` — API routes and business logic
- `ui` — React frontend

---

## Testing

Run the full pre-PR check suite before opening a PR:

```sh
pnpm -r typecheck    # TypeScript type checks across all packages
pnpm test:run        # Vitest unit tests (non-watch)
pnpm build           # production build
```

For end-to-end tests:

```sh
pnpm test:e2e        # Playwright browser suite
```

For interactive development:

```sh
pnpm test:watch      # Vitest in watch mode
```

---

## Opening a Pull Request

All PRs must use the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Every section is required — do not delete sections.

Key sections:

| Section | What to write |
|---|---|
| **Thinking Path** | Trace your reasoning from Paperclip's core purpose down to this specific change |
| **What Changed** | Concrete bullet list of what you modified |
| **Verification** | Commands or manual steps a reviewer can use to confirm it works |
| **Risks** | What could go wrong; what you ruled out |
| **Model Used** | AI model that assisted (provider + exact model ID), or `None — human-authored` |
| **Roadmap Integration** | Note whether this aligns with `ROADMAP.md`; required for feature PRs |

---

## Contribution Paths

### Path 1 — Small, focused change

1. Pick one clear fix or improvement
2. Touch the minimal set of files needed
3. Pass `pnpm -r typecheck && pnpm test:run && pnpm build`
4. Open a PR using the full template

### Path 2 — Larger feature or refactor

1. Discuss in Discord `#dev` and align with `ROADMAP.md`
2. Build with before/after documentation
3. Include manual testing notes and, where applicable, screenshots
4. Open a PR using the full template

---

## Repo Structure

```
cli/          CLI tool (paperclipai)
server/       Backend API and agent adapters
ui/           React frontend
packages/     Shared monorepo packages (db, shared, etc.)
skills/       Reusable agent capability definitions
tests/        Test suites
doc/          Developer documentation (see doc/DEVELOPING.md)
docs/         User-facing documentation
docker/       Dockerfiles and Compose configs
evals/        Evaluation harnesses
```

---

## Health Check

Verify your local instance is running correctly:

```sh
curl http://localhost:3100/api/health    # {"status":"ok"}
curl http://localhost:3100/api/companies # JSON array of companies
```

---

## Good First Issues

Look for issues tagged [`good first issue`](https://github.com/paperclipai/paperclip/issues?q=is%3Aopen+label%3A%22good+first+issue%22) on GitHub. Well-scoped bugs with clear reproduction steps are the fastest way to get familiar with the codebase.

---

## Community

- **Discord:** primary place for design discussion and questions
- **GitHub Issues:** bug reports and well-specified proposals
- **GitHub Discussions:** open-ended questions and ideas

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
