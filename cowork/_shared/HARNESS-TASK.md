# Universal CoWork Harness Task Body

This document defines the universal parameterized task body used by CoWork scheduled tasks to trigger Paperclip agent heartbeats. Each agent has a dedicated CoWork scheduled task that sets `AGENT_FOLDER` to the agent's identity directory and runs this harness.

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AGENT_FOLDER` | Absolute path to the agent's identity folder | `/path/to/cowork/agents/cto` |
| `PAPERCLIP_AGENT_ID` | Paperclip agent UUID | `4e5cbf52-a530-439f-917c-a6cfee78d76d` |
| `PAPERCLIP_COMPANY_ID` | Paperclip company UUID | `dbc742c7-9a38-4542-936b-523dfa3a7fd2` |
| `PAPERCLIP_API_URL` | Paperclip API base URL | auto-injected |
| `PAPERCLIP_API_KEY` | Short-lived run JWT | auto-injected |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID | auto-injected |

## Execution Steps

```
1. Set AGENT_FOLDER env var to the agent-specific path.
2. Read ${AGENT_FOLDER}/AGENTS.md — this is the agent's identity and role definition.
3. Read ${AGENT_FOLDER}/HEARTBEAT.md — this is the execution checklist for this heartbeat.
4. Invoke Claude Code with the Paperclip skill loaded.
5. Claude executes the heartbeat procedure:
   a. Identity check (GET /api/agents/me)
   b. Inbox check (GET /api/agents/me/inbox-lite)
   c. Checkout assigned work
   d. Do the work
   e. Update status and post comment
   f. Exit cleanly
6. Write daily note to ${AGENT_FOLDER}/memory/YYYY-MM-DD.md with summary.
```

## Adding a New Agent

Adding a new agent to this system requires only:
1. Create `cowork/agents/{agent-name}/` with four identity files (AGENTS.md, SOUL.md, TOOLS.md, HEARTBEAT.md).
2. Create a CoWork scheduled task pointing to this harness with `AGENT_FOLDER` set to the new agent's path.
3. Update the agent's `instructionsFilePath` in Paperclip to point to `cowork/agents/{agent-name}/AGENTS.md`.

No Paperclip DB changes required beyond the `instructionsFilePath` update.

## CoWork Task Configuration Template

```yaml
name: "Paperclip Heartbeat — {AgentName}"
schedule: "0 * * * *"  # hourly (adjust per agent)
env:
  AGENT_FOLDER: "/path/to/cowork/agents/{agent-name}"
task: |
  Read ${AGENT_FOLDER}/AGENTS.md for role definition.
  Read ${AGENT_FOLDER}/HEARTBEAT.md for execution checklist.
  Execute the heartbeat procedure. Use the paperclip skill for all API calls.
  Write a brief summary to ${AGENT_FOLDER}/memory/$(date +%Y-%m-%d).md.
```

## Migration Status

| Agent | CoWork Task | instructionsFilePath | Status |
|-------|-------------|---------------------|--------|
| CTO | Configured (pilot) | `cowork/agents/cto/AGENTS.md` | Pilot |
| Dev Agent — Products | Pending | `cowork/agents/dev-agent-products/AGENTS.md` | Ready |
| Dev Agent — Platform | Pending | `cowork/agents/dev-agent-platform/AGENTS.md` | Ready |
| Operations Lead | Pending | `cowork/agents/operations-lead/AGENTS.md` | Ready |
| Visibility Agent | Pending | `cowork/agents/visibility-agent/AGENTS.md` | Ready |
| Career Monitor | Pending | `cowork/agents/career-monitor/AGENTS.md` | Ready |
| Learning Agent 2 | Pending | `cowork/agents/learning-agent-2/AGENTS.md` | Ready |
| YouTube Ingest | Pending | `cowork/agents/youtube-ingest/AGENTS.md` | Ready |
| Brand Artist | Pending | `cowork/agents/brand-artist/AGENTS.md` | Ready |
