# G/A4 — Worktree Isolation for Pilot Agent Execution

**Branch:** `pilot/b1-dogfood`

## Problem

During HIVA-17 pilots, implementor file edits (e.g. writing `server/src/routes/plans.ts`) triggered `tsx watch` to hot-reload the dev server. The dev server restart orphaned the agent run managing that edit → `errorCode: process_detached` → child issue stalled `in_progress` forever, requiring manual recovery. Every multi-step `dev_team` pilot was blocked by this.

## Fix

Plan child issues are now created with:

```json
executionWorkspaceSettings: {
  "mode": "isolated_workspace",
  "workspaceStrategy": { "type": "git_worktree" }
}
```

When `enableIsolatedWorkspaces` is on, the heartbeat resolves this to a dedicated git worktree checkout that `tsx watch` does NOT observe. Agent file edits land in the worktree; the main checkout (and the dev server watching it) is untouched.

## Wiring

`planService.activate()` passes the settings to every `createChild` call. The existing `issueService.create()` strips the field when `enableIsolatedWorkspaces = false` (line 4797) — no behavior change when the flag is off.

Runtime path: heartbeat reads the stored settings → `parseIssueExecutionWorkspaceSettings()` → `resolveExecutionWorkspaceMode()` returns `"isolated_workspace"` → `buildExecutionWorkspaceAdapterConfig()` sets `workspaceStrategy: git_worktree` → adapter runs in a separate worktree.

## Reset script

`scripts/reset-pilot.sh` now calls `PATCH /api/instance/settings/experimental { "enableIsolatedWorkspaces": true }` (step 0b) before clearing plans. This ensures the flag is on before any plan is activated on the reset instance.

## Test fix

`plan-gate-activation.test.ts` expected 5 gate approvals per `dev_team` plan with 2 leaves (written before B1/B2). B1 added 3 lens-specific code-review gates per leaf; B2 added a completeness gate per leaf. Correct count: 1 plan-approval + 2 leaves × (3 code + 1 wiring + 1 completeness) = 11. Fixed.

## AC

- Child issues created by `planService.activate()` carry worktree settings when `enableIsolatedWorkspaces` is on
- Settings are absent when the flag is off (stripped by `create()`)
- `reset-pilot.sh` enables the flag at reset time

## Files Changed

| File | Change |
|---|---|
| `server/src/services/plans.ts` | `createChild` call includes `executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } }` |
| `scripts/reset-pilot.sh` | Step 0b: `PATCH /instance/settings/experimental { "enableIsolatedWorkspaces": true }` |
| `server/src/__tests__/plans-worktree-isolation.test.ts` | New — 2 embedded-Postgres tests (flag on/off) |
| `server/src/__tests__/plan-gate-activation.test.ts` | Fix stale gate-count expectations (B1/B2 added 3-lens + completeness, test was never updated) |
