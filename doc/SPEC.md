# Paperclip Specification

Target specification for the Paperclip control plane. Living document — updated incrementally during spec interviews.

---

## 1. Company Model [DRAFT]

A Company is a first-order object. One Paperclip instance runs multiple Companies. A Company does not have a standalone "goal" field — its direction is defined by its set of Initiatives (see Task Hierarchy Mapping).

### Fields (Draft)

| Field       | Type          | Notes                             |
| ----------- | ------------- | --------------------------------- |
| `id`        | uuid          | Primary key                       |
| `name`      | string        | Company name                      |
| `createdAt` | timestamp     |                                   |
| `updatedAt` | timestamp     |                                   |

### Board Governance [DRAFT]

Every Company has a **Board** that governs high-impact decisions. The Board is the human oversight layer.

**V1: Single human Board.** One human operator.

#### Board Approval Gates (V1)

- New Agent hires (creating new Agents)
- CEO's initial strategic breakdown (CEO proposes, Board approves before execution begins)
- [TBD: other governance-gated actions — goal changes, firing Agents?]

#### Board Powers (Always Available)

The Board has **unrestricted access** to the entire system at all times:

- **Set and modify Company budgets** — the Board sets top-level token/LLM cost budgets
- **Pause/resume any Agent** — stop an Agent's heartbeat immediately
- **Pause/resume any work item** — pause a task, project, subtask tree, milestone. Paused items are not picked up by Agents.
- **Full project management access** — create, edit, comment on, modify, delete, reassign any task/project/milestone through the UI
- **Override any Agent decision** — reassign tasks, change priorities, modify descriptions
- **Manually change any budget** at any level

The Board is not just an approval gate — it's a live control surface. The human can intervene at any level at any time.

#### Budget Delegation

The Board sets Company-level budgets. The CEO can set budgets for Agents below them, and every manager Agent can do the same for their reports. How this cascading budget delegation works in practice is TBD, but the permission structure supports it. The Board can manually override any budget at any level.

**Future governance models** (not V1):

- Hiring budgets (auto-approve hires within $X/month)
- Multi-member boards
- Delegated authority (CEO can hire within limits)

### Open Questions

- External revenue/expense tracking — future plugin. Token/LLM cost budgeting is core.
- Company-level settings and configuration?
- Company lifecycle (pause, archive, delete)?
- What governance-gated actions exist beyond hiring and CEO strategy approval?

---

## 2. Agent Model [DRAFT]

Every employee is an agent. Agents are the workforce.

### Agent Identity (Adapter-Level)

Concepts like SOUL.md (identity/mission) and HEARTBEAT.md (loop definition) are **not part of the Paperclip protocol**. They are adapter-specific configurations. For example, an OpenClaw adapter might use SOUL.md and HEARTBEAT.md files. A Claude Code adapter might use CLAUDE.md. A bare Python script might use command-line args.

Paperclip doesn't prescribe how an agent defines its identity or behavior. It provides the control plane; the adapter defines the agent's inner workings.

### Agent Configuration [DRAFT]

Each agent has an **adapter type** and an **adapter-specific configuration blob**. The adapter defines what config fields exist.

#### Paperclip Protocol (What Paperclip Knows)

At the protocol level, Paperclip tracks:

- Agent identity (id, name, role, title)
- Org position (who they report to, who reports to them)
- Adapter type + adapter config
- Status (active, paused, terminated)
- Cost tracking data (if the agent reports it)

#### Adapter Configuration (Agent-Specific)

Each adapter type defines its own config schema. Examples:

- **OpenClaw adapter**: SOUL.md content, HEARTBEAT.md content, OpenClaw-specific settings
- **Process adapter**: command to run, environment variables, working directory
- **HTTP adapter**: endpoint URL, auth headers, payload template

#### Exportable Org Configs

A key goal: **the entire org's agent configurations are exportable.** You can export a company's complete agent setup — every agent, their adapter configs, org structure — as a portable artifact. This enables:

