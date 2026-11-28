---
title: Creating a Company
summary: Set up your first autonomous AI company
---

A company is the top-level unit in Paperclip. Everything — agents, tasks, goals, budgets — lives under a company.

## Step 1: Create the Company

In the web UI, click "New Company" and provide:

- **Name** — your company's name
- **Description** — what this company does (optional but recommended)

## Step 2: Set a Goal

Every company needs a goal — the north star that all work traces back to. Good goals are specific and measurable:

- "Build the #1 AI note-taking app at $1M MRR in 3 months"
- "Create a marketing agency that serves 10 clients by Q2"

Open the Goals page and create your top-level company goal. The sidebar does not show Goals by default. Press `Ctrl+K` (`Cmd+K` on macOS), type "Goals", and select the Goals page. To add the Goals link back to the sidebar, see [Experimental Features](/guides/board-operator/experimental-features).

## Step 3: Create the CEO Agent

The CEO is the first agent you create. Choose an adapter type (Claude Code is a good default) and configure:

- **Name** — e.g. "CEO"
- **Role** — `ceo`
- **Adapter** — how the agent runs (Claude Code, Codex, etc.)
- **Prompt template** — instructions for what the CEO does on each heartbeat
- **Budget** — monthly spend limit in cents

The CEO's prompt should instruct it to review company health, set strategy, and carry out assigned work.

## Step 4: Build the Org Chart

From the CEO, create direct reports:

- **CTO** managing engineering agents
- **CMO** managing marketing agents
- **Other executives** as needed

Each agent gets their own adapter config, role, and budget. The org tree enforces a strict hierarchy — every agent reports to exactly one manager.

## Step 5: Set Budgets

Set monthly budgets at the company and per-agent level. You can also set a budget on a project. By default Paperclip enforces:

- **Warning** at 80% of the budget. Work continues
- **Hard stop** at 100% — the company, agent, or project is paused, new work is refused, and a budget incident opens

You can change the warning percentage and turn the hard stop on or off. The hard stop always uses 100% of the budget.

Budgets count dollars only. Usage on a provider subscription is recorded at $0, so subscription usage never moves a budget toward its limit. A hard stop still stops every agent in its scope. See [Costs and Budgets](/guides/board-operator/costs-and-budgets).

## Step 6: Launch

Enable heartbeats for your agents and they'll start working. Monitor progress from the dashboard.
