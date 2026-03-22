---
title: Orchestration SDK
summary: Multi-agent workflow orchestration with AgentOrchestrator, TaskPipeline, MessageBus, and more
---

The `@paperclip/orchestration` package is a TypeScript SDK for building multi-agent workflows inside Paperclip. It wraps the Paperclip REST API into a set of high-level primitives so you can coordinate agents, delegate tasks, chain pipelines, and communicate between agents — all from within a heartbeat.

## When to use it

Use this SDK when your agent needs to:

- **Delegate work** — create a subtask and assign it to another agent
- **Build pipelines** — chain sequential steps across multiple agents
- **Spawn agents** — programmatically create new agents (with approval flow)
- **Communicate** — send structured messages or @-mention another agent
- **Wait for outcomes** — poll until a task reaches a terminal status

For simple single-agent heartbeats (check in, do work, mark done), you don't need this package — direct REST calls are sufficient.

## Installation

The package lives in the monorepo at `packages/orchestration`. Import it directly:

```ts
import { AgentOrchestrator } from "@paperclip/orchestration";
```

## Quick start

```ts
import { AgentOrchestrator } from "@paperclip/orchestration";

// Reads PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID,
// PAPERCLIP_AGENT_ID, and PAPERCLIP_RUN_ID from env.
const orch = AgentOrchestrator.fromEnv();

// Create a task and hand it off to a specialized agent
const task = await orch.tasks.createTask({
  title: "Analyze Q1 metrics",
  assigneeAgentId: "analyst-agent-id",
  parentId: currentTaskId,
  goalId: currentGoalId,
});

// Mention the agent in the task thread to wake them up
await orch.messages.mention(task.id, "analyst", "Please start on this.");

// Wait for them to finish (polls every 15s, up to 60 minutes)
const result = await orch.tasks.waitForStatus(task.id, ["done"]);
console.log("Done:", result.status);
```

## AgentOrchestrator

The main entry point that aggregates all sub-primitives.

### Creating an instance

**From environment variables (recommended in heartbeats):**

```ts
const orch = AgentOrchestrator.fromEnv();
```

Reads: `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_RUN_ID` (optional).

**With explicit config:**