- Sharing company templates ("here's a pre-built marketing agency org")
- Version controlling your company configuration
- Duplicating/forking companies

#### Context Delivery

Configurable per agent. Two ends of the spectrum:

- **Fat payload** — Paperclip bundles relevant context (current tasks, messages, company state, metrics) into the heartbeat invocation. Suited for simple/stateless agents that can't call back to Paperclip.
- **Thin ping** — Heartbeat is just a wake-up signal. Agent calls Paperclip's API to fetch whatever context it needs. Suited for sophisticated agents that manage their own state.

#### Minimum Contract

The minimum requirement to be a Paperclip agent: **be callable.** That's it. Paperclip can invoke you via command or webhook. No requirement to report back — Paperclip infers basic status from process liveness when it can.

#### Integration Levels

Beyond the minimum, Paperclip provides progressively richer integration:

1. **Callable** (minimum) — Paperclip can start you. That's the only contract.
2. **Status reporting** — Agent reports back success/failure/in-progress after execution.
3. **Fully instrumented** — Agent reports status, cost/token usage, task updates, and logs. Bidirectional integration with the control plane.

Paperclip ships **default agents** that demonstrate full integration: progress tracking, cost instrumentation, and a **Paperclip skill** (a Claude Code skill for interacting with the Paperclip API) for task management. These serve as both useful defaults and reference implementations for adapter authors.

#### Export Formats

Two export modes:

1. **Template export** (default) — structure only: agent definitions, org chart, adapter configs, role descriptions. Optionally includes a few seed tasks to help get started. This is the blueprint for spinning up a new company.
2. **Snapshot export** — full state: structure + current tasks, progress, agent status. A complete picture you could restore or fork.

The usual workflow: export a template, create a new company from it, add a couple initial tasks, go.

---

## 3. Org Structure [DRAFT]

Hierarchical reporting structure. CEO at top, reports cascade down.

### Agent Visibility

**Full visibility across the org.** Every agent can see the entire org chart, all tasks, all agents. The org structure defines **reporting and delegation lines**, not access control.

Each agent publishes a short description of their responsibilities and capabilities — almost like skills ("when I'm relevant"). This lets other agents discover who can help with what.

### Cross-Team Work

Agents can create tasks and assign them to agents outside their reporting line. This is the mechanism for cross-team collaboration. These rules are primarily encoded in the Paperclip SKILL.md which is recommended for all agents. Paperclip the app enforces the tooling and some light governance, but the cross-team rules below are mainly implemented by agent decisions.

#### Task Acceptance Rules

When an agent receives a task from outside their team:

1. **Agrees it's appropriate + can do it** → complete it directly
2. **Agrees it's appropriate + can't do it** → mark as blocked
3. **Questions whether it's worth doing** → **cannot cancel it themselves.** Must reassign to their own manager, explain the situation. Manager decides whether to accept, reassign, or escalate.

#### Manager Escalation Protocol

It's any manager's responsibility to understand why their subordinates are blocked and resolve it:

0. **Decide** — as a manager, is this work worth doing?
1. **Delegate down** — ask someone under them to help unblock
2. **Escalate up** — ask the manager above them for help

#### Request Depth Tracking

When a task originates from a cross-team request, track the **depth** as an integer — how many delegation hops from the original requester. This provides visibility into how far work cascades through the org.

#### Billing Codes

Tasks carry a **billing code** so that token spend during execution can be attributed upstream to the requesting task/agent. When Agent A asks Agent B to do work, the cost of B's work is tracked against A's request. This enables cost attribution across the org.

### Open Questions

- Is this a strict tree or can agents report to multiple managers?
- Can org structure change at runtime? (agents reassigned, teams restructured)
- Do agents inherit any configuration from their manager?
- Billing code format — simple string? Hierarchical?

---

## 4. Heartbeat System [DRAFT]

The heartbeat is a protocol, not a runtime. Paperclip defines how to initiate an agent's cycle. What the agent does with that cycle — how long it runs, whether it's task-scoped or continuous — is entirely up to the agent.

### Execution Adapters

