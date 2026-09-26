# Codemode (Experimental)

Fetch https://developers.cloudflare.com/agents/api-reference/codemode/ for complete documentation.

Codemode lets LLMs write and execute code that orchestrates your tools, instead of calling them one at a time. The LLM gets a single "write code" tool; generated JavaScript runs in an isolated Worker sandbox.

## When to Use

| Scenario | Use Codemode? |
|----------|---------------|
| Single tool call | No — standard tool calling is simpler |
| Chained tool calls with logic | Yes |
| Conditional logic across tools | Yes |
| MCP multi-server workflows | Yes |
| Simple Q&A chat | No |

## Setup

### Wrangler Config

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }],
  "compatibility_flags": ["nodejs_compat"]
}
```

### Install

```bash
npm install @cloudflare/codemode ai zod
```

## Usage

```typescript
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { streamText, tool, convertToModelMessages } from "ai";
import { z } from "zod";

const tools = {
  getWeather: tool({
    description: "Get weather for a location",
    inputSchema: z.object({ location: z.string() }),
    execute: async ({ location }) => `Weather: ${location} 72°F`
  }),
  sendEmail: tool({
    description: "Send an email",
    inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    execute: async ({ to, subject, body }) => `Email sent to ${to}`
  })
};

export class MyAgent extends Agent<Env, State> {
  async onChatMessage() {
    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER
    });

    const codemode = createCodeTool({ tools, executor });

    const result = streamText({
      model,
      system: "You are a helpful assistant.",
      messages: await convertToModelMessages(this.messages),
      tools: { codemode }
    });

    return result.toUIMessageStreamResponse();
  }
}
```

## With MCP Tools

```typescript
const codemode = createCodeTool({
  tools: {
    ...myTools,
    ...this.mcp.getAITools()
  },
  executor
});
```

## How It Works

1. `createCodeTool` generates TypeScript type definitions from your tools
2. The LLM writes an async arrow function calling `codemode.toolName(args)`
3. Code runs in an isolated Worker sandbox via `DynamicWorkerExecutor`
4. Tool calls route back to the host via Workers RPC
5. External `fetch()` is blocked by default — sandbox can only call your tools

## Network Isolation

```typescript
const executor = new DynamicWorkerExecutor({
  loader: env.LOADER,
  globalOutbound: null           // default — fully isolated
  // globalOutbound: env.MY_SERVICE  // route through a Fetcher
});
```

## Limitations

- Experimental — API may change
- `needsApproval` tools execute immediately in sandbox (no approval pause yet)
- JavaScript execution only
- Requires `worker_loaders` binding
