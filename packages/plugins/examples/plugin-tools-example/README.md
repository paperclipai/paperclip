# Tools Example Plugin

This example shows **how to add a tool that all agents can use**. Once the plugin is installed and enabled for a company, every agent in that company can call your tools during their runs.

## What this plugin does

- **Calculator** — Performs add, subtract, multiply, divide. Demonstrates parameters, validation, and returning both human-readable `content` and structured `data`.
- **Weather Lookup** — Returns mock weather for a city. Demonstrates optional activity logging when an agent uses a tool.

Tools are namespaced by the host (e.g. `paperclip.tools-example:calculator`), so they never clash with core or other plugins.

## How to add a tool for all agents

### 1. Declare the capability and tools in the manifest

In `manifest.ts`:

- Add `"agent.tools.register"` to `capabilities`.
- Add a `tools` array. Each tool has:
  - `name` — unique within the plugin (used when registering the handler).
  - `displayName` — shown in the UI.
  - `description` — shown to the agent so it knows when to use the tool.
  - `parametersSchema` — JSON Schema for the tool’s input (same shape as your handler’s `params`).

### 2. Register the handler in the worker

In `setup(ctx)`:

```ts
ctx.tools.register(
  "my-tool",                    // must match manifest tool `name`
  {
    displayName: "My Tool",
    description: "What this tool does and when to use it.",
    parametersSchema: {
      type: "object",
      required: ["input"],
      properties: {
        input: { type: "string", description: "User input" },
      },
    },
  },
  async (params, runCtx) => {
    const { input } = params as { input: string };
    // runCtx has agentId, runId, companyId, projectId

    // Optional: log that an agent used this tool
    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Agent used my-tool with: ${input}`,
      entityType: "agent",
      entityId: runCtx.agentId,
    });

    return {
      content: "Human-readable result for the agent.",
      data: { result: "structured data" },
    };
    // On error: return { error: "Error message" };
  },
);
```

### 3. Build and install

```bash
pnpm build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-tools-example
```

Enable the plugin for a company in the Paperclip UI. After that, all agents in that company will see and can call your tools.

## Tool result shape

- **Success:** `{ content?: string, data?: unknown }`. `content` is shown to the agent; `data` is for structured use (e.g. run logs).
- **Failure:** `{ error: string }`. The agent sees the error and can retry or report it.

## References

- [PLUGIN_SPEC.md §11 — Agent Tools](../../../../doc/plugins/PLUGIN_SPEC.md) — tool declaration, execution, and constraints.
- [PLUGIN_AUTHORING_GUIDE.md — Agent Tools](../../../../doc/plugins/PLUGIN_AUTHORING_GUIDE.md) — `ctx.tools.register` and capabilities.
