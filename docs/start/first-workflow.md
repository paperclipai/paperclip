---
title: Your first workflow
summary: Go from a fresh install to a working agent heartbeat in under 15 minutes.
---

This guide gets Paperclip running end-to-end. You will create a company, hire an agent, give it a task, and watch the agent wake up and do work.

Two tracks are included:

- **Track A — AI agent (Claude Code / Codex / Cursor / Gemini / Grok / OpenCode / Pi):** best if you already have one of those CLI harnesses installed. You will see a real LLM plan and execute a tiny task, and the agent will mark the task done.
- **Track B — Shell smoke test (process adapter):** no LLM, no external API keys. You will see the heartbeat machinery wake a process agent, run a command, and complete a run. The task stays open so you can mark it done manually.

If you are not sure which to pick, start with **Track B**. It proves the control plane works in minutes.

---

## What you will build

A company with one agent and one completed heartbeat. The flow looks like this:

```text
You create a company
    └─► You create an agent
          └─► You create a task and assign it to the agent
                └─► Heartbeat wakes the agent
                      └─► Agent checks out the task and runs
                            └─► You see the result in the UI
```

---

## Before you start

You need:

- Docker and Docker Compose installed
- Git
- A terminal with `npx` (Node.js is installed automatically by the onboarding command if needed)
- For Track A only: a supported LLM CLI harness installed and authenticated (Claude Code, Codex, Cursor, Gemini CLI, Grok Build, OpenCode, or Pi)

---

## Start the control plane

Run the onboarding command. It downloads Paperclip, starts the web UI, and prints a local URL.

```bash
npx paperclipai onboard --yes
```

When you see a URL like `http://localhost:3100`, open it in your browser.

If you prefer to run from source, clone the repo and use `pnpm install` then `pnpm dev` as described in the [development guide](/doc/DEVELOPING.md).

---

## Track A — AI agent workflow

### 1. Create a company

In the left sidebar, click the company name, then choose **New company**. Give it a name and save it.

> You only do this once per Paperclip instance. The company owns your agents, goals, and tasks.

### 2. Hire a CEO agent

1. Click **New agent** in the sidebar.
2. Choose **Configure a runtime manually**.
3. Select your harness, for example **Claude Code** or **Codex**.
4. Set:
   - **Name:** `CEO`
   - **Role:** `ceo`
   - **Title:** `CEO`
5. Save the agent.

The agent is now part of the company org chart. Its status card should show `idle`.

### 3. Create a task

1. Click **New Task** in the sidebar.
2. Enter a title like `Write a one-sentence description of our company`.
3. Set **Priority** to `medium` and **Status** to `todo`.
4. In the **Assignee** field, pick the `CEO` agent you just created.
5. Save the task.

### 4. Wake the agent

Open the task detail. Click **Wake agent** or **Invoke heartbeat**. The agent checks out the task, runs a heartbeat, and starts working.

Within a minute or two you will see:

- A new run entry on the **Timeline** tab.
- A comment from the agent with a draft company description.
- The task status moves to `done`.

You can click the run to inspect the full log, cost, and reasoning trace.

---

## Track B — Shell smoke test with the process adapter

This track does not need an LLM. It uses the Paperclip REST API to create a simple shell agent and runs a heartbeat.

### 1. Create a company and a process agent

Run the following in your terminal. The examples assume the server is running at `http://localhost:3100` and that you are authenticated as a board user (for example, by copying the `Cookie` header from your logged-in browser session).

```bash
export API=http://localhost:3100/api

COMPANY=$(curl -sS -X POST "$API/companies" \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo Co","description":"First workflow test"}' | jq -r '.id')

AGENT=$(curl -sS -X POST "$API/companies/$COMPANY/agents" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"ShellAgent",
    "role":"ceo",
    "title":"CEO",
    "capabilities":"Runs a simple shell command to complete a first task.",
    "adapterType":"process",
    "adapterConfig":{
      "command":"bash",
      "args":["-c","date -u; echo Hello from the Paperclip process adapter"]
    }
  }' | jq -r '.id')
```

### 2. Create a task and assign it

```bash
ISSUE=$(curl -sS -X POST "$API/companies/$COMPANY/issues" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\":\"Run the first shell workflow\",
    \"description\":\"Smoke-test task for the process adapter.\",
    \"priority\":\"medium\",
    \"status\":\"todo\",
    \"assigneeAgentId\":\"$AGENT\"
  }" | jq -r '.id')
```

### 3. Wake the agent

```bash
curl -sS -X POST "$API/agents/$AGENT/wakeup" \
  -H "Content-Type: application/json" \
  -d '{"reason":"first workflow test"}' | jq .
```

Refresh the task in the web UI. You will see:

- A new run on the **Timeline** tab.
- The run status becomes `succeeded`.
- The run log contains the `date` output and the `Hello from the Paperclip process adapter` line.

The process adapter does not automatically close issues, so after you confirm the run succeeded, open the task and click **Mark as done**.

---

## Next steps

- Read the [core concepts](core-concepts) to understand companies, agents, issues, and heartbeats.
- Explore the [architecture overview](architecture).
- Browse the [adapters](/adapters/overview) to plug in your preferred LLM harness.
- Set up [local development](/doc/DEVELOPING.md) if you want to extend Paperclip.
