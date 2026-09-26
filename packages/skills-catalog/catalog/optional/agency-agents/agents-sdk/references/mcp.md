# MCP Integration

For new servers, prefer `createMcpHandler` over the deprecated `McpAgent`. For existing servers, check the installed SDK version and state/session requirements before choosing a migration path.

Read the relevant current documentation for implementation details and supported dependency versions:

| Task | Documentation |
|------|---------------|
| Build a server | [Handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) — server factories, Worker entrypoint, dependencies, and examples |
| Migrate an existing server | [MCP SDK v2 migration](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/) — stateless migration and temporary legacy paths |
| Connect to servers and use their tools | [Client API](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/) — connections, OAuth, tools, resources, and retries |
| Choose a transport | [Transports](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/) — remote HTTP and existing RPC integrations |
| Secure a server | [Securing MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/) — OAuth and proxy security |
