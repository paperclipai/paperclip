---
title: Quickstart
summary: Get Paperclip running in minutes
version: v0.5.0
last_updated: 2026-08-21
---

There are two ways to use Paperclip. Pick the one that fits:

| | **Voyonder Cloud (SaaS)** | **Self-Hosted** |
|-|---------------------------|-----------------|
| Setup | Just a browser | Terminal + Node.js |
| Time | ~2 minutes | ~5 minutes |
| Best for | Trying it out, SMB owners | Developers, custom deployments |
| **Start here** | → **[Run Your First AI Company](/start/your-first-company)** | → **Continue below** |

## Self-Hosted Quick Start (Recommended for Developers)

```sh
npx paperclipai onboard --yes
```

> **Want to see it in action first?** Use the hosted version at [voyonder.com](https://voyonder.com) — no setup required, just sign up and deploy a template company in one click.

This walks you through setup, configures your environment, and gets Paperclip running.

If you already have a Paperclip install, rerunning `onboard` keeps your current config and data paths intact. Use `paperclipai configure` if you want to edit settings.

To start Paperclip again later:

```sh
npx paperclipai run
```

> **Note:** If you used `npx` for setup, always use `npx paperclipai` to run commands. The `pnpm paperclipai` form only works inside a cloned copy of the Paperclip repository (see Local Development below).

## Local Development

For contributors working on Paperclip itself. Prerequisites: Node.js 24.11+ and pnpm 9+.

Clone the repository, then:

```sh
pnpm install
pnpm dev
```

This starts the API server and UI at [http://localhost:3100](http://localhost:3100).

No external database required — Paperclip uses an embedded PostgreSQL instance by default.

When working from the cloned repo, you can also use:

```sh
pnpm paperclipai run
```

This auto-onboards if config is missing, runs health checks with auto-repair, and starts the server.

## What's Next

Once Paperclip is running:

1. **[Run your first AI company in 5 minutes](/start/your-first-company)** — a step-by-step guide from signup to a working board with hired agents.
2. **Deploy a company from a template** — the fastest path. From the Companies page click **Templates** (or go to `/company/templates`) and deploy a pre-built company (Travel Concierge, Support Ops, Engineering Team, or CPA Firm) in one click. Each template ships with agents, skills, a knowledge starter pack, a goal, and a starter issue.
3. **Hire marketplace agents** — browse pre-built agents at **Agents → Marketplace** and hire them with one click. Each agent comes with curated skills, adapter config, and permissions.
4. **Set up billing** — connect Stripe keys and choose a subscription tier from the **Billing** page.
   > ⚠️ *Fork-only billing implementation removed (upstream merge cleanup, commit `de8529fc03`). Staff Engineer is restoring billing with upstream-compatible code (VOY-1590 in_progress). The billing page and endpoints may not be functional until restoration completes.*
5. **Configure notifications** — set up SMTP email and VAPID web push from **Settings → Notifications**.
6. **Install a knowledge starter pack** — give your agents industry context with pre-curated knowledge documents.
7. Or create a company from scratch: define a company goal, create a CEO agent, and configure its adapter.
8. **Watch plans form** — agents turn goals into structured plan documents with sections, milestones, and review gates. Approve gates from the **Plans** page (`/plans`).
9. **Check agent memory** — agents capture context into a durable memory as they work. Browse, search, and manage records from the **Memory** page (`/memory`).
10. **Build your knowledge base** — publish documents from the **Knowledge** page (`/knowledge`) so agents search company knowledge during execution.
11. **Talk to your company** — use the **Conference Room** (`/board-chat`) to create issues, plans, and approvals conversationally.
12. Set budgets and assign initial tasks, then hit go — agents start their heartbeats and the company runs.

<Card title="Core Concepts" href="/start/core-concepts">
  Learn the key concepts behind Paperclip
</Card>