Agent configuration includes an **adapter** that defines how Paperclip invokes the agent. Built-in adapters include:

| Adapter | Mechanism | Example |
| ---------------- | -------------------------- | -------------------------------------------------- |
| `process` | Execute a child process | `python run_agent.py --agent-id {id}` |
| `http` | Send an HTTP request | `POST https://openclaw.example.com/hook/{id}` |
| `claude_local` | Local Claude Code process | Claude Code heartbeat worker |
| `codex_local` | Local Codex process | Codex CLI heartbeat worker |
| `opencode_local` | Local OpenCode process | OpenCode heartbeat worker |
| `pi_local` | Local Pi process | Pi CLI heartbeat worker |
| `cursor` | Cursor API/CLI bridge | Cursor-integrated heartbeat worker |
| `openclaw_gateway` | OpenClaw gateway API | Managed OpenClaw agent via gateway |
| `hermes_local` | Local Hermes process | Hermes agent heartbeat worker |

The `process` and `http` adapters ship as generic defaults. Additional built-in adapters cover common local coding runtimes (see list above), and new adapter types can be registered via the plugin system (see Plugin / Extension Architecture).

### Adapter Interface

Every adapter implements three methods:

```
invoke(agentConfig, context?) → void     // Start the agent's cycle
status(agentConfig) → AgentStatus        // Is it running? finished? errored?
cancel(agentConfig) → void               // Graceful stop signal (for pause/resume)
```

This is the full adapter contract. `invoke` starts the agent, `status` lets Paperclip check on it, `cancel` enables the board's pause functionality. Everything else (cost reporting, task updates) is optional and flows through the Paperclip REST API.

### What Paperclip Controls

- **When** to fire the heartbeat (schedule/frequency, per-agent)
- **How** to fire it (adapter selection + config)
- **What context** to include (thin ping vs. fat payload, per-agent)

### What Paperclip Does NOT Control

- How long the agent runs
- What the agent does during its cycle
- Whether the agent is task-scoped, time-windowed, or continuous

### Pause Behavior

When the board (or system) pauses an agent:

1. **Signal the current execution** — send a graceful termination signal to the running process/session
2. **Grace period** — give the agent time to wrap up, save state, report final status
3. **Force-kill after timeout** — if the agent doesn't stop within the grace period, terminate
4. **Stop future heartbeats** — no new heartbeat cycles will fire until the agent is resumed

This is "graceful signal + stop future heartbeats." The current run gets a chance to land cleanly.

### Open Questions

- Heartbeat frequency — who controls it? Fixed? Per-agent? Cron-like?
- What happens when a heartbeat invocation fails? (process crashes, HTTP 500)
- Health monitoring — how does Paperclip distinguish "stuck" from "working on a long task"?
- Can agents self-trigger their next heartbeat? ("I'm done, wake me again in 5 min")
- Grace period duration — fixed? configurable per agent?

---

## 5. Inter-Agent Communication [DRAFT]

All agent communication flows through the **task system**.

### Model: Tasks + Comments

- **Delegation** = creating a task and assigning it to another agent
- **Coordination** = commenting on tasks
- **Status updates** = updating task status and fields

There is no separate messaging or chat system. Tasks are the communication channel. This keeps all context attached to the work it relates to and creates a natural audit trail.

### Implications

- An agent's "inbox" is: tasks assigned to them + comments on tasks they're involved in
- The CEO delegates by creating tasks assigned to the CTO
- The CTO breaks those down into sub-tasks assigned to engineers
- Discussion happens in task comments, not a side channel
- If an agent needs to escalate, they comment on the parent task or reassign

### Task Hierarchy Mapping

Full hierarchy: **Initiative** (company goal) → Projects → Milestones → Issues → Sub-issues. Everything traces back to an initiative, and the "company goal" is just the first/primary initiative.

---

## 6. Cost Tracking [DRAFT]

Token/LLM cost budgeting is a core part of Paperclip. External revenue and expense tracking is a future plugin.

### Cost Reporting

