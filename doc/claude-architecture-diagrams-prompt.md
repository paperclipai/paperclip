# Claude Prompt: Generate Paperclip Architecture Diagrams

Use the following prompt with Claude (or any capable LLM) to generate Mermaid.js architecture diagrams for the Paperclip control plane. Include this entire document as context, then ask the model to produce the specific diagram(s) you need.

---

## Prompt

You are an expert software architect and technical diagrammer. Your task is to generate accurate, well-structured Mermaid.js architecture diagrams for **Paperclip**, an open-source control plane for AI-agent companies.

### What is Paperclip?

Paperclip is a Node.js (Express + React) control plane that orchestrates teams of AI agents as if they were employees in a business. It is **not a chatbot, not an agent framework, and not a workflow builder**. It models companies — with org charts, goals, budgets, governance, and accountability — and allows agents from different runtimes/providers (Claude Code, Codex, Cursor, Gemini, OpenCode, etc.) to work together.

**Core analogy:** "If OpenClaw is an employee, Paperclip is the company."

### Technology Stack

| Layer | Technology |
|---|---|
| Server runtime | Node.js 20+, TypeScript |
| Web framework | Express (REST API at `/api`) |
| Database | PostgreSQL via Drizzle ORM (embedded PGlite fallback) |
| UI | React + Vite single-page application |
| Package manager | pnpm monorepo workspace |
| Auth (authenticated) | Better Auth (session-based) |
| Agent auth | Bearer API keys (hashed at rest) |
| Real-time | WebSocket (live events) |
| File storage | Local disk or S3-compatible |
| Secret provider | Local encrypted (default) or AWS Secrets Manager |
| Containerization | Docker (multi-service: server + PostgreSQL) |
| Testing | Vitest (unit/integration), Playwright (e2e) |

### Repository Structure

```
paperclip/
├── server/                     # Express REST API + orchestration services
│   ├── src/routes/             # 39 REST route files
│   ├── src/services/           # 118 business-logic service files
│   ├── src/adapters/           # Agent adapter interface + registry
│   ├── src/middleware/         # Auth, guard, validation, error handler
│   ├── src/storage/            # Local/S3 file storage providers
│   ├── src/secrets/            # Encrypted/AWS Secrets Manager providers
│   ├── src/auth/               # Better Auth integration
│   └── src/realtime/           # WebSocket live events
├── ui/                         # React + Vite board UI (SPA)
│   ├── src/pages/              # 85 page components
│   ├── src/components/         # 200+ shared components
│   ├── src/adapters/           # 32 UI-side adapter registries
│   ├── src/plugins/            # Plugin host bridge + UI loading
│   ├── src/api/                # React Query hooks for all REST endpoints
│   └── src/context/            # React context providers
├── packages/
│   ├── db/                     # Drizzle ORM schemas (86 schema files), migrations
│   ├── shared/                 # Types, validators, constants, API paths
│   ├── adapter-utils/          # Process spawning, env injection, SSH helpers
│   ├── adapters/               # 11 agent adapter packages
│   │   ├── claude-local/       # Claude Code CLI
│   │   ├── codex-local/        # OpenAI Codex CLI
│   │   ├── gemini-local/       # Gemini CLI
│   │   ├── opencode-local/     # OpenCode CLI
│   │   ├── cursor-local/       # Cursor background mode
│   │   ├── cursor-cloud/       # Cursor Cloud
│   │   ├── pi-local/           # Embedded Pi agent
│   │   ├── acpx-local/         # ACPX Claude integration
│   │   ├── grok-local/         # Grok
│   │   └── openclaw-gateway/   # OpenClaw gateway
│   ├── plugins/
│   │   ├── sdk/                # Plugin SDK (worker, UI, testing, bundlers)
│   │   ├── create-paperclip-plugin/  # Plugin starter template
│   │   ├── sandbox-providers/       # E2B, Cloudflare, Daytona, Modal, exe.dev
│   │   ├── plugin-llm-wiki/         # Reference managed-resources plugin
│   │   └── plugin-workspace-diff/   # Workspace diff viewer
│   ├── mcp-server/             # MCP server for external integrations
│   └── skills-catalog/         # Bundled skills for company skills management
├── cli/                        # `paperclipai` npm-distributable CLI
├── doc/                        # Architecture, product, development docs
└── docker/                     # Docker Compose, Dockerfile, multi-stage builds
```

