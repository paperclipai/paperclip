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

## Configuring servers

Open the agent's **Configuration** tab and find the **MCP Servers** section.

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
