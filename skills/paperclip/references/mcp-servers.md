# Paperclip MCP Server Workflow

Use this workflow when the board/user asks an agent to configure MCP. The result must be visible in Paperclip's company MCP library at `/mcp` and attached to the intended agents through catalog references.

## Rules

- Treat the company MCP catalog as the source of truth.
- Use `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, and `PAPERCLIP_RUN_ID`; never hard-code the instance URL or credentials.
- Include `Authorization: Bearer $PAPERCLIP_API_KEY` on requests and `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on mutations.
- Do not edit runtime-specific MCP files. Paperclip resolves catalog references and injects the effective config when a run starts.
- Do not use the legacy inline `/agents/:id/mcp-servers` routes unless the board explicitly requests an agent-only override.

## Workflow

1. Inspect the company catalog:

   `GET /api/companies/{companyId}/mcp-servers`

2. Reuse an existing matching server when possible. If it is missing and you are authorized, create it:

   `POST /api/companies/{companyId}/mcp-servers`

   ```json
   {
     "name": "linear",
     "description": "Linear issue tracking",
     "config": {
       "transport": "http",
       "url": "https://mcp.linear.app/mcp"
     },
     "enabled": true
   }
   ```

   Supported transports are `stdio`, `http`, and `sse`. Server names must start with a letter and contain only letters, digits, `-`, or `_`.

3. For an update, use the catalog entry id:

   `PATCH /api/companies/{companyId}/mcp-servers/{serverId}`

4. Read the target agent's current catalog references:

   `GET /api/agents/{agentId}/mcp-server-refs`

5. Merge the requested change into the current `desiredMcpServers` list, then replace the list intentionally:

   `PUT /api/agents/{agentId}/mcp-server-refs`

   ```json
   {
     "desiredMcpServers": ["linear", "context7"]
   }
   ```

   This endpoint replaces the complete desired list. Never send only the new server name without preserving other intended references.

6. If a remote server uses OAuth, start the built-in brokered flow:

   `POST /api/companies/{companyId}/mcp-servers/{serverId}/oauth/start`

   The response contains `authorizeUrl`. OAuth consent is a legitimate board/user action because the agent cannot grant access to an external account itself. Keep the issue in a first-class waiting state until authorization completes.

7. Verify both layers:

   - `GET /api/companies/{companyId}/mcp-servers/{serverId}` confirms the catalog entry, enabled state, transport, sanitized config, and usage.
   - `GET /api/agents/{agentId}/mcp-server-refs` confirms the intended reference and reports missing catalog names.
   - State clearly that MCP tool injection starts on the agent's next run, not retroactively in the current process.

## Secrets

Never send raw tokens, API keys, or passwords in catalog config, comments, logs, or issue descriptions.

- Use Paperclip secret bindings such as `secret_ref` for headers, bearer tokens, or stdio environment variables.
- Use brokered OAuth for supported `http` or `sse` servers.
- If a required secret or consent is unavailable, create an explicit waiting path for the authorized owner. Do not bypass Paperclip by writing a local MCP config file.

## Permissions and Failures

Reading the catalog is company-scoped. Creating, updating, deleting, or starting catalog OAuth requires board access or the same `agents:create`/agent-creation authority used for company skills.

If a request returns `403`, report the exact missing permission and route the issue to an authorized manager or board/user. If it returns `409` on delete, the server is still enabled on agents; inspect its usage before deciding whether the board intended a forced removal. Never silently replace a catalog operation with unmanaged per-agent configuration.
