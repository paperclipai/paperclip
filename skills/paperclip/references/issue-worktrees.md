# Issue Worktree Runtime Controls

Use this reference when an issue has an isolated execution worktree and you need to inspect or run that worktree's services, especially for QA/browser verification.

## Discover the Worktree

Start from the issue, not from memory:

```sh
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/heartbeat-context"
```

Read `currentExecutionWorkspace`:

- `id` — execution worktree id for control endpoints
- `cwd` / `branchName` — local checkout context
- `status` / `closedAt` — whether the worktree is usable
- `runtimeServices[]` — current services, including `serviceName`, `status`, `healthStatus`, `url`, `port`, and `runtimeServiceId`

If `currentExecutionWorkspace` is `null`, the issue does not currently have a realized execution worktree. For child/follow-up work, create the child with `parentId` or use `inheritExecutionWorkspaceFromIssueId` so Paperclip preserves worktree continuity.

## Control Services

Prefer Paperclip-managed runtime service controls over manual `pnpm dev &` or ad-hoc background processes. These endpoints keep service state, URLs, logs, and ownership visible to other agents and the board.

```sh
# Start all configured services; waits for configured readiness checks.
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/execution-workspaces/<workspace-id>/runtime-services/start" \
  -d '{}'

# Restart all configured services.
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/execution-workspaces/<workspace-id>/runtime-services/restart" \
  -d '{}'

# Stop all running services.
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/execution-workspaces/<workspace-id>/runtime-services/stop" \
  -d '{}'
```

To target a configured service, pass one of:

```json
{ "workspaceCommandId": "web" }
{ "runtimeServiceId": "<runtime-service-id>" }
{ "serviceIndex": 0 }
```

The response includes an updated `workspace.runtimeServices[]` list and a `workspaceOperation`/`operation` record for logs.

## Read the URL

After `start` or `restart`, read the service URL from:

- response `workspace.runtimeServices[].url`
- or a fresh `GET /api/issues/:issueId/heartbeat-context` response at `currentExecutionWorkspace.runtimeServices[].url`

For QA/browser checks, use the service whose `status` is `running` and whose `healthStatus` is not `unhealthy`. If multiple services are running, prefer the one named `web`, `preview`, or the configured service the issue mentions.

## MCP Tools

When the Paperclip MCP tools are available, prefer these issue-scoped tools:

- `paperclipGetIssueWorkspaceRuntime` — reads `currentExecutionWorkspace` and service URLs for an issue.
- `paperclipControlIssueWorkspaceServices` — starts, stops, or restarts the current issue workspace services.
- `paperclipWaitForIssueWorkspaceService` — waits until a selected service is running and returns its URL when exposed.

These tools resolve the issue's worktree id for you, so QA agents do not need to know the lower-level execution worktree endpoint first. The tool names, response fields, and endpoint retain their legacy `workspace` spelling in Phase 1.