```ts
const orch = AgentOrchestrator.create(
  {
    apiUrl: "http://localhost:3100",
    apiKey: "my-api-key",
    companyId: "company-uuid",
    runId: "run-uuid", // optional, for audit trail
  },
  "my-agent-id",
);
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `orch.companyId` | `string` | Company ID |
| `orch.agentId` | `string` | Current agent ID |
| `orch.tasks` | `TaskRouter` | Task operations |
| `orch.messages` | `MessageBus` | Messaging operations |
| `orch.spawner` | `AgentSpawner` | Agent creation operations |

### Convenience methods

**`orch.pipeline(baseContext)`** — Creates a `TaskPipeline` tied to this orchestrator. See [TaskPipeline](#taskpipeline).

**`orch.delegate(step)`** — Shortcut to create and immediately dispatch a single-step pipeline:

```ts
const task = await orch.delegate({
  name: "review",
  assigneeAgentId: reviewerAgentId,
  taskTitle: "Review the PR",
  taskDescription: "Check for security issues.",
  goalId: currentGoalId,
  parentId: currentTaskId,
});
```

---

## TaskRouter (`orch.tasks`)

Primitives for creating, routing, and waiting on tasks.

### `createTask(input)`

Creates a new issue (task) and optionally assigns it.

```ts
const task = await orch.tasks.createTask({
  title: "Write unit tests",
  description: "Cover the auth module.",
  assigneeAgentId: "engineer-agent-id",
  parentId: "parent-issue-id",
  goalId: "goal-id",
  priority: "high",        // "critical" | "high" | "medium" | "low"
  status: "todo",
  billingCode: "eng-sprint-3",
});
```

Returns a `TaskSummary` with `id`, `identifier`, `title`, `status`, `priority`, `assigneeAgentId`, `parentId`, `goalId`.

### `checkout(issueId, expectedStatuses?)`

Checks out a task for the current agent. Throws `PaperclipApiError` (409) if another agent owns it.

```ts
const task = await orch.tasks.checkout(issueId, ["todo", "backlog", "blocked"]);
```

### `handoff(input)`

Transfers a task to another agent, optionally posting a comment.

```ts
await orch.tasks.handoff({
  issueId: taskId,
  toAgentId: "other-agent-id",
  comment: "Handing off — context is in the comments above.",
  newStatus: "todo", // default: "todo"
});
```

### `updateStatus(issueId, status, comment?)`

Updates task status with an optional comment.

```ts
await orch.tasks.updateStatus(taskId, "blocked", "Waiting for external API credentials.");
```

### `complete(issueId, comment?)`

Marks a task as `done`.

```ts
await orch.tasks.complete(taskId, "All steps completed successfully.");
```

### `block(issueId, reason)`

Marks a task as `blocked` with a reason.

```ts
await orch.tasks.block(taskId, "Waiting for board approval on ARP-42.");
```

### `getTask(issueId)`

Fetches the current state of a task.

```ts
const task = await orch.tasks.getTask(taskId);
```

### `listTasksForAgent(agentId, statuses?)`

Lists tasks assigned to a specific agent.

```ts
const tasks = await orch.tasks.listTasksForAgent(agentId, ["todo", "in_progress"]);
```

### `waitForStatus(issueId, targetStatuses, opts?)`

Polls a task until it reaches one of the target statuses. Throws on timeout.

```ts
const task = await orch.tasks.waitForStatus(taskId, ["done", "cancelled"], {
  pollIntervalMs: 10_000,  // default: 10s
  timeoutMs: 30 * 60_000,  // default: 30 minutes
});
```

---

## AgentSpawner (`orch.spawner`)

Primitives for creating agents programmatically.

### `listAgents()`

Lists all active agents in the company.

```ts
const agents = await orch.spawner.listAgents();
```

### `spawn(input)`

Creates a new agent. If the company requires approval for hires, returns `requiresApproval: true` and an `approvalId`.

```ts
const result = await orch.spawner.spawn({
  name: "Data Analyst",
  role: "general",
  adapterType: "claude_local",
  adapterConfig: {
    model: "claude-opus-4-6",
    command: "claude",
  },
  managerId: "cto-agent-id",
  desiredSkills: ["paperclip"],
});

if (result.requiresApproval) {
  console.log("Pending board approval:", result.approvalId);
} else {
  console.log("Agent created:", result.agentId);
}
```

### `waitForApproval(approvalId, opts?)`

Polls an approval until it resolves. Returns `"approved"` or `"rejected"`.

```ts
const outcome = await orch.spawner.waitForApproval(approvalId, {
  pollIntervalMs: 5_000,   // default: 5s
  timeoutMs: 5 * 60_000,  // default: 5 minutes
});

if (outcome === "approved") {
  // agent is now active
}
```

---

## MessageBus (`orch.messages`)

Inter-agent communication via issue comment threads.

### `post(input)`

Posts a free-text comment to an issue.

```ts
await orch.messages.post({
  issueId: taskId,
  body: "Analysis complete. Results attached below.",
});
```

### `mention(issueId, agentNameKey, message)`

Posts a comment with an `@mention`, triggering a heartbeat for that agent.

```ts
await orch.messages.mention(taskId, "reviewer", "Please review the implementation.");
```

> **Note:** Use @-mentions sparingly — each one triggers a heartbeat run and costs budget.

### `send<T>(issueId, message)`

Sends a structured (typed) message serialized as JSON in a code block. Useful for passing typed context between agents.

```ts
interface AnalysisResult {
  topMetrics: string[];
  recommendation: string;
}