Fully-instrumented Agents report token/API usage back to Paperclip. Costs are tracked at every level:

- **Per Agent** — how much is this employee costing?
- **Per task** — how much did this unit of work cost?
- **Per project** — how much is this deliverable costing?
- **Per Company** — total burn rate

Costs should be denominated in both **tokens and dollars**.

Billing codes on tasks (see Org Structure) enable cost attribution across teams — when Agent A requests work from Agent B, B's costs roll up to A's request.

### Budget Controls

Three tiers:

1. **Visibility** — dashboards showing spend at every level (Agent, task, project, Company)
2. **Soft alerts** — configurable thresholds (e.g. warn at 80% of budget)
3. **Hard ceiling** — auto-pause the Agent when budget is hit. Board notified. Board can override/raise the limit.

Budgets can be set to **unlimited** (no ceiling).

### Open Questions

- Cost reporting API — what's the schema for an agent to report costs?
- Dashboard design — what metrics matter most at each level?
- Budget period — per-day? per-week? per-month? rolling?

---

## 7. Default Agents & Bootstrap Flow [DRAFT]

### Bootstrap Sequence

How a Company goes from "created" to "running":

1. Human creates a Company and its initial Initiatives
2. Human defines initial top-level tasks
3. Human creates the CEO Agent (using the default CEO template or custom)
4. CEO's first heartbeat: reviews the Initiatives and tasks, proposes a strategic breakdown (org structure, sub-tasks, hiring plan)
5. **Board approves** the CEO's strategic plan
6. CEO begins execution — creating tasks, proposing hires (Board-approved), delegating

### Default Agents

Paperclip ships default Agent templates:

- **Default Agent** — a basic Claude Code or Codex loop. Knows the **Paperclip Skill** (SKILL.md) so it can interact with the task system, read Company context, report status.
- **Default CEO** — extends the Default Agent with CEO-specific behavior: strategic planning, delegation to reports, progress review, Board communication.

These are starting points. Users can customize or replace them entirely.

### Default Agent Behavior

The default agent's loop is **config-driven**. The adapter config contains the instructions that define what the agent does on each heartbeat cycle. There is no hardcoded standard loop — each agent's config determines its behavior.

This means the default CEO config tells the CEO to review strategy, check on reports, etc. The default engineer config tells the engineer to check assigned tasks, pick the highest priority, and work it. But these are config choices, not protocol requirements.

### Paperclip Skill (SKILL.md)

A skill definition that teaches agents how to interact with Paperclip. Provides:

- Task CRUD (create, read, update, complete tasks)
- Status reporting (check in, report progress)
- Company context (read goal, org chart, current state)
- Cost reporting (log token/API usage)
- Inter-agent communication rules

This skill is adapter-agnostic — it can be loaded into Claude Code, injected into prompts, or used as API documentation for custom agents.

---

## 8. Architecture & Deployment [DRAFT]

### Deployment Model

**Single-tenant, self-hostable.** Not a SaaS. One instance = one operator's companies.

#### Development Path (Progressive Deployment)

1. **Local dev** — One command to install and run. Embedded Postgres. Everything on your machine. Agents run locally.
2. **Hosted** — Deploy to Vercel/Supabase/AWS/anywhere. Remote agents connect to your server with a shared database. The UI is accessible via the web.
3. **Open company** — Optionally make parts public (e.g. a job board visible to the public for open companies).

The key constraint: it must be trivial to go from "I'm trying this on my machine" to "my agents are running on remote servers talking to my Paperclip instance."

#### Agent Authentication

When a user creates an Agent, Paperclip generates a **connection string** containing: the server URL, an API key, and instructions for how to authenticate. The Agent is assumed to be capable of figuring out how to call the API with its token/key from there.

Flow:

1. Human creates an Agent in the UI
2. Paperclip generates a connection string (URL + key + instructions)
3. Human provides this string to the Agent (e.g. in its adapter config, environment, etc.)
4. Agent uses the key to authenticate API calls to the control plane

### Tech Stack

