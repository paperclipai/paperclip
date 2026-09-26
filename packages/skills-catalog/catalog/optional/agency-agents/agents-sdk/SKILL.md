---
name: "agents-sdk"
description: "Build, debug, or review Cloudflare Agents SDK applications using the agents package."
key: "paperclipai/optional/agency-agents/agents-sdk"
recommendedForRoles:
  - "engineer"
  - "designer"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "agents"
  - "sdk"
defaultInstall: false
---
# Cloudflare Agents SDK

Your knowledge of the Agents SDK may be outdated. **Prefer retrieval over pre-training** for any Agents SDK task.

## Retrieval Sources

Cloudflare docs: https://developers.cloudflare.com/agents/

| Topic | Docs URL | Use for |
|-------|----------|---------|
| Getting started | [Quick start](https://developers.cloudflare.com/agents/getting-started/quick-start/) | First agent, project setup |
| Adding to existing project | [Add to existing project](https://developers.cloudflare.com/agents/getting-started/add-to-existing-project/) | Install into existing Workers app |
| Configuration | [Configuration](https://developers.cloudflare.com/agents/api-reference/configuration/) | `wrangler.jsonc`, bindings, assets, deployment |
| Agent class | [Agents API](https://developers.cloudflare.com/agents/api-reference/agents-api/) | Agent lifecycle, patterns, pitfalls |
| State | [Store and sync state](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/) | `setState`, `validateStateChange`, persistence |
| Routing | [Routing](https://developers.cloudflare.com/agents/api-reference/routing/) | URL patterns, `routeAgentRequest` |
| Callable methods | [Callable methods](https://developers.cloudflare.com/agents/api-reference/callable-methods/) | `@callable`, RPC, streaming, timeouts |
| Scheduling | [Schedule tasks](https://developers.cloudflare.com/agents/api-reference/schedule-tasks/) | `schedule()`, `scheduleEvery()`, cron |
| Workflows | [Run workflows](https://developers.cloudflare.com/agents/api-reference/run-workflows/) | `AgentWorkflow`, durable multi-step tasks |
| HTTP/WebSockets | [WebSockets](https://developers.cloudflare.com/agents/api-reference/websockets/) | Lifecycle hooks, hibernation |
| Chat agents | [Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) | `AIChatAgent`, streaming, tools, persistence |
| Client SDK | [Client SDK](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/) | `useAgent`, `AgentClient`, state, RPC, HTTP |
| Client tools | [Client tools](https://developers.cloudflare.com/agents/harnesses/think/client-tools/) | Client-side tools, `autoContinueAfterToolResult` |
| Server-driven messages | [Autonomous responses](https://developers.cloudflare.com/agents/communication-channels/chat/autonomous-responses/) | `saveMessages`, `waitUntilStable`, server-initiated turns |
| Resumable streaming | [Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/#resumable-streaming) | Stream recovery on disconnect |
| Email | [Email](https://developers.cloudflare.com/agents/api-reference/email/) | Email routing, secure reply resolver |
| MCP client | [MCP client](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/) | Connecting to MCP servers |
| MCP server | [MCP server](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) | Building MCP servers with `createMcpHandler` |
| MCP transports | [MCP transports](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/) | Streamable HTTP, SSE, RPC transport options |
| Securing MCP servers | [Securing MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/) | OAuth, proxy MCP, hardening |
| Human-in-the-loop | [Human-in-the-loop](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/) | Workflow approvals, elicitation, timeout handling |
| Durable execution | [Durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/) | `runFiber()`, `stash()`, surviving DO eviction |
| Queue | [Queue](https://developers.cloudflare.com/agents/api-reference/queue-tasks/) | Built-in FIFO queue, `queue()` |
| Retries | [Retries](https://developers.cloudflare.com/agents/api-reference/retries/) | `this.retry()`, backoff/jitter |
| Observability | [Observability](https://developers.cloudflare.com/agents/api-reference/observability/) | Diagnostics-channel events |
| Push notifications | [Push notifications](https://developers.cloudflare.com/agents/communication-channels/webhooks/push-notifications/) | Web Push + VAPID from agents |
| Webhooks | [Webhooks](https://developers.cloudflare.com/agents/communication-channels/webhooks/) | Receiving external webhooks |
| Cross-domain auth | [Cross-domain auth](https://developers.cloudflare.com/agents/runtime/operations/cross-domain-authentication/) | WebSocket auth, tokens, CORS |
| Readonly connections | [Readonly](https://developers.cloudflare.com/agents/api-reference/readonly-connections/) | `shouldConnectionBeReadonly` |
| Voice | [Voice](https://developers.cloudflare.com/agents/api-reference/voice/) | Experimental STT/TTS, `withVoice` |
| Browse the web | [Browser tools](https://developers.cloudflare.com/agents/api-reference/browse-the-web/) | Experimental CDP browser automation |
| Think | [Think](https://developers.cloudflare.com/agents/api-reference/think/) | Experimental higher-level chat agent class |
| Migrations | [AI SDK v5](https://github.com/cloudflare/agents/blob/main/docs/agents/migration-to-ai-sdk-v5.md), [AI SDK v6](https://github.com/cloudflare/agents/blob/main/docs/agents/migration-to-ai-sdk-v6.md) | Upgrading `@cloudflare/ai-chat` |

## Capabilities

The Agents SDK provides:

- **Persistent state** — SQLite-backed, auto-synced to clients via `setState`
- **Callable RPC** — `@callable()` methods invoked over WebSocket
- **Scheduling** — One-time, recurring (`scheduleEvery`), and cron tasks
- **Workflows** — Durable multi-step background processing via `AgentWorkflow`
- **Durable execution** — `runFiber()` / `stash()` for work that survives DO eviction
- **Queue** — Built-in FIFO queue with retries via `queue()`
- **Retries** — `this.retry()` with exponential backoff and jitter
- **MCP integration** — Connect to MCP servers or build your own with `createMcpHandler`
- **Email handling** — Receive and reply to emails with secure routing
- **Streaming chat** — `AIChatAgent` with resumable streams, message persistence, tools
- **Server-driven messages** — `saveMessages`, `waitUntilStable` for proactive agent turns
- **React hooks** — `useAgent`, `useAgentChat` for client apps
- **Observability** — `diagnostics_channel` events for state, RPC, schedule, lifecycle
- **Push notifications** — Web Push + VAPID delivery from agents
- **Webhooks** — Receive and verify external webhooks
- **Voice** (experimental) — STT/TTS via `@cloudflare/voice`
- **Browser tools** (experimental) — CDP-powered browsing via `agents/browser`
- **Think** (experimental) — Higher-level chat agent via `@cloudflare/think`

## FIRST: Verify Installation

```bash
npm ls agents  # Should show agents package
```

If not installed:
```bash
npm install agents
```

For chat agents:
```bash
npm install agents @cloudflare/ai-chat ai @ai-sdk/react
```

## Wrangler Configuration

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "MyAgent", "class_name": "MyAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyAgent"] }]
}
```

**Gotchas:**
- Do NOT enable `experimentalDecorators` in tsconfig (breaks `@callable`)
- Never edit old migrations — always add new tags
- Each agent class needs its own DO binding + migration entry
- Add `"ai": { "binding": "AI" }` for Workers AI

## Agent Class

```typescript
import { Agent, routeAgentRequest, callable } from "agents";

type State = { count: number };

export class Counter extends Agent<Env, State> {
  initialState = { count: 0 };

  validateStateChange(nextState: State, source: Connection | "server") {
    if (nextState.count < 0) throw new Error("Count cannot be negative");
  }

  onStateUpdate(state: State, source: Connection | "server") {
    console.log("State updated:", state);
  }

  @callable()
  increment() {
    this.setState({ count: this.state.count + 1 });
    return this.state.count;
  }
}

export default {
  fetch: (req, env) => routeAgentRequest(req, env) ?? new Response("Not found", { status: 404 })
};
```

## Routing

Requests route to `/agents/{agent-name}/{instance-name}`:

| Class | URL |
|-------|-----|
| `Counter` | `/agents/counter/user-123` |
| `ChatRoom` | `/agents/chat-room/lobby` |

Client: `useAgent({ agent: "Counter", name: "user-123" })`

Custom routing: use `getAgentByName(env.MyAgent, "instance-id")` then `agent.fetch(request)`.

## Core APIs

| Task | API |
|------|-----|
| Read state | `this.state.count` |
| Write state | `this.setState({ count: 1 })` |
| SQL query | `` this.sql`SELECT * FROM users WHERE id = ${id}` `` |
| Schedule (delay) | `await this.schedule(60, "task", payload)` |
| Schedule (cron) | `await this.schedule("0 * * * *", "task", payload)` |
| Schedule (interval) | `await this.scheduleEvery(30, "poll")` |
| RPC method | `@callable() myMethod() { ... }` |
| Streaming RPC | `@callable({ streaming: true }) stream(res) { ... }` |
| Start workflow | `await this.runWorkflow("ProcessingWorkflow", params)` |
| Durable fiber | `await this.runFiber("name", async (ctx) => { ... })` |
| Enqueue work | `this.queue("handler", payload)` |
| Retry with backoff | `await this.retry(fn, { maxAttempts: 5 })` |
| Broadcast to clients | `this.broadcast(message)` |
| Get connections | `this.getConnections(tag?)` |

## React Client

Read [client-sdk.md](references/client-sdk.md) for client selection and current connection examples. For chat UI and tools, also read [streaming-chat.md](references/streaming-chat.md).

## References

### Core
- **[references/state-scheduling.md](references/state-scheduling.md)** — State persistence, scheduling, SQL
- **[references/callable.md](references/callable.md)** — RPC methods, streaming, timeouts
- **[references/routing.md](references/routing.md)** — URL patterns, custom routing, `getAgentByName`
- **[references/configuration.md](references/configuration.md)** — Wrangler config, bindings, Vite setup

### Chat & Streaming
- **[references/streaming-chat.md](references/streaming-chat.md)** — AIChatAgent, resumable streams, tools
- **[references/client-sdk.md](references/client-sdk.md)** — `useAgent`, `useAgentChat`, `AgentClient`
- **[references/server-driven-messages.md](references/server-driven-messages.md)** — Trigger patterns, `saveMessages`
- **[references/human-in-the-loop.md](references/human-in-the-loop.md)** — Approval flows, `needsApproval`

### Background Processing
- **[references/workflows.md](references/workflows.md)** — Durable Workflows integration
- **[references/durable-execution.md](references/durable-execution.md)** — `runFiber`, `stash`, surviving eviction
- **[references/queue-retries.md](references/queue-retries.md)** — Built-in queue, retry with backoff

### Integrations
- **[references/mcp.md](references/mcp.md)** — MCP client and server, transports, securing
- **[references/email.md](references/email.md)** — Email routing and handling
- **[references/webhooks-push.md](references/webhooks-push.md)** — Webhooks, push notifications
- **[references/observability.md](references/observability.md)** — Diagnostics-channel events

### Experimental
- **[references/think.md](references/think.md)** — `@cloudflare/think` higher-level chat agent
- **[references/voice.md](references/voice.md)** — `@cloudflare/voice` STT/TTS
- **[references/codemode.md](references/codemode.md)** — Code Mode for tool orchestration
- **[references/browse-the-web.md](references/browse-the-web.md)** — CDP browser tools
