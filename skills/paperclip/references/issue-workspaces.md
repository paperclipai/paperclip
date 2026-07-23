# Issue Workspace Runtime Controls

Use this reference when an issue has an isolated execution workspace and you need to inspect or run that workspace's services (especially for QA/browser verification), or when you work with git branches inside an issue worktree.

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

## Branch Discipline in Issue Worktrees

Git-worktree execution workspaces have a *recorded branch* (`branchName` above, also exported as `PAPERCLIP_WORKSPACE_BRANCH`). Paperclip validates that the worktree's `HEAD` is on the recorded branch at run start and at run finalization. Leaving the worktree parked on another branch fails workspace validation for every later run that shares the workspace — including other issues' runs.

When you need to publish work to a different branch (for example a PR branch cherry-picked onto newer master), do one of these:

- **Publish from a separate worktree.** Create a throwaway worktree for the publishing branch and leave the issue worktree untouched:

  ```sh
  git worktree add "$PAPERCLIP_RUN_SCRATCH_DIR/publish" -b <pr-branch> <base-ref>
  # commit/cherry-pick/push from that directory, then:
  git worktree remove "$PAPERCLIP_RUN_SCRATCH_DIR/publish"
  ```

- **Or restore the recorded branch before the run ends.** If you did switch branches in place, finish with:

  ```sh
  git checkout "$PAPERCLIP_WORKSPACE_BRANCH"
  ```

A clean worktree parked on a local branch ref is self-healing (Paperclip restores the recorded branch and posts an audit comment), but do not rely on that: restore deliberately so the workspace is coherent for the next run. Never leave the worktree dirty, mid-rebase/merge, or on a detached `HEAD` — those states cannot be auto-repaired and will stop the next run.

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

These tools resolve the issue's workspace id for you, so QA agents do not need to know the lower-level execution workspace endpoint first.