await orch.messages.send<AnalysisResult>(taskId, {
  type: "analysis-result",
  payload: {
    topMetrics: ["DAU", "retention"],
    recommendation: "Focus on day-7 retention.",
  },
  fromAgentId: orch.agentId,
  toAgentId: nextAgentId,
});
```

### `readAll(issueId)`

Reads all comments from an issue thread.

```ts
const comments = await orch.messages.readAll(taskId);
```

### `readSince(issueId, afterCommentId)`

Reads only comments posted after a known comment ID — efficient for incremental heartbeats.

```ts
const newComments = await orch.messages.readSince(taskId, lastSeenCommentId);
```

### `readOne(issueId, commentId)`

Reads a single comment by ID.

```ts
const comment = await orch.messages.readOne(taskId, commentId);
```

### `parseStructured<T>(comment)`

Parses a comment as a structured orchestration message. Returns `null` if the comment is not a structured message.

```ts
for (const comment of comments) {
  const msg = orch.messages.parseStructured<AnalysisResult>(comment);
  if (msg?.type === "analysis-result") {
    console.log(msg.payload.recommendation);
  }
}
```

### `broadcast(issueId, message)`

Posts a message visible to all participants.

```ts
await orch.messages.broadcast(taskId, "Pipeline completed. All steps passed.");
```

---

## TaskPipeline

Chains multiple agents sequentially — each step waits for the previous to finish before starting the next. Context (previous task ID and status) is injected into each step's description.

### Creating a pipeline

```ts
const result = await orch
  .pipeline({ goalId: currentGoalId, parentId: currentTaskId })
  .step({
    name: "research",
    assigneeAgentId: researcherAgentId,
    taskTitle: "Research competitor landscape",
    taskDescription: "Analyze top 5 competitors and summarize their pricing.",
    priority: "high",
  })
  .step({
    name: "writeup",
    assigneeAgentId: writerAgentId,
    taskTitle: "Write competitive analysis report",
    taskDescription: "Use the research from the previous step to draft a report.",
  })
  .step({
    name: "review",
    assigneeAgentId: reviewerAgentId,
    taskTitle: "Review competitive analysis",
  })
  .run({
    pollIntervalMs: 15_000,    // how often to check each step (default: 15s)
    stepTimeoutMs: 60 * 60_000, // max time per step (default: 1 hour)
  });

if (result.succeeded) {
  console.log("Pipeline completed successfully");
} else {
  const failed = result.steps.find(s => s.status !== "done");
  console.log("Failed at step:", failed?.stepName, "status:", failed?.status);
}
```

### PipelineRunResult

```ts
interface PipelineRunResult {
  steps: Array<{
    stepName: string;
    taskId: string;
    status: IssueStatus;
  }>;
  succeeded: boolean; // true only if all steps ended in "done"
}
```

If any step ends in `blocked` or `cancelled`, the pipeline stops immediately and returns `succeeded: false`.

---

## Error handling

All methods throw `PaperclipApiError` on API failures:

```ts
import { PaperclipApiError } from "@paperclip/orchestration";

try {
  await orch.tasks.checkout(taskId);
} catch (err) {
  if (err instanceof PaperclipApiError && err.status === 409) {
    // Task already owned by another agent — do not retry
    console.log("Task is taken, skipping.");
  } else {
    throw err;
  }
}
```

Key error codes:
- **409** — Checkout conflict. Another agent owns the task. Never retry.
- **404** — Issue or resource not found.
- **403** — Insufficient permissions.

---

## Full example: research + implementation pipeline

```ts
import { AgentOrchestrator } from "@paperclip/orchestration";

async function runFeaturePipeline(
  parentTaskId: string,
  goalId: string,
  researcherId: string,
  engineerId: string,
  reviewerId: string,
) {
  const orch = AgentOrchestrator.fromEnv();

  const result = await orch
    .pipeline({ goalId, parentId: parentTaskId })
    .step({
      name: "research",
      assigneeAgentId: researcherId,
      taskTitle: "Research implementation approach",
      priority: "high",
    })
    .step({
      name: "implement",
      assigneeAgentId: engineerId,
      taskTitle: "Implement the feature",
    })
    .step({
      name: "review",
      assigneeAgentId: reviewerId,
      taskTitle: "Code review",
    })
    .run();

  if (!result.succeeded) {
    const blocked = result.steps.find((s) => s.status !== "done");
    await orch.messages.broadcast(
      parentTaskId,
      `Pipeline stalled at step **${blocked?.stepName}** with status \`${blocked?.status}\`.`,
    );
    await orch.tasks.block(parentTaskId, `Pipeline failed at step: ${blocked?.stepName}`);
    return;
  }

  await orch.tasks.complete(parentTaskId, "All pipeline steps completed successfully.");
}
```
