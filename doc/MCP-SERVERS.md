# MCP Servers

Paperclip can register MCP servers at the company level, test them, snapshot their catalogs, and bind them to agents as callable tools.

This keeps MCP access inside the same company-scoped control plane as agents, projects, issues, and secrets.

## What Ships Today

- Company-scoped MCP server registry
- Agent-to-MCP bindings with `allowed`, `preferred`, or `required` mode
- Catalog discovery snapshots for `tools`, `resources`, and `prompts`
- Board UI for:
  - creating and editing MCP servers
  - testing and discovering catalogs
  - binding MCP servers to agents
- Agent-facing MCP tool APIs:
  - `GET /api/agents/me/mcp-tools`
  - `POST /api/agents/me/mcp-tools/execute`

## Current Transport Support

### `stdio`

`stdio` is the operational transport in the current implementation.

Supported fields:

- command
- args
- working directory
- environment variables
- forwarded host environment variables

### `http`

`http` configuration can be saved in the registry UI, including:

- URL
- bearer token environment variable name
- static headers
- headers derived from host environment variables

Current limitation:

- HTTP MCP discovery and execution are not implemented yet
- the settings are persisted so the shape is ready for future transport support

## How It Works

1. A board operator creates an MCP server in `Settings -> MCP Servers`
2. Paperclip stores the MCP definition under the selected company
3. The operator runs **Test & Discover**
4. Paperclip connects to the MCP server, initializes it, and stores a catalog snapshot
5. The operator binds the MCP server to one or more agents
6. During a run, the agent can list its bound MCP tools and execute them through Paperclip

## Secrets and Sensitive Values

Paperclip does not need to store raw secrets inline in agent-facing config payloads.

- plain MCP metadata is stored in the database
- secret-aware env bindings use the standard company secrets system
- local installs use the `local_encrypted` secrets provider by default

See [doc/DATABASE.md](./DATABASE.md) for the storage model.

## Data Model

The MCP registry uses three core tables:

- `mcp_servers`
- `agent_mcp_servers`
- `mcp_server_catalog_snapshots`

The registry is company-scoped end to end:

- MCP servers belong to one company
- agent bindings must stay within the same company
- discovery snapshots are attached to the registered MCP server

## API Surface

Board APIs:

- `GET /api/companies/:companyId/mcp-servers`
- `POST /api/companies/:companyId/mcp-servers`
- `GET /api/mcp-servers/:id`
- `PATCH /api/mcp-servers/:id`
- `DELETE /api/mcp-servers/:id`
- `POST /api/mcp-servers/:id/test`
- `GET /api/mcp-servers/:id/catalog-snapshots/latest`
- `GET /api/agents/:agentId/mcp-servers`
- `POST /api/agents/:agentId/mcp-servers`
- `PATCH /api/agents/:agentId/mcp-servers/:mcpServerId`
- `DELETE /api/agents/:agentId/mcp-servers/:mcpServerId`

Agent APIs:

- `GET /api/agents/me/mcp-tools`
- `POST /api/agents/me/mcp-tools/execute`

## Notes for Contributors

This feature touches core board UX, schema, and agent runtime behavior.

Before extending it further, keep these constraints in mind:

- company boundaries must stay enforced on every route and lookup
- discovery snapshots should stay append-only
- secret values should continue using the shared secret binding model
- HTTP transport should not be documented as operational until discovery and execution actually land
