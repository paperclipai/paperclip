# Client SDK

Fetch https://developers.cloudflare.com/agents/api-reference/client-sdk/ for complete documentation.

## React: `useAgent`

```tsx
import { useAgent } from "agents/react";

function App() {
  const [state, setState] = useState({ count: 0 });

  const agent = useAgent({
    agent: "Counter",
    name: "my-instance",
    onStateUpdate: (newState) => setState(newState),
    onIdentity: (name, agentType) => console.log(`Connected to ${name}`)
  });

  return <button onClick={() => agent.setState({ count: state.count + 1 })}>
    {state.count}
  </button>;
}
```

### Typed RPC via `stub`

```tsx
const agent = useAgent<typeof MyAgent>({
  agent: "MyAgent",
  name: "default"
});

const result = await agent.stub.myMethod(arg1, arg2);
```

### Auth via Query Params

```tsx
useAgent({
  agent: "MyAgent",
  name: "default",
  query: async () => `token=${await getToken()}`,
  queryDeps: [tokenVersion]
});
```

## React: `useAgentChat`

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "ChatAgent", name: "session-1" });

  const { messages, input, handleInputChange, handleSubmit, status } =
    useAgentChat({ agent });

  return (
    <div>
      {messages.map((m) => <div key={m.id}>{m.role}: {m.content}</div>)}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
      </form>
    </div>
  );
}
```

## Vanilla JS: `AgentClient`

```typescript
import { AgentClient } from "agents/client";

const client = new AgentClient({
  agent: "MyAgent",
  name: "default",
  host: "https://my-worker.workers.dev"
});

client.addEventListener("stateUpdate", (e) => console.log(e.state));
const result = await client.call("myMethod", [arg]);
client.close();
```

## `agentFetch` for HTTP-only

```typescript
import { agentFetch } from "agents/client";

const response = await agentFetch({
  agent: "MyAgent",
  name: "default",
  host: "https://my-worker.workers.dev",
  path: "/api/data"
});
```

## Streaming RPC

```typescript
await agent.call("streamResults", ["query"], {
  stream: {
    onChunk: (data) => console.log(data),
    onDone: () => console.log("done"),
    onError: (err) => console.error(err)
  }
});
```
