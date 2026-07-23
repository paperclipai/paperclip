# Observability

Fetch https://developers.cloudflare.com/agents/api-reference/observability/ for complete documentation.

Agents emit structured events via Node.js `diagnostics_channel`. Subscribe in development or forward via Tail Workers in production.

## Subscribe to Events

```typescript
import { subscribe } from "agents/observability";

subscribe("agents:rpc", (event) => {
  console.log(`RPC call: ${event.payload.method}`);
});

subscribe("agents:state", (event) => {
  console.log(`State change on ${event.agent}`);
});
```

## Available Channels

| Channel | Events |
|---------|--------|
| `agents:state` | State changes |
| `agents:rpc` | `@callable` invocations |
| `agents:message` | WebSocket messages |
| `agents:schedule` | Schedule triggers |
| `agents:lifecycle` | Agent start, connect, disconnect |
| `agents:workflow` | Workflow progress, completion, errors |
| `agents:mcp` | MCP server connections, tool calls |
| `agents:email` | Email received |

## Per-Agent Override

```typescript
export class MyAgent extends Agent<Env, State> {
  observability = undefined; // disable for this agent
}
```

## Production: Tail Workers

In production, events appear as `diagnosticsChannelEvents` on the Tail Worker `event` object. Attach a Tail Worker to your agent's Worker to forward events to your observability platform.
