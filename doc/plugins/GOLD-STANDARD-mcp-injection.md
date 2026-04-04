# Gold Standard: MCP Tool Injection

This document defines the standardized architecture for injecting plugin tools into agent runtimes using the Paperclip MCP Bridge.

---

## Overview

The MCP Bridge allows Paperclip adapters to dynamically discover and inject tools from installed plugins into the LLM's execution context. This ensures that agents always have access to the latest capabilities without manual configuration.

## Key Components

### 1. The MCP Bridge Service
The core service in `server/src/mcp-bridge.ts` that aggregates tools from all active plugins for a specific company or project.

### 2. Adapter Utilities
The `@paperclipai/adapter-utils` package provides helpers like `getPaperclipMcpConfig(ctx)` to simplify tool discovery in adapters.

## Implementation Steps for Adapters

### 1. Fetch Configuration
In your adapter's `execute.ts` or `runtime-config.ts`, fetch the MCP configuration:

```ts
import { getPaperclipMcpConfig } from "@paperclipai/adapter-utils/server-utils";

const mcpConfig = await getPaperclipMcpConfig(ctx);
```

### 2. Inject into Runtime
Pass the `mcpConfig` to your LLM's tool-use parameter. For example, in `claude-local`:

```ts
// Example injection for Claude
const runtimeConfig = {
  ...baseConfig,
  tools: [
    ...baseTools,
    ...mcpConfig.tools.map(tool => formatForClaude(tool))
  ]
};
```

### 3. Handle Execution
The bridge automatically handles the routing of tool calls back to the plugin worker. No additional logic is needed in the adapter for tool dispatching if using the standard `paperclipai execute` flow.

## Key Requirements
- **Identifier Namespacing**: All tools are prefixed with `plugin-id:` to prevent collisions.
- **Authentication**: `PAPERCLIP_API_KEY` must be preserved in the environment for the bridge to authenticate tool requests.
- **Error Handling**: Adapters must gracefully handle cases where the bridge is unavailable or a plugin fails.

---

**Follow this standard to ensure all Paperclip agents remain "Plugin Ready".**
