# Fleet patrol remediation runbook

Status: disabled by default. Do not enable until the CISO records approval on
[LUC-2120](/LUC/issues/LUC-2120).

## Boundary

`POST /api/fleet-patrol/remediation` accepts exactly:

- `clear_agent_error`
- `release_issue_lock`
- `reset_workspace_pin`

The endpoint accepts only Reliability Engineer
`efe05cc3-1470-41c4-ad2a-d69912f56511` using a live run-scoped agent JWT whose
signed run id matches `X-Paperclip-Run-Id`. Static agent keys, board sessions,
other agents, other companies, and unrelated mutations fail closed.

## Enable and verify

1. Confirm CISO approval on [LUC-2120](/LUC/issues/LUC-2120).
2. Set `PAPERCLIP_FLEET_PATROL_REMEDIATION_ENABLED=true` in the managed server
   environment and restart through the normal deployment procedure.
3. Have the patrol submit one known-denied request, then its intended
   predicate-bound operation.
4. Query the dedicated immutable audit table. This feature does not write
   `fleet_patrol.remediation_*` events to `activity_log`.

```sql
SELECT
  created_at,
  authenticated_agent_id,
  authenticated_run_id,
  api_key_id,
  credential_id,
  company_id,
  operation,
  target_type,
  target_id,
  outcome,
  reason_code,
  before,
  after
FROM fleet_patrol_audit
WHERE company_id = '<company-uuid>'
ORDER BY created_at DESC
LIMIT 20;
```

Expected:

- the known denial has `outcome = 'denied'` and a non-sensitive reason code;
- the intended operation has `outcome = 'allowed'` and only the documented
  fields changed;
- `operation` is one of the three literals or `schema_invalid`;
- `target_id` is a validated UUID or `unknown`;
- `before` and `after` contain no raw errors, authorization headers, JWTs, API
  keys, or other credential material.

The table is append-only. An `UPDATE` or `DELETE` must fail with
`fleet_patrol_audit is append-only`.

## Kill switch and credential revocation

1. Set `PAPERCLIP_FLEET_PATROL_REMEDIATION_ENABLED=false` or remove the
   variable, then restart the managed server. Absence is disabled.
2. Cancel the active patrol run with the board-authorized
   `POST /api/heartbeat-runs/{runId}/cancel` endpoint. The remediation service
   checks the persisted run state on every request, so the run-scoped JWT fails
   closed as soon as the run is no longer `running`.
3. Pause the Reliability Engineer if compromise or uncontrolled retries are
   suspected.
4. Static agent keys cannot authorize this endpoint. If a broader credential
   incident involves one, revoke it with the board-authorized
   `DELETE /api/agents/{agentId}/keys/{keyId}` endpoint and rotate any upstream
   provider credential through the normal secrets workflow.
5. Verify a patrol request receives `403` with
   `reasonCode = 'capability_disabled'`.
6. Query `fleet_patrol_audit` and confirm the denial was appended with the
   authenticated run attribution and no credential contents.

The general agent and issue mutation endpoints remain unchanged and retain
their existing authorization checks.

## Rollback

Every allowed row retains safe `before` values:

- Error clear: restore the prior agent lifecycle/error state only after proving
  no newer run exists. Raw error text is intentionally unavailable from this
  audit and must not be copied into operator notes.
- Lock release: restore only `checkoutRunId`, `executionRunId`,
  `executionAgentNameKey`, and `executionLockedAt` after proving those runs are
  still terminal and the issue has not acquired another lock.
- Workspace reset: restore `executionWorkspacePreference` and
  `executionWorkspaceId` only after locking and revalidating that workspace.

Use a normal board-authorized repair for rollback. Never bypass the
transactional predicates or append-only audit enforcement.
