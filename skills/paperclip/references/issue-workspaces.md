# Issue Workspace Runtime Controls

Use this reference only to inspect workspace identity and externally provided target metadata. The binding external-execution boundary in `../SKILL.md` forbids agents from using Paperclip-managed local runtime services for a domain project's builds, tests, application servers, browser QA, databases, migrations, previews, or deployments.

Paperclip is the control plane. A project workload must run on a board-provided external environment. The existence of an execution workspace, configured command, port, or runtime-service endpoint does not authorize local execution.

## Discover the Workspace

Start from the issue, not from memory:

```sh
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/heartbeat-context"
```

Read `currentExecutionWorkspace`:

- `id` — execution workspace id for control endpoints
- `cwd` / `branchName` — local checkout context
- `status` / `closedAt` — whether the workspace is usable
- `runtimeServices[]` — current services, including `serviceName`, `status`, `healthStatus`, `url`, `port`, and `runtimeServiceId`

If `currentExecutionWorkspace` is `null`, the issue does not currently have a realized execution workspace. For child/follow-up work, create the child with `parentId` or use `inheritExecutionWorkspaceFromIssueId` so Paperclip preserves workspace continuity.

## Runtime Service APIs Are Not Domain Execution Authorization

Paperclip exposes runtime-service APIs for control-plane administration and legacy integrations. Domain agents must not invoke `start` or `restart` through these APIs to create a local test, QA, preview, database, migration, or deployment environment. They may read existing service metadata or stop a service when explicitly assigned control-plane cleanup.

```sh
# Explicitly assigned control-plane cleanup only: stop an existing service.
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

## Read External Target Metadata

Read service and workspace metadata without starting anything. A URL is valid for domain QA only when the issue, project, execution contract, or approved deployment packet identifies it as a board-provided external environment and it resolves outside Paperclip infrastructure.

- Read the issue's `heartbeat-context` and approved deployment packet.
- Confirm provider, exact target, purpose, isolation, credentials/executor, and cleanup/rollback owner.
- Reject localhost, loopback, Paperclip-container, Paperclip-host, control-plane database, and ad hoc workspace URLs.

If no qualifying external target is present, mark the issue blocked with the exact environment the board must provide. Do not search for or create an alternative target.

## MCP Tools

When Paperclip MCP tools are available, these tools are read/control surfaces, not authorization to execute domain workloads locally:

- `paperclipGetIssueWorkspaceRuntime` — reads `currentExecutionWorkspace` and service URLs for an issue.
- `paperclipControlIssueWorkspaceServices` — use only for explicitly assigned control-plane cleanup; do not start/restart domain services.
- `paperclipWaitForIssueWorkspaceService` — do not use to turn a Paperclip-local service into domain QA evidence.

Use the external provider or runner's own API/tooling for builds, tests, migrations, QA, previews, and deployments, then record its evidence in Paperclip.