### System Architecture: The 12 Subsystems

The Paperclip server is composed of 12 internal subsystems:

1. **Identity & Access** — Deployment modes (trusted local/authenticated), board users, agent API keys, short-lived run JWTs, company memberships, invite flows, OpenClaw onboarding. Every mutating request is actor-traced.

2. **Org Chart & Agents** — Agents have roles, titles, reporting lines (strict tree), permissions, and budgets. Adapter types: Claude Code, Codex, Cursor, Gemini, OpenCode, Pi, Grok, OpenClaw gateway, process, HTTP/webhook, external plugin adapters.

3. **Work & Task System** — Issues carry company/project/goal/parent links. Atomic checkout with execution locks (single-row SQL update, 409 on conflict). First-class blocker dependencies. Comments, documents, attachments, work products, labels, inbox state.

4. **Heartbeat Execution** — DB-backed wakeup queue with coalescing. Budget check → workspace resolution → secret injection → skill loading → adapter invocation. Runs produce structured logs, cost events, session state, and audit trails. Orphaned runs auto-recovered.

5. **Workspaces & Runtime** — Project workspaces (git repos), isolated execution workspaces (git worktrees, operator branches), runtime services (dev servers, preview URLs). No-remote-git contract: local worktree cwd is the only cross-run persistence boundary.

6. **Governance & Approvals** — Board approval workflows (hire agents, approve CEO strategy, budget override). Execution policies with review/approval stages. Agent pause/resume/terminate. Full audit logging.

7. **Budget & Cost Control** — Token/cost tracking by company, agent, project, goal, issue, provider, and model. Scoped budget policies with warning thresholds (80%) and hard stops (100%). Overspend pauses agents and cancels queued work.

8. **Routines & Schedules** — Recurring tasks with cron, webhook, and API triggers. Concurrency and catch-up policies. Each execution creates a tracked issue and wakes the assigned agent.

9. **Plugins** — Instance-wide plugin system. Out-of-process workers (JSON-RPC over stdio). Capability-gated host services (50+ capabilities). Job scheduling, tool exposure, UI contributions. Hot lifecycle: install/uninstall/upgrade without restart. Plugin SDK with worker SDK, UI SDK, testing harness, bundler presets, dev server.

10. **Secrets & Storage** — Instance and company secrets. Encrypted local storage. Provider-backed object storage. Attachments and work products. Sensitive values stay out of prompts unless explicitly needed.

11. **Activity & Events** — All mutating actions, heartbeat state changes, cost events, approvals, comments, and work products recorded as durable activity for audit.

12. **Company Portability** — Export/import entire organizations (agents, skills, projects, routines, issues) with secret scrubbing and collision handling. Markdown-first format: `COMPANY.md`, `agents/<slug>/AGENTS.md`, `.paperclip.yaml` sidecar.

### Deployment Model

Three deployment modes:

| Mode | Auth | Bind | Use Case |
|---|---|---|---|
| `local_trusted` | No login | loopback (localhost) | Single-operator local machine |
| `authenticated` + `private` | Login (Better Auth) | lan / tailnet / custom | Private network |
| `authenticated` + `public` | Login (Better Auth) | loopback behind proxy | Internet-facing cloud |

Database options: Embedded PGlite (auto-created at `~/.paperclip/instances/default/db/`), Docker PostgreSQL, or hosted PostgreSQL (e.g., Supabase).

Docker deployment: Two services (PostgreSQL 17 Alpine + Paperclip server), persistent volumes for pgdata and paperclip-data, multi-stage Dockerfile with pre-installed `claude` and `codex` CLIs.

### Key Data Flow: Agent Heartbeat Execution

```
1. Scheduler (cron.ts) checks agent heartbeat schedule, budget, active runs
2. If agent is due: check budget hard-stop, max concurrent runs
3. Coalesce wakeup requests from DB
4. Workspace resolution: determine project workspace, allocate execution workspace
5. Secret injection: resolve secret refs from agent config, project env, routine env
6. Skill loading: attach company/project skills for context
7. Adapter invocation: spawn process, HTTP request, or gateway call
8. Run tracking: structured logs, cost events, session state, audit trails
9. Recovery: watchdog detects orphaned runs → auto-recover or escalate
```

