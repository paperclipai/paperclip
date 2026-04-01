# Shangrila

**ValCtrl's internal AI agent orchestration platform** — a customized fork of [Paperclip](https://github.com/paperclipai/paperclip).

Named after the mythical hidden valley: a self-sustaining paradise that runs itself.

## What is this?

Shangrila orchestrates ValCtrl's AI agent workforce. It's a Node.js server and React UI that coordinates agents (Claude Code, Codex, Cursor, OpenClaw) toward business goals — with org charts, budgets, governance, and accountability.

| | Step | What happens |
|---|---|---|
| **01** | Define goals | Set the company mission and break it into projects |
| **02** | Assign agents | Each agent gets a role, budget, and reporting line |
| **03** | Run and monitor | Agents work autonomously. Review from the dashboard. |

**Live at:** [command.valctrl.com](https://command.valctrl.com)

## Quick links

| Resource | Link |
|----------|------|
| Internal docs | [`doc/SHANGRILA.md`](doc/SHANGRILA.md) |
| Upstream docs | [`doc/DEVELOPING.md`](doc/DEVELOPING.md) |
| CI/CD | [GitHub Actions](https://github.com/valctrltech/shangrila/actions) |
| Upstream repo | [paperclipai/paperclip](https://github.com/paperclipai/paperclip) |

## Architecture

```
User → Cloudflare (HTTPS) → Cloudflare Tunnel → EC2:3100 (Shangrila)
```

- **Runtime:** Bare Node.js + systemd on AWS EC2
- **Database:** Embedded PostgreSQL (PGlite)
- **Auth:** Google OAuth via Better Auth
- **Access:** Tailscale SSH (`ssh commandorg`)
- **CI:** GitHub Actions (typecheck, test, build, Docker smoke)
- **CD:** Self-hosted runner on EC2, auto-deploys on CI success

## Local development

```bash
git clone https://github.com/valctrltech/shangrila.git
cd shangrila
git remote add upstream https://github.com/paperclipai/paperclip.git
pnpm install
pnpm dev
```

API + UI at `http://localhost:3100`. Embedded database — no setup required.

> **Requirements:** Node.js 20+, pnpm 9.15+

## Commands

```bash
pnpm dev              # Full dev (API + UI, watch mode)
pnpm dev:once         # Full dev without file watching
pnpm build            # Build all packages
pnpm -r typecheck     # Type checking
pnpm test:run         # Run tests
```

## Git workflow

| Branch | Purpose |
|--------|---------|
| `master` | Mirror of upstream Paperclip. Never commit directly. |
| `shangrila/main` | **Default.** All ValCtrl work goes here. |
| `shangrila/feat-*` | Feature branches, merged into `shangrila/main`. |

See [`doc/SHANGRILA.md`](doc/SHANGRILA.md) for upstream sync workflow, deployment details, and operational runbooks.

## Agents supported

| Agent | Type |
|-------|------|
| Claude Code | Local CLI |
| Codex | Local CLI |
| Cursor | IDE adapter |
| OpenClaw | Gateway |
| Gemini | Local CLI |
| Bash / HTTP | Generic |

## License

MIT — forked from [Paperclip](https://github.com/paperclipai/paperclip).