| Layer    | Technology                                                   |
| -------- | ------------------------------------------------------------ |
| Frontend | React + Vite                                                 |
| Backend  | TypeScript + Express (REST API, not tRPC — need non-TS clients) |
| Database | PostgreSQL (see [doc/DATABASE.md](./doc/DATABASE.md) for details — PGlite embedded for dev, Docker or hosted Supabase for production) |
| Auth     | [Better Auth](https://www.better-auth.com/)                  |

### Concurrency Model: Atomic Task Checkout

Tasks use **single assignment** (one agent per task) with **atomic checkout**:

1. Agent attempts to set a task to `in_progress` (claiming it)
2. The API/database enforces this atomically — if another agent already claimed it, the request fails with an error identifying which agent has it
3. If the task is already assigned to the requesting agent from a previous session, they can resume

No optimistic locking or CRDTs needed. The single-assignment model + atomic checkout prevents conflicts at the design level.

### Human in the Loop

Agents can create tasks assigned to humans. The board member (or any human with access) can complete these tasks through the UI.

When a human completes a task, if the requesting agent's adapter supports **pingbacks** (e.g. OpenClaw hooks), Paperclip sends a notification to wake that agent. This keeps humans rare but possible participants in the workflow.

The agents are discouraged from assigning tasks to humans in the Paperclip SKILL, but sometimes it's unavoidable.

### API Design

**Single unified REST API.** The same API serves both the frontend UI and agents. Authentication determines permissions — board auth has full access, agent API keys have scoped access (their own tasks, cost reporting, company context).

No separate "agent API" vs. "board API." Same endpoints, different authorization levels.

### Work Artifacts

Paperclip manages task-linked work artifacts: issue documents (rich-text plans, specs, notes attached to issues) and file attachments. Agents read and write these through the API as part of normal task execution. Full delivery infrastructure (code repos, deployments, production runtime) remains the agent's domain — Paperclip orchestrates the work, not the build pipeline.

### Open Questions

- Real-time updates to the UI — WebSocket? SSE? Polling?
- Agent API key scoping — what exactly can an Agent access? Only their own tasks? Their team's? The whole Company?

### Crash Recovery: Manual, Not Automatic

When an agent crashes or disappears mid-task, Paperclip does **not** auto-reassign or auto-release the task. Instead:

- Paperclip surfaces stale tasks (tasks in `in_progress` with no recent activity) through dashboards and reporting
- Paperclip does not fail silently — the auditing and visibility tools make problems obvious
- Recovery is handled by humans or by emergent processes (e.g. a project manager agent whose job is to monitor for stale work and surface it)

**Principle: Paperclip reports problems, it doesn't silently fix them.** Automatic recovery hides failures. Good visibility lets the right entity (human or agent) decide what to do.

### Plugin / Extension Architecture

The core Paperclip system must be extensible. Features like knowledge bases, external revenue tracking, and new Agent Adapters should be addable as **plugins** without modifying core. This means:

- Well-defined API boundaries that plugins can hook into
- Event system or hooks for reacting to task/Agent lifecycle events
- **Agent Adapter plugins** — new Adapter types can be registered via the plugin system
- Plugin-registrable UI components (future)

The plugin framework has shipped. Plugins can register new adapter types, hook into lifecycle events, and contribute UI components (e.g. global toolbar buttons). A plugin SDK and CLI commands (`paperclipai plugin`) are available for authoring and installing plugins.

---

## 9. Frontend / UI [DRAFT]

### Primary Views

Each is a distinct page/route:

1. **Org Chart** — the org tree with live status indicators (running/idle/paused/error) per agent. Real-time activity feed of what agents are doing.
2. **Task Board** — Task management. Kanban and list views. Filter by team, agent, project, status.
3. **Dashboard** — high-level metrics: agent count, active tasks, costs, goal progress, burn rate. The "glance" view from GOAL.md.
4. **Agent Detail** — deep dive on a single agent: their tasks, activity, costs, configuration, status history.
5. **Project/Initiative Views** — progress tracking against milestones and goals.
6. **Cost Dashboard** — spend visualization at every level (agent, task, project, company).

### Board Controls (Available Everywhere)

- Pause/resume agents (any view)
- Pause/resume tasks/projects (any view)
- Approve/reject pending actions (hiring, strategy proposals)
- Direct task creation, editing, commenting

---

## 10. V1 Scope (MVP) [DRAFT]

**Full loop with one adapter.** V1 must demonstrate the complete Paperclip cycle end-to-end, even if narrow.

### Must Have (V1)

- [ ] **Company CRUD** — create a Company with Initiatives
- [ ] **Agent CRUD** — create/edit/pause/resume Agents with Adapter config
- [ ] **Org chart** — define reporting structure, visualize it
- [ ] **Process adapter** — invoke(), status(), cancel() for local child processes
- [ ] **Task management** — full lifecycle with hierarchy (tasks trace to company goal)
- [ ] **Atomic task checkout** — single assignment, in_progress locking
- [ ] **Board governance** — human approves hires, pauses Agents, sets budgets, full PM access
- [ ] **Cost tracking** — Agents report token usage, per-Agent/task/Company visibility
- [ ] **Budget controls** — soft alerts + hard ceiling with auto-pause
- [ ] **Default agent** — basic Claude Code/Codex loop with Paperclip skill
- [ ] **Default CEO** — strategic planning, delegation, board communication
- [ ] **Paperclip skill (SKILL.md)** — teaches agents to interact with the API
- [ ] **REST API** — full API for agent interaction (Express)
- [ ] **Web UI** — React/Vite: org chart, task board, dashboard, cost views
- [ ] **Agent auth** — connection string generation with URL + key + instructions
- [ ] **One-command dev setup** — embedded PGlite, everything local
- [ ] **Multiple Adapter types** (HTTP, OpenClaw gateway, and local coding adapters)

### Not V1

- Knowledge base - a future plugin
- Advanced governance models (hiring budgets, multi-member boards)
- Revenue/expense tracking beyond token costs - a future plugin
- Public job board / open company features

---

## 11. Knowledge Base

**Anti-goal for core.** The knowledge base is not part of the Paperclip core — it will be a plugin. The task system + comments + agent descriptions provide sufficient shared context.

The architecture must support adding a knowledge base plugin later (clean API boundaries, hookable lifecycle events) but the core system explicitly does not include one.

---

## 12. Anti-Requirements

Things Paperclip explicitly does **not** do:

- **Not an Agent runtime** — Paperclip orchestrates, Agents run elsewhere
- **Not a knowledge base** — core has no wiki/docs/vector-DB (plugin territory)
- **Not a SaaS** — single-tenant, self-hosted
- **Not opinionated about Agent implementation** — any language, any framework, any runtime
- **Not automatically self-healing** — surfaces problems, doesn't silently fix them
- **Does not manage delivery infrastructure** — no repo management, no deployment, no file systems (but does manage task-linked documents and attachments)
- **Does not auto-reassign work** — stale tasks are surfaced, not silently redistributed
- **Does not track external revenue/expenses** — that's a future plugin. Token/LLM cost budgeting is core.

---

## 13. Principles (Consolidated)

1. **Unopinionated about how you run your Agents.** Any language, any framework, any runtime. Paperclip is the control plane, not the execution plane.
2. **Company is the unit of organization.** Everything lives under a Company.
3. **Tasks are the communication channel.** All Agent communication flows through tasks + comments. No side channels.
4. **All work traces to the goal.** Hierarchical task management — nothing exists in isolation.
5. **Board governs.** Humans retain control through the Board. Conservative defaults (human approval required).
6. **Surface problems, don't hide them.** Good auditing and visibility. No silent auto-recovery.
7. **Atomic ownership.** Single assignee per task. Atomic checkout prevents conflicts.
8. **Progressive deployment.** Trivial to start local, straightforward to scale to hosted.
9. **Extensible core.** Clean boundaries so plugins can add capabilities (Adapters, knowledge base, revenue tracking) without modifying core.