### Key Data Flow: Task Lifecycle

```
backlog → todo → in_progress → in_review → done
                ↘ blocked → (resolved) → in_progress → ...
```

- Atomic checkout: `POST /api/issues/:id/checkout` — single-row SQL update with status + assignee guard, returns 409 on conflict
- Every mutation writes to `activity_log`
- Liveness watchdog ensures every non-terminal issue has a live execution path

### Key Data Flow: Cost & Budget

```
1. Agent reports cost events via POST /api/companies/:id/cost-events
2. Rollups aggregated by agent/project/goal/company (read-time for V1)
3. Soft alert at 80% budget, hard stop at 100%
4. Agent auto-paused, new invocations blocked
```

### Key Data Flow: Plugin System

```
1. Operator installs plugin via CLI/UI → npm package resolved
2. Manifest validated → worker process spawned (out-of-process)
3. JSON-RPC over stdio between host and worker
4. Worker can: subscribe to events, register jobs, handle webhooks,
   expose UI, contribute tools, manage entities, use plugin DB namespace
5. UI bridge: hooks communicate with worker via host
6. Capability-gated: every host API call validated against manifest capabilities
```

### Key Architectural Invariants

1. **Single-assignee task model** — at most one assignee per issue
2. **Atomic checkout** — SQL-level atomic with status + assignee guard
3. **Company-scoped visibility** — all work objects visible to board and in-company agents
4. **Budget hard-stop** — 100% spend auto-pauses agent, blocks new invocations
5. **Approval gates** — hiring and CEO strategy require board approval
6. **Activity logging** — every mutation writes to `activity_log`
7. **No-remote-git contract** — local workspace cwd is the only cross-run persistence boundary
8. **Hot plugin lifecycle** — no server restart required for plugin management
9. **Multi-company isolation** — every entity company-scoped, one deployment runs unlimited companies
10. **Thin core, rich edges** — optional capabilities in plugins, not core

---

## Diagram Generation Instructions

Generate **Mermaid.js diagrams** (compatible with GitHub markdown rendering) for the following architectural views. Use the context above to ensure accuracy. For each diagram, include a brief 1-2 sentence description above it.

### 1. System Context Diagram (C4 Level 1)

Show Paperclip in relation to external actors:
- **Board Operator** (human, uses the React UI)
- **External Agent Runtimes** (Claude Code, Codex, Cursor, Gemini, OpenCode, Pi, Grok, OpenClaw, custom CLI/HTTP agents)
- **External Systems** (git repositories via worktrees, cloud providers for sandbox execution, npm for plugin packages, cloud upstream for sync)
- **Paperclip Control Plane** (central box containing the 12 subsystems)

Use `flowchart LR` or `graph TB` with clear boundaries.

### 2. Container / Deployment Diagram

Show the Docker-based deployment architecture:
- **Paperclip Server container** (Node.js Express + serves React UI)
- **PostgreSQL container** (PostgreSQL 17 Alpine)
- **Persistent volumes** (pgdata, paperclip-data)
- **Network boundaries** (loopback for local_trusted, LAN/VPN for authenticated private, proxy for authenticated public)
- **Embedded PGlite** as alternative path (no separate DB container)

Use `graph TD`.

### 3. Heartbeat Execution Sequence Diagram

Show the detailed sequence of an agent heartbeat execution cycle:
- Scheduler (cron service)
- Budget Service
- Workspace Service
- Secrets Service
- Skills Service
- Agent Adapter (external runtime)
- Run Tracking / Activity Log

Use `sequenceDiagram`.

### 4. Task Lifecycle State Machine

Show all task (issue) states and transitions:
- `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`
- Include who can trigger transitions (board operator vs agent)
- Include the atomic checkout guard (409 conflict)

Use `stateDiagram-v2`.

### 5. Plugin Architecture Diagram

Show the plugin system architecture:
- **Plugin Manager** (install, uninstall, upgrade, config)
- **Plugin Worker** (out-of-process, JSON-RPC over stdio)
- **Host Bridge** (capability validation, event bus, job coordinator, tool dispatcher, stream bus)
- **Plugin SDK** (worker SDK, UI SDK, testing, bundlers)
- **UI Extension** (React slots: page, detailTab, dashboardWidget, sidebar, settingsPage, etc.)
- **Managed Resources** (agents, projects, routines, skills created by plugins)

