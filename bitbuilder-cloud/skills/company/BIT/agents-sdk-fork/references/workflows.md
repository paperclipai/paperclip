# Workflows Integration

Fetch https://developers.cloudflare.com/agents/api-reference/run-workflows/ for complete documentation.

## Overview

Agents handle real-time communication; Workflows handle durable execution. Together they enable:

- Long-running background tasks with automatic retries
- Human-in-the-loop approval flows
- Multi-step pipelines that survive failures

| Use Case | Recommendation |
|----------|----------------|
| Chat/messaging | Agent only |
| Quick API calls (<30s) | Agent only |
| Background processing (<30s) | Agent `queue()` |
| Long-running tasks (>30s) | Agent + Workflow |
| Human approval flows | Agent + Workflow |

## AgentWorkflow Base Class

```typescript
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";

type TaskParams = { taskId: string; data: string };

export class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(event: AgentWorkflowEvent<TaskParams>, step: AgentWorkflowStep) {
    const params = event.payload;

    // Durable step - retries on failure
    const result = await step.do("process", async () => {
      return processData(params.data);
    });

    // Non-durable: progress reporting
    await this.reportProgress({ step: "process", percent: 0.5 });

    // Non-durable: broadcast to connected clients
    this.broadcastToClients({ type: "update", taskId: params.taskId });

    // Durable: merge state via step
    await step.mergeAgentState({ lastProcessed: params.taskId });

    // Durable: report completion
    await step.reportComplete(result);

    return result;
  }
}
```

## Wrangler Configuration

```jsonc
{
  "workflows": [
    { "name": "processing-workflow", "binding": "PROCESSING_WORKFLOW", "class_name": "ProcessingWorkflow" }
  ],
  "durable_objects": {
    "bindings": [{ "name": "MyAgent", "class_name": "MyAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyAgent"] }]
}
```

## Agent Methods for Workflows

```typescript
// Start a workflow
const instance = await this.runWorkflow("ProcessingWorkflow", { taskId: "123", data: "..." });

// Send event to waiting workflow
await this.sendWorkflowEvent("ProcessingWorkflow", workflowId, { type: "approve" });

// Query workflows
const workflow = await this.getWorkflow(workflowId);
const workflows = await this.getWorkflows({ status: "running" });

// Control workflows
await this.approveWorkflow(workflowId);
await this.rejectWorkflow(workflowId);
await this.terminateWorkflow(workflowId);
await this.pauseWorkflow(workflowId);
await this.resumeWorkflow(workflowId);

// Delete workflows
await this.deleteWorkflow(workflowId);
await this.deleteWorkflows({ status: "complete", before: new Date(...) });
```

## Lifecycle Callbacks

```typescript
export class MyAgent extends Agent<Env, State> {
  async onWorkflowProgress(workflowName: string, workflowId: string, progress: unknown) {
    // Workflow reported progress via this.reportProgress()
    this.broadcast({ type: "progress", workflowId, progress });
  }

  async onWorkflowComplete(workflowName: string, workflowId: string, result?: unknown) {
    // Workflow finished successfully
  }

  async onWorkflowError(workflowName: string, workflowId: string, error: Error) {
    // Workflow failed
  }

  async onWorkflowEvent(workflowName: string, workflowId: string, event: unknown) {
    // Workflow received an event via sendWorkflowEvent()
  }
}
```

## Human-in-the-Loop

```typescript
// In workflow: wait for approval
const approved = await step.waitForEvent<{ approved: boolean }>("approval", {
  timeout: "7d"
});

if (!approved.approved) {
  throw new Error("Rejected");
}

// From agent: approve or reject
await this.approveWorkflow(workflowId);  // Sends { approved: true }
await this.rejectWorkflow(workflowId);   // Sends { approved: false }
```
