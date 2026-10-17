<p align="center">
  <img src="doc/assets/banner.jpg" alt="Paperclip is the app people use to manage AI agents for work." width="720" />
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="https://docs.paperclip.ing"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/paperclipai/paperclip"><strong>GitHub</strong></a> &middot;
  <a href="https://discord.gg/m4HZY7xNG3"><strong>Discord</strong></a> &middot;
  <a href="https://x.com/papercliping"><strong>Twitter</strong></a> &middot;
  <a href="https://paperclip.ing"><strong>Website</strong></a>
</p>

<p align="center">
  <a href="https://github.com/paperclipai/paperclip/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/paperclipai/paperclip/stargazers"><img src="https://img.shields.io/github/stars/paperclipai/paperclip?style=flat" alt="Stars" /></a>
  <a href="https://discord.gg/m4HZY7xNG3"><img src="https://img.shields.io/badge/discord-join-7289da" alt="Discord" /></a>
  <a href="https://superagent.sh"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.superagent.sh/api/badge/paperclipai/paperclip/shield.svg?theme=dark&accent=teal&variant=scanned" /><img src="https://www.superagent.sh/api/badge/paperclipai/paperclip/shield.svg?theme=light&accent=teal&variant=scanned" alt="Security posture verified by Superagent" /></picture></a>
</p>

<p align="center">
  <a href="https://www.star-history.com/paperclipai/paperclip"><img src="https://api.star-history.com/badge?repo=paperclipai/paperclip" alt="Star History Rank" /></a>
</p>

<br/>

<div align="center">
  <video src="https://github.com/user-attachments/assets/773bdfb2-6d1e-4e30-8c5f-3487d5b70c8f" width="600" controls></video>
</div>

<p align="center">
  <a href="https://paperclip.ing/waitlist/"><strong>Sign up for the Paperclip Cloud waitlist →</strong></a>
</p>

<br/>

# Paperclip is the app people use to manage AI agents for work.

Open-source orchestration for teams of AI agents.

**If OpenClaw is an _employee_, Paperclip is the _company_.**

Paperclip is a Node.js server and React UI that orchestrates a team of AI agents to run a business. Bring your own agents, assign goals, and track work and costs from one dashboard. Choose models and harnesses per agent while keeping your team's tasks, skills, permissions, and history in one place.

It looks like a task manager. Under the hood: org charts, budgets, governance, goal alignment, and agent coordination.

**Manage business goals, not pull requests.**

|        | Step            | Example                                                            |
| ------ | --------------- | ------------------------------------------------------------------ |
| **01** | Define the goal | _"Build the #1 AI note-taking app to $1M MRR."_                    |
| **02** | Hire the team   | CEO, CTO, engineers, designers, marketers — any bot, any provider. |
| **03** | Approve and run | Review strategy. Set budgets. Hit go. Monitor from the dashboard.  |

<br/>

<div align="center">
<table>
  <tr>
    <td align="center" rowspan="2"><strong>Works<br/>with</strong></td>
    <td align="center" valign="top"><img src="doc/assets/logos/openclaw.svg" width="32" height="32" alt="OpenClaw" /><br/><sub>OpenClaw</sub></td>
    <td align="center" valign="top"><img src="doc/assets/logos/claude.svg" width="32" height="32" alt="Claude Code" /><br/><sub>Claude Code</sub></td>
    <td align="center" valign="top"><img src="ui/public/brands/codex-color.svg" width="32" height="32" alt="Codex" /><br/><sub>Codex</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/cursor-dark.svg" /><img src="ui/public/brands/adapters/cursor.svg" width="32" height="32" alt="Cursor and Cursor Cloud" /></picture><br/><sub>Cursor<br/>+ Cloud</sub></td>
    <td align="center" valign="top"><img src="ui/public/brands/adapters/gemini-color.svg" width="32" height="32" alt="Gemini CLI" /><br/><sub>Gemini CLI</sub></td>
  </tr>
  <tr>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/opencode-logo-dark-square.svg" /><img src="ui/public/brands/opencode-logo-light-square.svg" width="32" height="32" alt="OpenCode" /></picture><br/><sub>OpenCode</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/pi-dark.svg" /><img src="ui/public/brands/adapters/pi.svg" width="32" height="32" alt="Pi" /></picture><br/><sub>Pi</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/hermesagent-dark.svg" /><img src="ui/public/brands/adapters/hermesagent.svg" width="32" height="32" alt="Hermes and Hermes Gateway" /></picture><br/><sub>Hermes<br/>+ Gateway</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/grok-dark.svg" /><img src="ui/public/brands/adapters/grok.svg" width="32" height="32" alt="Grok Build" /></picture><br/><sub>Grok Build</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/adapters/kimi-color.svg" /><img src="ui/public/brands/adapters/kimi-color-light.svg" width="32" height="32" alt="Kimi Code" /></picture><br/><sub>Kimi Code</sub></td>
  </tr>
