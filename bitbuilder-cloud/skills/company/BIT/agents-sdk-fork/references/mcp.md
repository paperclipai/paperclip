# MCP Integration

Fetch https://developers.cloudflare.com/agents/api-reference/mcp-client-api/ and https://developers.cloudflare.com/agents/api-reference/mcp-agent-api/ for complete documentation.

Agents include a multi-server MCP client for connecting to external MCP servers, and `McpAgent` for building MCP servers.

## Add an MCP Server

```typescript
import { Agent, callable } from "agents";

export class MyAgent extends Agent<Env, State> {
  @callable()
  async addServer(name: string, url: string) {
    // Options-based API (recommended)
    const result = await this.addMcpServer(name, url, {
      callbackHost: "https://my-worker.workers.dev",
      transport: { headers: { Authorization: "Bearer ..." } }
    });

    if (result.state === "authenticating") {
      // OAuth required - redirect user to result.authUrl
      return { needsAuth: true, authUrl: result.authUrl };
    }

    return { ready: true, id: result.id };
  }
}
```

## Use MCP Tools

```typescript
async onChatMessage() {
  // Get AI-compatible tools from all connected MCP servers
  const mcpTools = this.mcp.getAITools();
  
  const allTools = {
    ...localTools,
    ...mcpTools
  };

  const result = streamText({
    model: openai("gpt-4o"),
    messages: await convertToModelMessages(this.messages),
    tools: allTools
  });
  
  return result.toUIMessageStreamResponse();
}
```

## List MCP Resources

```typescript
// List all registered servers
const servers = this.mcp.listServers();

// List tools from all servers
const tools = this.mcp.listTools();

// List resources
const resources = this.mcp.listResources();

// List prompts
const prompts = this.mcp.listPrompts();
```

## Remove Server

```typescript
await this.removeMcpServer(serverId);
```

## Building an MCP Server

Use `McpAgent` from the SDK to create an MCP server.

**Install dependencies:**
```bash
npm install @modelcontextprotocol/sdk zod
```

**Wrangler config:**
```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "MyMCP", "class_name": "MyMCP" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyMCP"] }]
}
```

**Server implementation:**
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type State = { counter: number };

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "MyMCPServer",
    version: "1.0.0"
  });

  initialState = { counter: 0 };

  async init() {
    // Register a resource
    this.server.resource("counter", "mcp://resource/counter", (uri) => ({
      contents: [{ text: String(this.state.counter), uri: uri.href }]
    }));

    // Register a tool
    this.server.registerTool(
      "increment",
      {
        description: "Increment the counter",
        inputSchema: { amount: z.number().default(1) }
      },
      async ({ amount }) => {
        this.setState({ counter: this.state.counter + amount });
        return {
          content: [{ text: `Counter: ${this.state.counter}`, type: "text" }]
        };
      }
    );
  }
}
```

## Serve MCP Server

```typescript
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Streamable HTTP transport (recommended)
    if (url.pathname.startsWith("/mcp")) {
      return MyMCP.serve("/mcp", { binding: "MyMCP" }).fetch(request, env, ctx);
    }

    // SSE transport (legacy, deprecated)
    if (url.pathname.startsWith("/sse")) {
      return MyMCP.serveSSE("/sse", { binding: "MyMCP" }).fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  }
};
```

## Transports

Fetch https://developers.cloudflare.com/agents/api-reference/mcp-transports/ for complete documentation.

| Transport | Use for |
|-----------|---------|
| Streamable HTTP (`serve`) | External/public clients (recommended) |
| SSE (`serveSSE`) | Legacy clients only (deprecated) |
| RPC (`addMcpServer(name, env.Binding)`) | Same-Worker internal calls (fastest) |

### RPC Transport (Same Worker)

```typescript
async onStart() {
  await this.addMcpServer("internal-tools", this.env.MyMCPBinding, {
    props: { userId: this.name }
  });
}
```

## Retry on MCP Connections

```typescript
await this.addMcpServer("tools", url, {
  retry: { maxAttempts: 3, baseDelayMs: 500 }
});
```

## Securing MCP Servers

Fetch https://developers.cloudflare.com/agents/api-reference/securing-mcp-servers/ for complete documentation.

Use `@cloudflare/workers-oauth-provider` to add OAuth in front of your MCP server. See the securing docs for proxy patterns and `redirect_uri` validation.
