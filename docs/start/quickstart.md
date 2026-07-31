---
title: Quickstart
summary: Get Paperclip running and run your first agent heartbeat in under 15 minutes.
---

This guide installs Paperclip and runs your first agent workflow in one sitting.

## Install and start Paperclip

The fastest path is the `npx` installer. It downloads Paperclip, creates config and data directories, and starts the web UI.

```sh
npx paperclipai onboard --yes
```

When the command finishes, open `http://localhost:3100` in your browser.

- Rerunning `onboard` keeps your existing config and data paths intact.
- Use `npx paperclipai run` to start Paperclip again later.
- Use `npx paperclipai configure` to edit settings.

> **Note:** `pnpm paperclipai` only works inside a cloned copy of the repository. If you used `npx` for setup, keep using `npx paperclipai`.

### Manual install (from source)

If you prefer to run the latest source:

```sh
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

This starts the API server and UI at [http://localhost:3100](http://localhost:3100). No external database is required — an embedded PostgreSQL instance is created automatically.

---

## Your first workflow in 15 minutes

Once the dashboard is open, follow these steps to see a real agent heartbeat.

### 1. Create a company

In the left sidebar, click the company name, then **New company**. Give it a name and save.

A company owns all your goals, agents, and tasks. You can run many companies from one Paperclip instance.

### 2. Hire a CEO agent

Click **New agent** in the sidebar, then **Configure a runtime manually**. Choose an adapter for an agent you already have installed, for example **Claude Code** or **Codex**. Set:

- **Name:** `CEO`
- **Role:** `ceo`
- **Title:** `CEO`

Save the agent. Its status card should show `idle`.

### 3. Create a task

Click **New task** and enter:

- **Title:** `Write a one-sentence description of our company`
- **Priority:** `medium`
- **Status:** `todo`
- **Assignee:** the `CEO` agent you just created

Save the task.

### 4. Run the heartbeat

Open the task detail and click **Wake agent** or **Invoke heartbeat**. The agent checks out the task, runs a heartbeat, and begins working.

Within a minute or two the task status should move to `done` and the agent will add a comment with the description.

### 5. Inspect the run

Click the run on the **Timeline** tab to see the full log, cost, and reasoning trace.

---

## No LLM? Use the process smoke test

If you do not have Claude Code, Codex, or another supported CLI harness installed, you can still see the heartbeat machinery working in minutes. See the [first workflow guide](first-workflow) for a copy-paste process-adapter smoke test that uses `curl` and a simple shell command.

---

## What's next

- [Core concepts](core-concepts) — companies, agents, goals, issues, and heartbeats
- [Architecture overview](architecture) — how the control plane fits together
- [Adapters](/adapters/overview) — connect your preferred LLM harness or shell script
- [Local development guide](/doc/DEVELOPING.md) — extend Paperclip or contribute

<Card title="Core Concepts" href="/start/core-concepts">
  Learn the key concepts behind Paperclip
</Card>
