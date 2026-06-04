---
title: Remote MCP
---

Paperclip exposes a Streamable HTTP MCP endpoint at `/mcp` for Claude Code, Claude Desktop, Claude web custom connectors, and other MCP clients that support remote HTTP transports.

## Endpoint

Use the public HTTPS base URL for your Paperclip deployment:

```bash
claude mcp add --transport http paperclip-ceo https://<host>/mcp
```

Claude web, Cowork, and Desktop custom connectors use the same connector URL:

```text
https://<host>/mcp
```

The server also accepts `POST /api/mcp` for deployments that route MCP traffic under the API prefix. Non-POST requests return `405` with `Allow: POST`.

## Authentication

Send a Paperclip bearer token with every MCP request:

```http
Authorization: Bearer <paperclip-api-token>
```

The bearer token is validated by the normal Paperclip API authentication middleware. Token revocation and rotation use the same process as existing Paperclip API keys. The MCP bridge does not mint or store connector-specific secrets.

## Principal Mapping

The authenticated API actor is the MCP principal. The bridge does not impersonate arbitrary agents. It derives company, agent, and run/audit context from the authenticated actor, then from explicit headers, then from deployment environment defaults.

Optional headers:

- `X-Paperclip-Company-Id`: company scope when the actor can access more than one company.
- `X-Paperclip-Agent-Id`: agent scope for delegated agent operations.
- `X-Paperclip-Run-Id`: audit run id attached to writes.
- `X-Paperclip-Mcp-Scopes`: comma or space separated MCP scopes.

## Write Scope

Read tools are available with a valid bearer token. Write tools are listed only when the request includes `paperclip:write` scope through `X-Paperclip-Mcp-Scopes` or `PAPERCLIP_MCP_SCOPES`.

Supported write scope values:

- `paperclip:write`
- `write`
- `*`

Write tool descriptions start with a visible warning and mutating API calls include `X-Paperclip-Run-Id` when run context is available. A direct write request without write scope is rejected before it reaches the Paperclip API.

## Verification

Unauthenticated request:

```bash
curl -i -X POST https://<host>/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Expected result: `401`.

Read-only connector:

```bash
curl -i -X POST https://<host>/mcp \
  -H 'Authorization: Bearer <paperclip-api-token>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expected result: read tools such as `paperclipListIssues` and `paperclipGetIssue` are present; write tools such as `paperclipAddComment` are absent.

Write-scoped connector:

```bash
curl -i -X POST https://<host>/mcp \
  -H 'Authorization: Bearer <paperclip-api-token>' \
  -H 'X-Paperclip-Mcp-Scopes: paperclip:write' \
  -H 'X-Paperclip-Run-Id: <audit-run-id>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expected result: guarded write tools are present and visibly marked as write actions.
