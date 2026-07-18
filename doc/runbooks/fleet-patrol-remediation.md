# Fleet patrol remediation runbook

Status: disabled by default. Do not enable until the CISO security gate accepts
the implementation and evidence.

## Boundary

`POST /api/fleet-patrol/remediation` accepts exactly three operations:

- `clear_agent_error`
- `release_issue_lock`
- `reset_workspace_pin`

`reset_workspace_pin` has two narrow repair predicates:

- a failed `workspace_validation_failed` run may clear an invalid
  `reuse_existing` execution-workspace pin;
- a blocked issue assigned to an agent whose title is `Chief … Officer` (or
  whose role is `ceo`) may be restored to `todo` only when it has no dependency,
  its active recovery action has `cause=stranded_assigned_issue`, and the action
  evidence matches the latest failed `adapter_failed` issue run. This clears
  `projectWorkspaceId` and `executionWorkspaceId`, switches to `agent_default`,
  and resolves the recovery action in the same transaction.

Dependencies, cancellations, process-loss evidence, unrelated adapter failures,
non-executive assignees, stale evidence, and issues with live or scheduled-retry
runs are denied without changing issue state. Repeating a successful repair is
a safe denial and leaves the restored state unchanged.

The endpoint accepts only Reliability Engineer
`efe05cc3-1470-41c4-ad2a-d69912f56511` using a live run-scoped agent JWT. Static
agent keys, board sessions, other agents, other companies, and unrelated
mutations fail closed.

## Enable

1. Confirm final CISO acceptance is recorded.
2. Set `PAPERCLIP_FLEET_PATROL_REMEDIATION_ENABLED=true`.
3. Restart the server through the normal managed-service procedure.
4. Submit a known-denied request and confirm an immutable
   `fleet_patrol_audit` denial row.
5. Submit the intended operation and confirm the expected allowed reason code.

## Kill switch

1. Set `PAPERCLIP_FLEET_PATROL_REMEDIATION_ENABLED=false` or remove the variable.
2. Restart the server. The default is disabled.
3. Cancel the Reliability Engineer's active run to invalidate its run-scoped
   credential. Pause the agent and follow incident response if compromise is
   suspected.
4. Verify the endpoint returns `403` with `capability_disabled`.

General agent and issue mutation endpoints remain unchanged.

## Rollback

Disable the capability first. Every allowed audit row contains safe `before`
values without raw errors or credentials.

- Error clear: restore lifecycle state only after proving no newer run exists.
- Lock release: restore only the four lock fields after proving the referenced
  runs remain terminal and no new lock exists.
- Workspace reset: restore workspace fields only after proving the workspace is
  safe to reuse. For an executive repair, also restore the prior status and
  recovery action only as one governed transaction.

Use a normal board-authorized repair. Never bypass the compare-and-swap
predicates.
