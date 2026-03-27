---
title: Quickstart
summary: Get Ironworks running in minutes
---

Get Ironworks running locally in under 5 minutes.

## Quick Start (Recommended)

```sh
npx ironworksai onboard --yes
```

This walks you through setup, configures your environment, and gets Ironworks running.

To start Ironworks again later:

```sh
npx ironworksai run
```

> **Note:** If you used `npx` for setup, always use `npx ironworksai` to run commands. The `pnpm ironworksai` form only works inside a cloned copy of the Ironworks repository (see Local Development below).

## Local Development

For contributors working on Ironworks itself. Prerequisites: Node.js 20+ and pnpm 9+.

Clone the repository, then:

```sh
pnpm install
pnpm dev
```

This starts the API server and UI at [http://localhost:3100](http://localhost:3100).

No external database required — Ironworks uses an embedded PostgreSQL instance by default.

When working from the cloned repo, you can also use:

```sh
pnpm ironworksai run
```

This auto-onboards if config is missing, runs health checks with auto-repair, and starts the server.

## What's Next

Once Ironworks is running:

1. Create your first company in the web UI
2. Define a company goal
3. Create a CEO agent and configure its adapter
4. Build out the org chart with more agents
5. Set budgets and assign initial tasks
6. Hit go — agents start their heartbeats and the company runs

<Card title="Core Concepts" href="/start/core-concepts">
  Learn the key concepts behind Ironworks
</Card>
