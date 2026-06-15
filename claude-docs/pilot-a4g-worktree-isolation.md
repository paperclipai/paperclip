# Pilot A4/G — Worktree Isolation for Agent Execution

**Branch:** `pilot/b1-dogfood`
**Commit:** `8a6e9ed3`
**Scope:** `scripts/create-pilot-company.sh`, `scripts/create-pilot-plan.sh`

---

## Problem

In HIVA-17, Implementor 2 wrote `server/src/routes/plans.ts` (the `GET /companies/:id/plans`
endpoint) correctly but its run detached mid-write with `errorCode: process_detached`. The
child issue stalled in `in_progress`; the W5b reviewer wake never fired.

**Root cause:** Pilot agents had no project/policy, so `resolveWorkspaceForRun` fell back to
`task_session` cwd — the path the agent navigated to in its first run (the main paperclip repo
at `/Users/user/sourceControl/paperclip`). When the implementor saved a file in `server/src/`,
the `dev:watch` process (`tsx watch src/index.ts` from `server/`) detected the change,
hot-reloaded, and killed the process managing the agent's own run. The run was orphaned.

---

## Why tsx watch doesn't see worktrees

The dev server runs:

```
server/scripts/dev-watch.ts
  → spawn: tsx watch src/index.ts
  → cwd: <repo>/server/
```

It watches `server/src/` and its imports — all within the `server/` subdirectory.

Git worktrees land at `<repo>/.paperclip/worktrees/<branch>/` — a separate directory at the
repo root, outside `server/`. When an implementor edits `.paperclip/worktrees/branch/server/src/routes/plans.ts`, the file change is invisible to `tsx watch`. No hot-reload. Run completes normally.

---

## Fix

Two script changes wire the execution policy so implementor runs land in worktrees:

### `create-pilot-company.sh`

After provisioning the gate squad, creates a **"Pilot" project** with:

```json
{
  "name": "Pilot",
  "executionWorkspacePolicy": {
    "enabled": true,
    "defaultMode": "isolated_workspace",
    "workspaceStrategy": { "type": "git_worktree" }
  },
  "workspace": {
    "sourceType": "local_path",
    "cwd": "<repo root>",
    "isPrimary": true
  }
}
```

Idempotent: re-runs detect an existing project and reuse it.

### `create-pilot-plan.sh`

Before creating the plan, fetches `GET /companies/:id/projects` and passes the first project's
id in the plan body (`body.projectId = projectId`). Accepts a `PROJECT_ID` env var override.

---

## Full execution chain

```
create-pilot-company.sh
  → POST /companies/:id/projects { executionWorkspacePolicy: { isolated_workspace, git_worktree }, workspace: { cwd: <repo> } }
  → project row + project_workspace row in DB

create-pilot-plan.sh
  → GET /companies/:id/projects → PROJECT_ID
  → POST /plans { companyId, projectId, ... }
  → root plan issue.projectId = PROJECT_ID
  → child issues inherit via createChild (issues.ts:4461)

heartbeat (implementor run):
  → issueContext.projectId → projectContext.executionWorkspacePolicy  [heartbeat.ts:7843]
  → resolveExecutionWorkspaceMode → "isolated_workspace"  [execution-workspace-policy.ts:293]
  → buildExecutionWorkspaceAdapterConfig → workspaceStrategy = { type: "git_worktree" }  [line 381]
  → realizeExecutionWorkspace → .paperclip/worktrees/<branch>/  [workspace-runtime.ts:1131]
  → adapter cwd = worktree path
  → implementor edits land in .paperclip/worktrees/
  → tsx watch (server/src/) invisible to worktree files
  → no hot-reload → run completes → child reaches in_review
```

---

## AC

- Implementor file edit does NOT restart the dev server
- Implementor run completes with child reaching `in_review`
- No `process_detached` runs during a dev_team pilot

---

## Files Changed

| File | Change |
|---|---|
| `scripts/create-pilot-company.sh` | Step 3: create "Pilot" project with worktree isolation policy + workspace |
| `scripts/create-pilot-plan.sh` | Fetch company project, pass `projectId` in plan body |
