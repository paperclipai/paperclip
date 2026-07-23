# Human-in-the-Loop

Fetch https://developers.cloudflare.com/agents/concepts/human-in-the-loop/ for complete documentation.

Multiple patterns for adding human approval to agent actions.

## Decision Guide

| Pattern | Best for |
|---------|----------|
| Workflows `waitForApproval` | Long-running background tasks |
| AI SDK `needsApproval` on tools | Chat tool calls requiring approval |
| Client tools (`onToolCall`) | Tools that execute in the browser |
| MCP `elicitInput` | Gathering structured input from MCP clients |

## Workflow Approvals

```typescript
// In AgentWorkflow:
const approved = await step.waitForEvent<{ approved: boolean }>("approval", {
  timeout: "7d"
});
if (!approved.approved) throw new Error("Rejected");

// From agent:
await this.approveWorkflow(workflowId);
await this.rejectWorkflow(workflowId);
```

## Chat Tool Approvals (`needsApproval`)

```typescript
const tools = {
  deleteItem: tool({
    description: "Delete an item",
    parameters: z.object({ id: z.string() }),
    execute: async ({ id }) => { /* delete */ },
    needsApproval: true  // or a function: (toolCall) => boolean
  })
};
```

Client handles approval:

```tsx
const { addToolApprovalResponse, addToolOutput } = useAgentChat({
  agent,
  onToolCall: async ({ toolCall }) => {
    if (confirm(`Allow ${toolCall.toolName}?`)) {
      return { approve: true };
    }
    return { approve: false };
  }
});
```

To deny with a custom message:

```tsx
addToolOutput(toolCallId, "output-error", "User rejected this action");
```

## Important

- `waitForApproval` may return `undefined` on timeout — handle it
- `addToolOutput` with `output-error` does NOT auto-continue the LLM — you may need `sendMessage` after
- For OpenAI Agents SDK, use `needsApproval` on the tool definition (same pattern)
