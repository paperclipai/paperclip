# Think (Experimental)

Fetch https://developers.cloudflare.com/agents/api-reference/think/ for complete documentation.

`@cloudflare/think` — a higher-level chat agent class that handles the `streamText` loop, tool execution, and message persistence for you. You provide `getModel()` and `getSystemPrompt()`; Think handles the rest.

```bash
npm install @cloudflare/think
```

## Minimal Agent

```typescript
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";

export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-4-scout-17b-16e-instruct");
  }

  getSystemPrompt() {
    return "You are a helpful assistant.";
  }
}

export default {
  fetch: (req, env) => routeAgentRequest(req, env)
};
```

## Wrangler Config

```jsonc
{
  "compatibility_flags": ["nodejs_compat", "experimental"],
  "durable_objects": {
    "bindings": [{ "name": "MyAgent", "class_name": "MyAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyAgent"] }],
  "ai": { "binding": "AI" }
}
```

**Note:** Think requires the `experimental` compatibility flag.

## Custom Tools

```typescript
import { tool } from "ai";
import { z } from "zod";

export class MyAgent extends Think<Env> {
  getTools() {
    return {
      getWeather: tool({
        description: "Get weather",
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `72°F in ${city}`
      })
    };
  }
}
```

## Lifecycle Hooks

| Hook | When | Use for |
|------|------|---------|
| `configureSession()` | Agent starts | Set up memory, context providers |
| `beforeTurn(ctx)` | Before each LLM call | Per-turn model/tools/system prompt; return `TurnConfig` |
| `onChunk(chunk)` | Each streaming chunk | Progress tracking |
| `onChatResponse(result)` | After LLM turn completes | Chaining, follow-up `saveMessages` |
| `onChatError(error)` | On LLM error | Error handling |

```typescript
async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
  if (ctx.continuation) {
    return { model: cheaperModel };
  }
  return {};
}
```

## Sub-Agents

```typescript
const child = this.subAgent(SpecialistAgent, "specialist-1");
await child.chat("Analyze this data...", (chunk) => {
  // stream callback
});
```

## Client

Same React hooks as `AIChatAgent`:

```tsx
const agent = useAgent({ agent: "MyAgent", name: "session-1" });
const { messages, input, handleInputChange, handleSubmit } = useAgentChat({ agent });
```

## Think vs AIChatAgent

| | Think | AIChatAgent |
|-|-------|-------------|
| `streamText` loop | Built-in | You write it |
| Tool execution | Automatic | You wire it |
| Customization | Override hooks | Full control in `onChatMessage` |
| Built-in tools | Workspace, execute, browser | None |
| Compatibility flag | Requires `experimental` | Standard |
