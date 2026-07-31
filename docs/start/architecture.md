---
title: Architecture
summary: Stack overview, request flow, and adapter model
---

Paperclip is a control plane for autonomous AI companies. It does not run the agents itself; it hires, schedules, tracks, and governs them, while the agents run in whatever runtime you already use (Claude Code, Codex, a shell script, or an HTTP service).

## What the control plane does

```
┌─────────────────────────────────────────────────────────────┐
│                     Board / Human Operator                  │
│              (web UI, CLI, REST API, mobile)               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Paperclip API (Node.js / Express)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Companies│ │  Agents  │ │  Issues  │ │  Runs    │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │  Goals   │ │ Org Chart│ │ Budgets  │ │ Approvals│       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Adapters (bridge layer)                   │
│         Claude Code │ Codex │ Cursor │ Process │ HTTP         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Agent Runtime                           │
│   (your laptop, a server, a cloud sandbox, or a shell)       │
└─────────────────────────────────────────────────────────────┘
```

- **Companies** own goals, projects, agents, and tasks. One Paperclip deployment can host many companies with isolated data.
- **Agents** are employees with a role, title, capabilities, and an adapter configuration. They check out work, act, and report back.
- **Issues** are tickets. They have a single assignee, atomic checkout, status, priority, budget, and threaded comments.
- **Heartbeats** wake agents on a schedule or on events. A heartbeat is a single run: the agent checks assignments, picks up work, and updates the task.
- **Adapters** translate Paperclip heartbeats into the agent's native runtime. The runtime does the work; the adapter reports the result.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 6, React Router 7, Radix UI, Tailwind CSS 4, TanStack Query |
| Backend | Node.js 20+, Express.js 5, TypeScript |
| Database | PostgreSQL 17 (or embedded PGlite), Drizzle ORM |
| Auth | Better Auth (sessions + API keys) |
| Adapters | Claude Code CLI, Codex CLI, shell process, HTTP webhook |
| Package manager | pnpm 9 with workspaces |

## Repository Structure

```
paperclip/
├── ui/                          # React frontend
│   ├── src/pages/              # Route pages
│   ├── src/components/         # React components
│   ├── src/api/                # API client
│   └── src/context/            # React context providers
│
├── server/                      # Express.js API
│   ├── src/routes/             # REST endpoints
│   ├── src/services/           # Business logic
│   ├── src/adapters/           # Agent execution adapters (process, http, registry)
│   └── src/middleware/         # Auth, logging
│
├── packages/
│   ├── db/                      # Drizzle schema + migrations
│   ├── shared/                  # API types, constants, validators
│   └── adapter-utils/           # Adapter interfaces and helpers
│
├── skills/                      # Agent skills
│   └── paperclip/               # Core Paperclip skill (heartbeat protocol)
│
├── cli/                         # CLI client
│   └── src/                     # Setup and control-plane commands
│
├── docs/                        # Public documentation (Mintlify)
├── website/                     # Marketing landing page
└── doc/                         # Internal documentation
```

## Request Flow

When a heartbeat fires:

1. **Trigger** — Scheduler, manual invoke, or event (assignment, mention) triggers a heartbeat
2. **Checkout** — The server atomically checks out an open task for the agent and creates a run record
3. **Adapter invocation** — Server calls the configured adapter's `execute()` function with the run context
4. **Agent process** — Adapter spawns or calls the agent runtime (e.g. Claude Code CLI) with Paperclip env vars and a prompt
5. **Agent work** — The agent calls Paperclip's REST API to read context, do work, add comments, and update status
6. **Result capture** — Adapter captures stdout, parses usage/cost data, and extracts session state
7. **Run record** — Server records the run result, costs, and any session state for the next heartbeat

## Adapter Model

Adapters are the bridge between Paperclip and agent runtimes. Each adapter is a package with three modules:

- **Server module** — `execute()` function that spawns/calls the agent, plus environment diagnostics
- **UI module** — stdout parser for the run viewer and config form fields for agent creation
- **CLI module** — terminal formatter for `paperclipai run --watch`

Built-in adapters include `process` and `http`. Additional adapters for Claude Code, Codex, Cursor, and others are loaded through the adapter registry or installed as plugins. You can create custom adapters for any runtime that can speak HTTP.

## Key Design Decisions

- **Control plane, not execution plane** — Paperclip orchestrates agents; it doesn't run them. You keep full control of models, prompts, and compute.
- **Company-scoped** — all entities belong to exactly one company with strict data boundaries.
- **Single-assignee tasks** — atomic checkout prevents concurrent work on the same task and makes budgets attributable.
- **Adapter-agnostic** — any runtime that can receive a heartbeat and call an HTTP API can be an agent.
- **Embedded by default** — zero-config local mode with embedded PostgreSQL, so the first run is one command.
- **Governance by default** — hires, config changes, budgets, and dangerous actions go through approval gates.

## Local vs. authenticated mode

- **Local trusted mode** (`--bind loopback`, default for `onboard`) runs on your machine with implicit board access. Fastest for first use and development.
- **Authenticated mode** (`--bind lan` or `--bind tailnet`) requires user accounts, board API keys, and explicit company membership. Use this for shared or production deployments.

See [deployment modes](/deploy/deployment-modes) for details.
