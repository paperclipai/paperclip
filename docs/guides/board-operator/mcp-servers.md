---
title: External MCP Servers
summary: Give agents external tools (like Linear MCP) with managed auth
---

Agents can use external [MCP](https://modelcontextprotocol.io) servers — hosted tools like Linear's MCP endpoint, or local stdio servers — configured per agent. Paperclip stores the configuration, keeps auth material in the encrypted secret store, and injects everything into the agent's runtime on each run.

## Supported runtimes

| Adapter | Injection |
| --- | --- |
| Claude Code (`claude_local`, `claude_tui`) | Run-scoped `--mcp-config` file with `--strict-mcp-config` and pre-approved `mcp__<name>__*` tools |
| Codex (`codex_local`) | Per-agent `CODEX_HOME/config.toml` `[mcp_servers.*]` tables; header secrets passed by env-var name |
| Cursor (`cursor`) | Per-agent `HOME/.cursor/mcp.json` plus `--approve-mcps` |
| Gemini (`gemini_local`) | Workspace `.gemini/settings.json` with per-server `trust: true` |
| OpenCode (`opencode_local`) | Per-run temp `opencode.json` `mcp` block |

MCP servers of one agent are never visible to another: every runtime gets a per-agent (or per-run) config location.

## The company MCP library (recommended)

Like Skills, MCP servers can be defined once at the company level and enabled per agent:

1. Sidebar → **MCP** — add a server to the company library (stdio command, or http/sse URL; store tokens as secret references, or click **Save & connect** for brokered OAuth).
2. Open an agent → **MCP** tab — tick the servers this agent should use. Changes autosave and apply on the agent's next run.
3. The agent's runtime gets the server's tools (`mcp__<name>__*`).

Library servers are shared: one OAuth connection or API-key secret serves every agent that enables the server. Disabling a library server stops injecting it everywhere without touching agent selections. Deleting one is blocked while agents still use it (or cascade with force).

Agents can self-manage their library selection with the `paperclipListCompanyMcpServers` and `paperclipSyncAgentMcpServers` tools.

```text
GET    /api/companies/:companyId/mcp-servers
POST   /api/companies/:companyId/mcp-servers            { name, description?, config, enabled? }
PATCH  /api/companies/:companyId/mcp-servers/:id
DELETE /api/companies/:companyId/mcp-servers/:id?force=true
POST   /api/companies/:companyId/mcp-servers/:id/oauth/start
GET    /api/agents/:id/mcp-server-refs
PUT    /api/agents/:id/mcp-server-refs                  { desiredMcpServers: string[] }
```

## Per-agent servers (overrides)

Open the agent's **Configuration** tab and find the **MCP Servers** section. Servers defined here belong to this agent only, and override a library server with the same name.

Each server has a name (letters, digits, `-`, `_`) and a transport:

- **stdio** — a local process (`command`, `args`, `env`). The command must be available in the agent's execution environment.
- **http / sse** — a remote endpoint (`url`, request `headers`).

### Auth options

1. **API key / token (recommended):** store the token as a company secret and reference it from a header value (e.g. `Authorization`), a stdio env var, or the server's bearer-token field. Secrets are encrypted at rest, versioned, and resolved only at run launch.
2. **Brokered OAuth:** for OAuth-only servers, click **Connect**. Paperclip runs the OAuth flow (discovery, dynamic client registration, PKCE) in your browser, stores the token as a company secret, refreshes it automatically before runs, and injects it as a bearer header. Headless agents never see a login prompt.

Plain-text sensitive values are accepted but redacted everywhere after saving (API responses, config revisions, activity log). In strict secret mode they are rejected — use secret references.

## Agent self-management

Agents can manage their own MCP servers through the Paperclip MCP tools:

- `paperclipListMcpServers`
- `paperclipAddMcpServer`
- `paperclipRemoveMcpServer`

An agent may modify its own servers; modifying another agent's requires CEO role or the `agents:create` grant. Every change is recorded as a config revision (rollback-able) and an activity-log entry.

## API

```text
GET    /api/agents/:id/mcp-servers
PUT    /api/agents/:id/mcp-servers                 { mcpServers }
POST   /api/agents/:id/mcp-servers                 { name, server }
DELETE /api/agents/:id/mcp-servers/:name
POST   /api/agents/:id/mcp-servers/:name/oauth/start
```

Example — add Linear via API key:

```bash
curl -X POST "$PAPERCLIP_URL/api/agents/$AGENT_ID/mcp-servers" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "linear",
    "server": {
      "transport": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": { "type": "secret_ref", "secretId": "<company-secret-uuid>" }
      }
    }
  }'
```

## Notes and limits

- Tool allowlists: `allowedTools` narrows which of a server's tools are pre-approved (Claude: `mcp__<name>__<tool>`; Gemini: `includeTools`). Codex, Cursor, and OpenCode approve whole servers.
- stdio servers run inside the agent's execution environment — the command (e.g. `npx`) and network access must exist there, including sandboxes.
- Remote `claude_tui` executions skip MCP injection (logged as a warning).
- Brokered OAuth requires the authorization server to support dynamic client registration; otherwise use an API key.
