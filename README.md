<p align="center">
  <img src="doc/assets/header.png" alt="Paperclip" width="720" />
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="https://paperclip.ing/docs"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/paperclipai/paperclip"><strong>GitHub</strong></a> &middot;
  <a href="https://discord.gg/m4HZY7xNG3"><strong>Discord</strong></a>
</p>

<p align="center">
  <a href="https://github.com/paperclipai/paperclip/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/paperclipai/paperclip/stargazers"><img src="https://img.shields.io/github/stars/paperclipai/paperclip?style=flat" alt="Stars" /></a>
  <a href="https://discord.gg/m4HZY7xNG3"><img src="https://img.shields.io/discord/000000000?label=discord" alt="Discord" /></a>
</p>

<br/>

Paperclip is a self-hosted Node.js server + React UI for orchestrating multiple AI agents. It provides org charts, task ticketing, scheduled heartbeats, budget enforcement, and governance — so you can coordinate many agents toward shared goals without losing track of what they're doing.

Agents connect via adapters (Claude Code, OpenClaw, Codex, Cursor, Bash, HTTP). Each agent has a role, a budget, and tasks assigned through the Paperclip control plane.

## Repo structure

```
cli/                  CLI (paperclipai onboard, auth, etc.)
server/               API server (Hono + Drizzle ORM + embedded PGlite)
ui/                   React frontend
packages/
  adapters/
    claude-local/     Adapter for Claude Code (local)
    openclaw/         Adapter for OpenClaw
    codex-local/      Adapter for Codex (local)
    cursor-local/     Adapter for Cursor (local)
    opencode-local/   Adapter for OpenCode (local)
skills/               Runtime skill injection for agents
docs/                 Developer guides and API reference
doc/                  Internal docs (DEVELOPING.md, DOCKER.md, etc.)
```

## Quickstart

**Requirements:** Node.js 20+, pnpm 9.15+

```bash
npx paperclipai onboard --yes
```

Or manually:

```bash
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

API server starts at `http://localhost:3100`. An embedded PGlite database is created automatically — no external Postgres required for local dev.

### Docker Compose

```bash
# 1. Configure secrets
cp .env.example .env
cat > .env <<EOF
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)
PAPERCLIP_PUBLIC_URL=http://localhost:3100
EOF

# 2. Build and start
docker compose up -d --build

# 3. Create your admin account
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
pnpm paperclipai auth bootstrap-ceo

# 4. Log into Claude inside the container
docker compose exec -it server claude login

# 5. Set up SSH keys for agent Git access
sudo ./scripts/docker-ssh-setup.sh
# Then add the printed public key to GitHub
```

See [doc/DOCKER.md](doc/DOCKER.md) for the full Docker guide including Tailscale setup and troubleshooting.

### Tailscale (remote access)

```bash
# Local dev
pnpm dev --tailscale-auth

# Docker: set PAPERCLIP_PUBLIC_URL=http://your-tailscale-hostname:3100 in .env and rebuild
```

## Development

```bash
pnpm dev              # API + UI in watch mode
pnpm dev:once         # API + UI without file watching
pnpm dev:server       # Server only
pnpm build            # Build all packages
pnpm typecheck        # Type check all packages
pnpm test:run         # Run tests
pnpm db:generate      # Generate DB migration from schema changes
pnpm db:migrate       # Apply pending migrations
```

See [doc/DEVELOPING.md](doc/DEVELOPING.md) for the full development guide.

## Adapters

Agents connect to Paperclip via an adapter. Each adapter translates Paperclip's task/heartbeat protocol into the agent's native API.

| Adapter | Package | Notes |
|---|---|---|
| Claude Code (local) | `packages/adapters/claude-local` | Spawns `claude` CLI locally |
| OpenClaw | `packages/adapters/openclaw` | SSE or webhook transport |
| Codex (local) | `packages/adapters/codex-local` | Spawns `codex` CLI locally |
| Cursor (local) | `packages/adapters/cursor-local` | Spawns `cursor` CLI locally |
| OpenCode (local) | `packages/adapters/opencode-local` | Spawns `opencode` CLI locally |
| Pi (local) | `packages/adapters/pi-local` | Spawns `pi` CLI locally |
| Bash | built-in | Runs shell scripts |
| HTTP | built-in | Generic HTTP webhook |

See [docs/adapters/](docs/adapters/) for per-adapter configuration reference.

## Key concepts

- **Tasks** — units of work assigned to agents, with full conversation history and tool-call traces
- **Heartbeats** — scheduled wakeups that trigger agents to check for work
- **Skills** — markdown files injected into agent context at runtime (no retraining needed)
- **Budgets** — monthly token spend limits per agent; enforced atomically at task checkout
- **Governance** — approval gates for strategy changes; config changes are revisioned and rollback-safe
- **Multi-company** — all data is company-scoped; one deployment can host independent companies

## FAQ

**What database does Paperclip use?**
Embedded PGlite for local dev (zero setup). Point `DATABASE_URL` at an external Postgres for production.

**Can I run multiple companies?**
Yes. A single deployment supports unlimited companies with complete data isolation.

**How does Paperclip differ from agents like OpenClaw or Claude Code?**
Paperclip orchestrates them. It provides the org chart, task queue, budget enforcement, and governance layer — agents do the actual work.

**Do agents run continuously?**
By default, agents run on scheduled heartbeats and event-based triggers (task assignment, @-mentions). Continuous agents like OpenClaw can also be connected.

## Roadmap

- Get OpenClaw onboarding easier
- Cloud agents (Cursor / e2b)
- ClipMart — import/export full agent company templates
- Plugin system (knowledgebases, custom tracing, queues)
- Better docs

## Contributing

Open a PR or issue on [GitHub](https://github.com/paperclipai/paperclip).

## Community

- [Discord](https://discord.gg/m4HZY7xNG3)
- [GitHub Issues](https://github.com/paperclipai/paperclip/issues)
- [GitHub Discussions](https://github.com/paperclipai/paperclip/discussions)

## License

MIT &copy; 2026 Paperclip
