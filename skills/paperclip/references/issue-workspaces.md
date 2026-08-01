# Issue Workspace Runtime Controls

Use this reference when an issue has an isolated execution workspace and you need to inspect or run that workspace's services, especially for QA/browser verification.

## Discover the Workspace

Start from the issue, not from memory:
```sh
# Write auth to a mode-600 config file so the token never appears in curl argv
# (/proc/*/cmdline is world-readable on Linux).
# Auth via a piped curl config: the token stays out of curl argv
# (/proc/*/cmdline is world-readable) and is never written to disk.
_auth() { printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY"; }
_auth | curl -sS --config - \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/heartbeat-context"
```

Read `currentExecutionWorkspace`:

- `id` — execution workspace id for control endpoints
- `cwd` / `branchName` — local checkout context
- `status` / `closedAt` — whether the workspace is usable
- `runtimeServices[]` — current services, including `serviceName`, `status`, `healthStatus`, `url`, `port`, and `runtimeServiceId`

If `currentExecutionWorkspace` is `null`, the issue does not currently have a realized execution workspace. For child/follow-up work, create the child with `parentId` or use `inheritExecutionWorkspaceFromIssueId` so Paperclip preserves workspace continuity.

## Control Services

Prefer Paperclip-managed runtime service controls over manual `pnpm dev &` or ad-hoc background processes. These endpoints keep service state, URLs, logs, and ownership visible to other agents and the board.
```sh
# Write auth to a mode-600 config file so the token never appears in curl argv
# (/proc/*/cmdline is world-readable on Linux). Reused across the calls below.
# Auth via a piped curl config: the token stays out of curl argv
# (/proc/*/cmdline is world-readable) and is never written to disk.
_auth() {
  printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY"
  printf 'header = "X-Paperclip-Run-Id: %s"\n' "$PAPERCLIP_RUN_ID"
}

# Start all configured services; waits for configured readiness checks.
_auth | curl -sS -X POST --config - \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/execution-workspaces/<workspace-id>/runtime-services/start" \
  -d '{}'

# Restart all configured services.
_auth | curl -sS -X POST --config - \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/execution-workspaces/<workspace-id>/runtime-services/restart" \
  -d '{}'

# Stop all running services.
_auth | curl -sS -X POST --config - \
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

These tools resolve the issue's workspace id for you, so QA agents do not need to know the lower-level execution workspace endpoint first.