</table>

<em>If it can receive a heartbeat, it's hired.</em>

</div>

Custom processes, HTTP endpoints, and external adapter packages extend the roster. See the [adapter overview](https://docs.paperclip.ing/reference/adapters/overview/) for setup and capabilities.

<br/>

## Paperclip is right for you if

- ✅ You want to build **autonomous AI organizations**
- ✅ You **coordinate many different agents** (OpenClaw, Codex, Claude, Cursor) toward a common goal
- ✅ You have **20 simultaneous Claude Code terminals** open and lose track of what everyone is doing
- ✅ You want agents running **autonomously 24/7**, but still want to audit work and chime in when needed
- ✅ You want to **monitor costs** and enforce budgets
- ✅ You want a process for managing agents that **feels like using a task manager**
- ✅ You want to manage your autonomous businesses **from your phone**

<br/>

## The four pillars

Four things have to work for an organization of AI agents to actually produce: the tasks, the org, the training, and the infrastructure. Paperclip is built around exactly those four pillars.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/paperclipai/paperclip/1ec33ffd8b597f7e36aac3e2fbb4665b8c42dc3c/doc/assets/four-pillars-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/paperclipai/paperclip/1ec33ffd8b597f7e36aac3e2fbb4665b8c42dc3c/doc/assets/four-pillars-light.png">
  <img src="https://raw.githubusercontent.com/paperclipai/paperclip/1ec33ffd8b597f7e36aac3e2fbb4665b8c42dc3c/doc/assets/four-pillars-light.png" alt="The four pillars of Paperclip">
</picture>

| Pillar | Built for | What it covers |
| --- | --- | --- |
| **Agentic Task Manager** — Declare intent. Agents work. You verify the output. | Everyone, daily | Tasks, approvals & review gates · proactive agent coworkers · auditable routines & workflows · verify from diffs, screenshots & tests |
| **Org Chart for Agents** — Roles, permissions & boundaries for humans and agents. | Managers | Mixed human + agent org chart · responsibilities, delegation, specialization · governance: who can do what · scoped secrets & company boundaries · connection permissions & responsible-user identities |
| **Agent Employee Training** — Design, train & evaluate your AI employees. | Enablers | Skill Studio & shared org-wide skills · evals & saved test runs · active learning loops & quality metrics · performance reviews for agents · saved test inputs · skill version history & restore · reusable team templates |
| **Agentic OS** — The infrastructure that makes the work run. | IT & platform | Cross-provider runtime: any model, any agent · sandboxing, integrations & MCP servers · SSO, GRC, RBAC & cost controls · data privacy, internal trace collection, compounding data value · personal & shared app connections · run history & opt-in tracing |

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>🔌 Bring Your Own Agent</h3>
Any agent, any runtime, one org chart. If it can receive a heartbeat, it's hired.
</td>
<td align="center" width="33%">
<h3>🎯 Goal Alignment</h3>
Link tasks and projects to your organization goals. Agents receive the goal context behind their work.
</td>
<td align="center" width="33%">
<h3>💓 Heartbeats</h3>
Agents wake for assigned work, follow-up messages, or configured schedules. Delegation flows up and down the org chart.
</td>
</tr>
<tr>
<td align="center">
<h3>💰 Cost Control</h3>
Company, agent, and project <a href="https://docs.paperclip.ing/guides/day-to-day/costs/">budgets</a>. Track reported spend, get threshold alerts, and pause work at configured limits.
</td>
<td align="center">
<h3>🏢 Multi-Organization</h3>
One deployment, many organizations. Separate tasks, agents, permissions, and activity histories for each.
</td>
<td align="center">
<h3>🎫 Task Threads</h3>
Keep conversations, plans, blockers, files, and run history attached to the work. Assign tasks to agents or people.
</td>
</tr>
<tr>
<td align="center">
<h3>🛡️ Governance</h3>
Configure <a href="https://docs.paperclip.ing/guides/day-to-day/approvals/">review and approval stages</a>, approve hires, and pause, reassign, or stop work when needed.
</td>
<td align="center">
<h3>📊 Org Chart</h3>
Hierarchies, roles, reporting lines. Your agents have a boss, a title, and a job description.
</td>
<td align="center">
<h3>📱 Mobile Ready</h3>
Monitor and manage your autonomous businesses from anywhere.
</td>
</tr>
<tr>
<td align="center">
<h3>🔗 Apps & Connections</h3>
<a href="https://docs.paperclip.ing/connectors/">Connect services</a> such as GitHub, Notion, and Railway, or your own MCP server. Set gateway actions to Allowed, Ask first, or Off.
</td>
<td align="center">
<h3>👥 Shared Agents, Personal Accounts</h3>
Choose <a href="https://docs.paperclip.ing/connectors/access-model/">who can use a connection and which agents can access it</a>. Managed GitHub operations can use the account of the person directing the work.
</td>
<td align="center">
<h3>🧠 Skills & Skill Studio</h3>
Install or write <a href="https://docs.paperclip.ing/guides/org/skills/">shared skills</a>, test them with saved inputs, inspect results, and restore earlier versions.
</td>
</tr>
<tr>
<td align="center">
<h3>📅 Scheduled Routines</h3>
Run <a href="https://docs.paperclip.ing/guides/projects-workflow/routines/">recurring work</a> on a schedule or trigger it through an API or webhook. Each run has a task, an owner, and a history.
</td>
<td align="center">
<h3>📎 Artifacts & Feedback</h3>
Find the <a href="https://docs.paperclip.ing/guides/day-to-day/artifacts/">files and documents agents produce</a>. Preview supported formats and leave comments on specific passages in documents.
</td>
<td align="center">
<h3>📦 Ready-Made Teams</h3>
Preview and install <a href="https://docs.paperclip.ing/guides/org/team-catalog/">teams</a> with roles, skills, projects, and routines. Choose their runtimes and make the setup your own.
</td>
</tr>
</table>

Experimental **Agent Chat** and **chat/email connectors** add conversations with agents in Paperclip and through configured services such as Slack, Discord, Telegram, and AgentMail. Enable the relevant instance settings to try them.

<br/>

## Problems Paperclip solves

| Without Paperclip                                                                                                                     | With Paperclip                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ❌ You have 20 Claude Code tabs open and can't track which one does what. On reboot you lose everything.                              | ✅ Tasks are ticket-based, conversations are threaded, sessions persist across reboots.                                                |
| ❌ You manually gather context from several places to remind your bot what you're actually doing.                                     | ✅ Context flows from the task up through the project and company goals — your agent always knows what to do and why.                  |
| ❌ Folders of agent configs are disorganized and you're re-inventing task management, communication, and coordination between agents. | ✅ Paperclip gives you org charts, ticketing, delegation, and governance out of the box — so you run a company, not a pile of scripts. |
| ❌ Runaway loops waste hundreds of dollars of tokens and max your quota before you even know what happened.                           | ✅ Spend tracking, budget alerts, and automatic pauses help you control the cost of ongoing work.                                       |
| ❌ You have recurring jobs (customer support, social, reports) and have to remember to manually kick them off.                        | ✅ Routines create assigned tasks on a schedule, with outputs and run history you can inspect.                                         |
| ❌ You have an idea, you have to find your repo, fire up Claude Code, keep a tab open, and babysit it.                                | ✅ Add a task in Paperclip. Your coding agent works on it until it's done. Management reviews their work.                              |

<br/>

## Why Paperclip is special

Paperclip handles the hard orchestration details correctly.

|                                   |                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Atomic task checkout.**         | A single assignee and execution locks prevent competing runs from claiming the same task.                    |
| **Persistent work context.**      | Tasks, comments, and documents stay in Paperclip. Supporting adapters resume saved sessions across runs.       |
| **Runtime skill injection.**      | Agents can learn Paperclip workflows and project context at runtime, without retraining.                      |
| **Governance with rollback.**     | Approval gates are enforced, config changes are revisioned, and bad changes can be rolled back safely.        |
| **Accountable connections.**      | Human access, agent eligibility, and gateway action permissions are separate controls. Approve a call once or save a revocable rule. |
| **Goal-aware execution.**         | Linked tasks and projects carry goal ancestry so agents see the "why," not just a title.                      |
| **Portable company templates.**   | Export/import orgs, agents, and skills with secret scrubbing and collision handling.                          |
| **Organization boundaries.**      | Company-scoped access checks keep each organization's work, agents, and activity separate within one deployment. |

<br/>

## What's Under the Hood

Paperclip is a full control plane, not a wrapper. Before you build any of this yourself, know that it already exists:

```
┌──────────────────────────────────────────────────────────────┐
│                       PAPERCLIP SERVER                       │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │Identity & │  │  Work &   │  │ Heartbeat │  │Governance │  │
│  │  Access   │  │   Tasks   │  │ Execution │  │& Approvals│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Org Chart │  │Workspaces │  │  Plugins  │  │  Budget   │  │
│  │ & Agents  │  │ & Runtime │  │           │  │ & Costs   │  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Routines  │  │ Secrets & │  │ Activity  │  │  Company  │  │
│  │& Schedules│  │  Storage  │  │ & Events  │  │Portability│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
└──────────────────────────────────────────────────────────────┘
         ▲              ▲              ▲              ▲
   ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
   │  Claude   │  │   Codex   │  │   CLI     │  │ HTTP/web  │
   │   Code    │  │           │  │  agents   │  │   bots    │
   └───────────┘  └───────────┘  └───────────┘  └───────────┘
```

### The Systems

<table>
<tr>
<td width="50%">

**Identity & Access** — Two deployment modes (trusted local or authenticated), human roles and permissions, agent API keys, short-lived run JWTs, company memberships, and invite flows. Responsible-user attribution follows work through delegation and supported managed connections.

</td>
<td width="50%">

**Org Chart & Agents** — Agents have roles, titles, reporting lines, permissions, and budgets. Adapter examples match the diagram: Claude Code, Codex, CLI agents such as Cursor/Gemini/bash, HTTP/webhook bots such as OpenClaw, and external adapter plugins. If it can receive a heartbeat, it's hired.

</td>
</tr>
<tr>
<td>

**Work & Task System** — Issues carry company/project/goal/parent links, atomic checkout with execution locks, first-class blocker dependencies, comments, documents, attachments, work products, labels, and inbox state. Search across work, review document revisions, and leave anchored feedback.

</td>
<td>

**Heartbeat Execution** — DB-backed wakeup queue with coalescing, budget checks, workspace resolution, secret injection, skill loading, and adapter invocation. Runs produce logs, usage records, and adapter-specific session state. Bounded recovery handles supported failures and surfaces cases that need human action.

</td>
</tr>
<tr>
<td>

**Workspaces & Runtime** — Project repositories and workspaces, optional isolated execution workspaces (git worktrees, operator branches), and runtime services (dev servers, preview URLs). Sandbox providers extend execution beyond the local host; availability depends on the configured environment and adapter.

</td>
<td>

**Governance & Approvals** — Board approval workflows, execution policies with review/approval stages, decision tracking, budget hard-stops, and agent pause/resume/terminate. Configured task reviews govern completion; connection action approvals govern calls through the tool gateway.

</td>
</tr>
<tr>
<td>

**Budget & Cost Control** — Token and cost tracking by company, agent, project, goal, issue, provider, and model. Scoped budget policies with warning thresholds and hard stops. Enforcement uses recorded spend; usage reporting and in-flight work can delay a stop.

</td>
<td>

**Routines & Schedules** — Recurring tasks with cron, webhook, and API triggers. Concurrency and catch-up policies. Each routine execution creates a tracked issue and wakes the assigned agent — no manual kick-offs needed.

</td>
</tr>
<tr>
<td>

**[Plugins](https://docs.paperclip.ing/administration/plugins/)** — Instance-wide plugin system with out-of-process workers, capability-gated host services, job scheduling, tool exposure, and UI contributions. Extend Paperclip without forking it.

</td>
<td>

**Secrets & Storage** — Company secrets and per-person secret values, encrypted credential storage, local or S3-compatible file storage, attachments, and work products. Secret references supply credentials to authorized runs without copying values into ordinary agent configuration.

</td>
</tr>
<tr>
<td>

**Activity & Events** — Mutating actions, heartbeat state changes, cost events, approvals, comments, and work products are recorded as durable activity so operators can audit what happened and why.

</td>
<td>

**[Company Portability](https://docs.paperclip.ing/guides/power/export-import/)** — Preview, export, and import organization packages with agents, skills, and optional projects, routines, tasks, and attachments. Referenced secret values are omitted; review packages before sharing because plain environment values and local paths can remain. Packages share an operating setup; full-instance recovery uses backups.

</td>
</tr>
</table>

<br/>

## What Paperclip is not

|                              |                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Not just a chatbot.**      | Conversations stay attached to tasks, plans, decisions, and outputs. Experimental Agent Chat can hand work off to assigned tasks.    |
| **Not an agent framework.**  | We don't tell you how to build agents. We tell you how to run a company made of them.                                |
| **Not just a workflow builder.** | Routines and experimental pipelines operate within an organization, with roles, goals, budgets, and governance.                  |
| **Not a prompt manager.**    | Agents bring their own prompts, models, and runtimes. Paperclip manages the organization they work in.               |
| **Not limited to one agent.** | Start with one agent and grow into a team with shared skills, delegation, and review.                                              |
| **Not only for code review.** | Coding and PR review fit alongside research, operations, content, and other work.                                                  |

<br/>

## Quickstart

Open source. Self-hosted. No Paperclip account required. Follow the [guided quickstart](https://docs.paperclip.ing/guides/getting-started/five-minute-path/) to set up your first agent.

### Just ask your agent to install Paperclip

Share the [installation guide](https://docs.paperclip.ing/reference/cli/installation/) with your agent.

### Or install it yourself

With **Node.js 24.11 or newer** installed:

```bash
npx paperclipai@latest onboard --yes
```

The CLI runs from npm's cache; your instance configuration and data persist locally.

See the [installation guide](https://docs.paperclip.ing/reference/cli/installation/) for managed installs, pinned versions, canary and git-ref installs, updates, rollback, service management, and uninstalling.

For an isolated manual test instance that is already initialized with a CEO
agent, use `test-drive`. It stays in the foreground, never installs a service
or creates a first task, and opens the browser only after setup succeeds:

```bash
ANTHROPIC_API_KEY=... npx paperclipai test-drive
OPENAI_API_KEY=... npx paperclipai test-drive --harness codex
OPENROUTER_API_KEY=... npx paperclipai test-drive \
  --harness opencode \
  --model openrouter/anthropic/claude-sonnet-4.5
```

Each run without `--data-dir` gets a unique, retained temporary directory; its
absolute path is printed at startup. Pass `--data-dir` to reuse one, or
`--no-browser` to leave the initialized instance unopened. When invoked from a
linked Git worktree, `test-drive` also enables task execution in that worktree.
See the [test-drive guide](https://docs.paperclip.ing/reference/cli/test-drive/) for credential and
reuse behavior.

> **Troubleshooting: private npm registry `.npmrc`**
>
> If this fails with an `E404` for `paperclipai` (or similar) and you use a private npm registry (for example GitHub Packages) via a global `~/.npmrc`, `npx` may be resolving `paperclipai` against that private registry instead of the public npm registry.
>
> Diagnostic:
>
> ```bash
> npm config get registry
> ```
>
> Workaround (cross-platform; force the public npm registry for this command):
>
> ```bash
> npx --registry https://registry.npmjs.org paperclipai@latest onboard --yes
> ```

That quickstart path now defaults to trusted local loopback mode for the fastest first run. To start in authenticated/private mode instead, choose a bind preset explicitly:

```bash
npx paperclipai@latest onboard --yes --bind lan
# or:
npx paperclipai@latest onboard --yes --bind tailnet
```

If you already have Paperclip configured, rerunning `onboard` keeps the existing config in place. Use `npx paperclipai configure` to edit settings.

> **macOS troubleshooting:** If `npx paperclipai onboard` silently exits with no output, you likely have `libvips` installed via Homebrew. This causes the `sharp` dependency to attempt a source build instead of using its prebuilt binary, which fails silently. Fix with:
>
> ```bash
> SHARP_IGNORE_GLOBAL_LIBVIPS=1 npx paperclipai onboard --yes
> ```

Or manually:

```bash
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

This starts the UI and API at `http://localhost:3100`. An embedded PostgreSQL database is created automatically — no setup required.

> **Requirements:** Node.js 24.11+, pnpm 9.15+

Local Claude and Codex subscription sign-in also needs Python 3 and the
corresponding provider CLI on the Paperclip host. The Docker image includes them.

Source development also builds the native Paperclip Runner when enabled (the self-hosted default). Install a Rust toolchain, or set `PAPERCLIP_RUNNER_BINARY` to a compatible prebuilt runner.

<br/>

## FAQ

**Q: Is this project maintained or just slop?**

**A:** Paperclip is maintained by the [Paperclip team](https://paperclip.ing). We've merged [over 2,700 pull requests](https://github.com/paperclipai/paperclip/pulls?q=is%3Apr+is%3Amerged).

<br/>

**Q: What does a typical setup look like?**

**A:** Locally, a single Node.js process manages an embedded Postgres and local file storage. For production, point it at your own Postgres and deploy however you like. Configure projects, agents, and goals — the agents take care of the rest.

For remote access, use authenticated mode with a private-network bind such as Tailscale, or deploy the persistent server with Docker. See [deployment modes](https://docs.paperclip.ing/reference/deploy/deployment-modes/) and the [Docker guide](https://docs.paperclip.ing/reference/deploy/docker/).

<br/>

**Q: Can I run multiple companies?**

**A:** Yes. A single deployment can host multiple organizations with company-scoped data and access checks.

<br/>

**Q: How is Paperclip different from agents like OpenClaw or Claude Code?**

**A:** Paperclip _uses_ those agents. It orchestrates them into a company — with org charts, budgets, goals, governance, and accountability.

<br/>

**Q: Why should I use Paperclip instead of just pointing my OpenClaw to Asana or Trello?**

**A:** Agent orchestration has subtleties in how you coordinate who has work checked out, how to maintain sessions, monitoring costs, establishing governance - Paperclip does this for you.

(Bring-your-own-ticket-system is on the Roadmap)

<br/>

**Q: Do agents run continuously?**

**A:** Agents wake for assigned work and follow-up messages. Optional timer heartbeats let them check for work periodically; routines create recurring tasks on their own schedules. You can also connect externally running agents such as OpenClaw. A mention alone does not assign work or wake another agent.

<br/>

## Development

```bash
pnpm dev              # Full dev (API + UI, watch mode)
pnpm dev:once         # Full dev without file watching
pnpm dev:server       # Server only
pnpm dev:mobile       # Serve prebuilt UI on :3101 for phones/tablets (proxies /api → :3100)
pnpm dev:both         # Run `pnpm dev` and `pnpm dev:mobile` together
pnpm build            # Build all
pnpm typecheck        # Type checking
pnpm test             # Cheap default test run (Vitest only)
pnpm test:watch       # Vitest watch mode
pnpm test:e2e         # Playwright browser suite
pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations
```

`pnpm test` does not run Playwright. Browser suites stay separate and are typically run only when working on those flows or in CI.

See [doc/DEVELOPING.md](doc/DEVELOPING.md) for the full development guide.

<br/>

## Roadmap

- ✅ Plugin system (e.g. add a knowledge base, custom tracing, queues, etc)
- ✅ Get OpenClaw / claw-style agent employees
- ✅ companies.sh - import and export entire organizations
- ✅ Easy AGENTS.md configurations
- ✅ Skills Manager, Skill Studio & Skills Store
- ✅ Scheduled Routines
- ✅ Better Budgeting
- ✅ Agent Reviews and Approvals
- ✅ Multiple Human Users
- ✅ Cloud / Sandbox agents (e2b, Cloudflare, Daytona, Modal, Novita, self-hosted Kubernetes)
- ✅ Artifacts & Work Products
- ✅ Deep Planning (planning mode, revisioned plans, plan approvals)
- ✅ Enforced Outcomes (watchdogs, recovery actions, review gates)
- ✅ MCP Tool Gateway & Apps (governed tool access)
- ✅ Secrets Manager with per-agent access
- ✅ Activity log & action attribution
- ✅ Self-healing runs & automatic recovery
- ✅ Agent evals & feedback
- ✅ Connected Apps
- ✅ Personal & Shared AI Accounts
- ✅ Shared Agents Use Personal GitHub Identities
- ✅ Skill Version History & Restore
- ✅ Document Comments & Revision History
- ✅ Company-Wide Search
- ✅ Multi-Model & Multi-Harness Teams
- 🟡 Memory / Knowledge
- ⚪ MAXIMIZER MODE
- ⚪ Work Queues
- ⚪ Self-Organization
- ⚪ Automatic Organizational Learning
- 🟡 Agent Chat
- 🟡 Cloud deployments
- ⚪ Desktop App
- ⚪ Bring-your-own-ticket-system (Asana / Linear / Jira as on-ramps)

This is the short roadmap preview. See the full roadmap in [ROADMAP.md](ROADMAP.md).

<br/>

## Community & Plugins

Find Plugins and more at [awesome-paperclip](https://github.com/gsxdsm/awesome-paperclip)

## Observability

Paperclip ships with opt-in OpenTelemetry auto-instrumentation for the server (traces only). It activates when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and supports `grpc`, `http/protobuf`, and `http/json` via the standard `OTEL_EXPORTER_OTLP_PROTOCOL` env var. `@opentelemetry/api` is a normal server dependency; the SDK, auto-instrumentation, and exporter packages are optional peer dependencies — install them only if you want tracing. See [doc/observability.md](doc/observability.md) for install commands and the full env-var reference.

Paperclip also ships with opt-in Sentry error monitoring for the server and the browser. Set `SENTRY_DSN_FRONTEND` to activate it for the browser and `SENTRY_DSN_BACKEND` to activate it for the server — each variable is optional, and the legacy `SENTRY_DSN` variable still works as a fallback for either component. The supported server SDK version is `@sentry/node@10.71.0`; it is an optional peer dependency for the server, so install it only if you want error monitoring. The browser SDK, `@sentry/browser`, is pinned to the same exact version. See [doc/observability.md](doc/observability.md#sentry-error-monitoring) for the install command, the privacy settings, and the full default capture set.

## Telemetry

Paperclip collects anonymous usage telemetry to help us understand how the product is used and improve it. No personal information, issue content, prompts, file paths, or secrets are ever collected. Private repository references are hashed with a per-install salt before being sent.

Contributors changing emitted telemetry events should follow the [Telemetry Data Contract](packages/shared/src/telemetry/README.md).
For proposed first-party events that are not in the generated contract yet, follow [Telemetry Workflow](doc/TELEMETRY_WORKFLOW.md).

Telemetry is **enabled by default** and can be disabled with any of the following:

| Method               | How                                                     |
| -------------------- | ------------------------------------------------------- |
| Environment variable | `PAPERCLIP_TELEMETRY_DISABLED=1`                        |
| Standard convention  | `DO_NOT_TRACK=1`                                        |
| CI environments      | Automatically disabled when `CI=true`                   |
| Config file          | Set `telemetry.enabled: false` in your Paperclip config |

## Contributing

We welcome contributions. See the [contributing guide](CONTRIBUTING.md) for details.

**[We're hiring](https://paperclip.ing/about/#careers)**

<br/>

## Community

- [Discord](https://discord.gg/m4HZY7xNG3) — Join the community
- [Twitter / X](https://x.com/papercliping) — Follow updates and announcements
- [GitHub Issues](https://github.com/paperclipai/paperclip/issues) — bugs and feature requests
- [GitHub Discussions](https://github.com/paperclipai/paperclip/discussions) — ideas and RFC

<br/>

## License

MIT &copy; 2026 [Paperclip Labs, Inc](https://paperclip.ing)

## Star History

<a href="https://www.star-history.com/?repos=paperclipai%2Fpaperclip&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=paperclipai/paperclip&type=date&theme=dark&legend=top-left&sealed_token=hFjuwFq41bQD5cevvXVv5cTru2swWRZujwJYKlHhtBh6n0H5-VvJZW2SAlcQKB8u4KxhyEB9JqFg1yccJ8WLv9wPBcoWpWcak4gx0MYTWu_pOs2jKOaDluH7KsLeTKt6DHGkHiN3LsqV9s--MTDQcC6Xl7zV51W0-YezQXo-pVPgoFDFAGf2CY5fiP5Q" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=paperclipai/paperclip&type=date&legend=top-left&sealed_token=hFjuwFq41bQD5cevvXVv5cTru2swWRZujwJYKlHhtBh6n0H5-VvJZW2SAlcQKB8u4KxhyEB9JqFg1yccJ8WLv9wPBcoWpWcak4gx0MYTWu_pOs2jKOaDluH7KsLeTKt6DHGkHiN3LsqV9s--MTDQcC6Xl7zV51W0-YezQXo-pVPgoFDFAGf2CY5fiP5Q" />
    <img src="https://api.star-history.com/chart?repos=paperclipai/paperclip&type=date&legend=top-left&sealed_token=hFjuwFq41bQD5cevvXVv5cTru2swWRZujwJYKlHhtBh6n0H5-VvJZW2SAlcQKB8u4KxhyEB9JqFg1yccJ8WLv9wPBcoWpWcak4gx0MYTWu_pOs2jKOaDluH7KsLeTKt6DHGkHiN3LsqV9s--MTDQcC6Xl7zV51W0-YezQXo-pVPgoFDFAGf2CY5fiP5Q" alt="Star History Chart" />
  </picture>
</a>

<br/>

---

<p align="center">
  <sub>Open source under MIT. Built for people who want to get work done, not babysit agents.</sub>
</p>
