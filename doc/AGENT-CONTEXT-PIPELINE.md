# Agent Context Pipeline

How agents receive their information — from assignment to execution.

## Overview

Agents don't discover their project or goal on their own. The **heartbeat service** assembles all context before execution and passes it as a structured snapshot. The adapter then **renders it into the system prompt** using templates. The agent receives a fully-constructed prompt that tells it who it is, what issue it's working on, what project that issue belongs to, what comments have been posted, and what instructions to follow.

## 1. Assignment → Heartbeat Wake

When an agent is assigned an issue (via `/issues/:id/checkout`), the heartbeat service (`server/src/services/heartbeat.ts`) queues a wakeup. It creates a `HeartbeatRun` with a `contextSnapshot` — a `Record<string, unknown>` containing everything the agent needs.

## 2. Context Assembly

The context is built up in layers in `heartbeat.ts`:

### Core Identifiers

- `issueId`, `taskId`, `taskKey` — what work to do
- `projectId`, `projectWorkspaceId` — which project it belongs to
- `wakeReason`, `wakeSource` — why the agent was woken (assignment, comment, routine, etc.)

### Workspace Info (`context.paperclipWorkspace`)

- `cwd` — working directory
- `repoUrl`, `repoRef`, `branchName` — git context
- `worktreePath` — isolated worktree path
- `agentHome` — the agent's home directory

### Wake Payload (`context.paperclipWake`)

Built by `buildPaperclipWakePayload()` in `heartbeat.ts`:

- Issue summary (id, title, status, priority)
- Recent comments with author, body, and timestamp
- Execution stage info (for approval workflows)

### Session Continuity

- `resumeSessionParams` — for resuming prior sessions
- `paperclipSessionHandoffMarkdown` — summary from previous session if rotating

## 3. Instructions Loading

The agent instructions service (`server/src/services/agent-instructions.ts`) loads the agent's instruction bundle:

- Default entry file is `AGENTS.md` (or configured per-agent)
- Instructions live in managed paths like `/paperclip-instance/companies/{companyId}/agents/{agentId}/instructions/`
- Different agent roles get different instruction files (e.g., a "ceo" role gets `AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`)

## 4. System Prompt Construction

The adapter (e.g., `packages/adapters/claude-local/src/server/execute.ts`) assembles the final prompt using `joinPromptSections()`:

1. **Bootstrap prompt** — rendered from `config.bootstrapPromptTemplate` with variables like `{{agent.id}}`, `{{agent.name}}`, `{{runId}}` (only on fresh sessions)
2. **Agent instructions** — the loaded instruction file content
3. **Wake prompt** — rendered by `renderPaperclipWakePrompt()` in `packages/adapter-utils/src/server-utils.ts` — contains the issue details, recent comments, and guidance
4. **Session handoff** — context from a previous session if rotating
5. **Main heartbeat prompt** — default: `"You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work."`

## 5. Goal Resolution

Goals use a fallback hierarchy (`server/src/services/issue-goal-fallback.ts`):

1. **Issue-level goal** — if the issue has an explicit `goalId`
2. **Project goal** — inherited from the project
3. **Company goal** — the company's default

## Key Files

| Component | Location |
|-----------|----------|
| Context assembly | `server/src/services/heartbeat.ts` |
| Agent instructions | `server/src/services/agent-instructions.ts` |
| Prompt building (Claude adapter) | `packages/adapters/claude-local/src/server/execute.ts` |
| Wake prompt rendering | `packages/adapter-utils/src/server-utils.ts` |
| Goal fallback | `server/src/services/issue-goal-fallback.ts` |
| Adapter execution types | `packages/adapter-utils/src/types.ts` |