Use `graph TB` or `flowchart LR`.

### 6. API Request Flow Diagram

Show how an API request flows through the system:
- Client (UI or CLI)
- Middleware (auth, board mutation guard, validation, error handler)
- Route handler
- Service layer
- Database (Drizzle ORM → PostgreSQL/PGlite)
- Activity log write
- WebSocket event (real-time push to UI)

Use `sequenceDiagram`.

### 7. Cost & Budget Flow Diagram

Show the cost tracking and budget enforcement flow:
- Agent reports cost event → Cost service → Database
- Rollup aggregation by dimensions
- Budget policy check (threshold %)
- Warning (80%) vs Hard Stop (100%)

Use `flowchart TD`.

### 8. Company Portability Flow Diagram

Show the export/import flow:
- Export: DB entities → markdown package + `.paperclip.yaml` sidecar
- Secret scrubbing
- Import: dry-run → collision resolution → workspace remapping
- Import safety: heartbeats off, no API keys leaked

Use `flowchart LR`.

### 9. BugSquid Agent Organization

Show the BugSquid company-specific agent hierarchy as an org chart. This is a real-world example of how a Paperclip company structures its agent workforce:

- **CEO** — Top-level decision maker, strategy, budget approval, delegates across all departments
- **CTO** (Chief Technology Officer) — Owns technical roadmap, architecture, engineering quality, delegates all coding/debugging/testing to Coders
- **Coder** — Implements code, fixes bugs, writes features/tests
- **QA** — Browser validation, user-facing verification, test execution
- **CodeReviewer** — Reviews code changes and PRs
- **SecurityEngineer** — Security-sensitive work, vulnerability assessment, security reviews
- **CMO** (Chief Marketing Officer) — Owns marketing, brand, communications, social media strategy
- **Social expert** — Executes social media and content marketing
- **UXDesigner** — User experience design, UI/UX improvements
- **Support** — Customer support and issue triage
- **Accountant** — Finance tracking, budget monitoring, expense reports
- **DPO** (Data Protection Officer) — Data protection compliance, privacy reviews, GDPR/regulatory guidance

The reporting structure is:

```
CEO
├── CTO (Chief Technology Officer)
│   ├── Coder
│   ├── QA
│   ├── CodeReviewer
│   └── SecurityEngineer
├── CMO (Chief Marketing Officer)
│   └── Social expert
├── UXDesigner
├── Support
├── Accountant
└── DPO (Data Protection Officer)
```

Delegation flows: CEO delegates to direct reports (CTO, CMO, UXDesigner, Support, Accountant, DPO). CTO delegates technical work to Coder, QA, CodeReviewer, SecurityEngineer. CMO delegates marketing execution to Social expert. All communication via Paperclip issues with first-class blocking dependencies (`blockedByIssueIds`).

Use `graph TD`. Use rounded rectangles (`[ ]`) for management roles (CEO, CTO, CMO) and standard rectangles (with different fill colors or shapes) for individual contributor roles. Annotate edges with the type of work delegated (e.g., "technical tasks", "marketing tasks", "design requests", "support inquiries"). Include a legend mapping node shapes/colors to role types.

---

## Output Format Requirements

1. Generate each diagram as a standalone Mermaid code block.
2. Prefix each diagram with a brief human-readable title and description.
3. Use consistent naming across diagrams — component names should match.
4. Keep diagrams focused and readable. Avoid extreme complexity — use subgraphs and groupings where helpful.
5. Label all arrows and edges with the data or action they represent.
6. Include notes/comments in the Mermaid source for complex flows.
7. Do NOT wrap the Mermaid blocks in additional formatting (like HTML divs) that would break GitHub rendering.
8. If modeling subsystems, label each clearly and match the names used in this document.

---

## Example Prompt to Use

> "Using the Paperclip architecture described in this document, generate all 9 Mermaid.js architecture diagrams covering system context, deployment, heartbeat execution, task lifecycle, plugin architecture, API request flow, cost/budget flow, company portability, and BugSquid agent organization. Output each as a standalone Mermaid code block with a brief title and description."
