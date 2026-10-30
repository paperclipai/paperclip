# Native session cleanup quarantine recovery

`native_session_cleanup_quarantined` means Paperclip could not prove that the
prior native session cleanup finished safely. It is not permission to replay
the task turn: a provider tool call may already have produced an external side
effect.

## Recover one exact failed run

Use the board action only after identifying the exact failed run ID recorded
for the affected Issue. An authorized board operator with `runtime:manage` may
request cleanup-only reconciliation:

```http
POST /api/issues/{issueId}/recovery-actions/retry-native-session-cleanup
Content-Type: application/json

{"runId":"<exact failed run id>"}
```

This is a cleanup-only reconciliation. It never replays the task turn or
delegates a semantic tool call. To settle the exact retained Codex turn, the
reconciler stages an isolated copy of its state and may start a maintenance
runner that reconnects to that provider session, requests stop when needed,
drains its retained control events, and proves suspension. The original
quarantine remains preserved until that proof succeeds. This is not a general
provider restart or a way to continue the task.

Eligibility is intentionally narrow. The Issue and run IDs must match an exact
terminal native run with retained session and runner identities. The supported
failure is the local Codex runner failure `provider_transport_failed: runner
did not durably suspend before checkpoint` (recorded as
`adapter_failed` or `provider_transport_failed`). The persisted runner PID and
process group must match, and both the original runner and provider processes
must be proven absent. Paperclip also requires a committed finalization, an
accepted saved result, no active session or environment lease, and retained
state whose run, session, provider turn, and process identities match the
saved events. Pending semantic tool inputs or any missing, ambiguous, changed,
unsupported, or contradictory evidence fail closed. The reconciler currently
rejects Windows and requires the supported POSIX Codex state.

Older quarantines that lack these identities are not eligible. They return
`not_eligible`; preserve their state and use the returned `nextAction` to
investigate the exact run. Do not use this action as a generic unblock.

### Pending or completed semantic tool calls

An unresolved `semantic_tool.input` in the runner outbox or provider pending
queue is not eligible. The reconciler does not invoke it again or infer whether
its effect completed. Use the exact `operationId` and `callId` to inspect the
target system through its read-only state or audit history. Record the verified
outcome against the Issue and run. Do not replay the operation or clear the
pending journal entry.

There is one narrower exception: the archive-only path can retire a stopped
Codex session when the durable control-plane command records
`semantic_tool_not_dispatched` for the exact call, the matching input is
persisted and hashed, the provider is `prepared` with its turn closed, no
result event exists, and both exact process owners are absent. It preserves the
original journal in quarantine and does not start a runner/provider, synthesize
a tool result, or retry the task. Any missing or contradictory evidence keeps
the Issue blocked.

A fully committed `paperclip_finish` input can be eligible only when its
matching successful `semantic_tool.result` and completed result command are
also present, and the input matches the accepted final run result. This is a
proof check; the cleanup action does not invoke `paperclip_finish` again.
Uncertain effects outside this exact contract must be reconciled separately
before any task retry.

When eligible, Paperclip reconciles a staged copy while preserving the
original quarantine and saved run result. Only after verifying the reconciled
state does it retire the exact cleanup hold.

### Interpret the response

- `200` with `status: "settled"` means the exact retained turn was stopped and
  durably suspended through the cleanup-only maintenance flow, its state was
  verified, and the cleanup hold was retired. It does not mean the Issue was
  retried or that external effects from the failed run were undone.
  Review the saved run and reconcile any pending or uncertain external effects
  through their own recovery procedures. Use the ordinary Issue Retry action
  only after those effects are understood.
- Every `409` includes `details.runId`, `details.status`,
  a specific `details.nextAction`, `details.taskTurnReplayed: false`, and
  `details.taskRetried: false`.
- For `details.status: "deferred"`, wait for the reported `details.waitFor`
  condition (`process_exit`, `session_release`, `environment_release`,
  `maintenance_settlement`, or `lease_expiry`). A `lease_expiry` response also
  includes its ISO timestamp as `details.retryAt` and in the error message.
  Do not clear the lease, process record, session, checkpoint, or quarantine to
  force eligibility. Retry this exact cleanup action only after the named
  condition has resolved.
- `details.status: "not_eligible"` means this run does not satisfy the
  supported identity/state contract. Follow `details.nextAction`: preserve the
  exact session and checkpoint, inspect run/session/runner/process ownership,
  and do not clear state, restart the service, or retry the task.
- `details.status: "operator_required"` means a maintenance attempt could not
  prove a safe settlement. Follow `details.nextAction`: keep this Issue blocked
  and have an operator prove the exact provider turn and process are settled.
  Do not delete retained state or replay the task turn.

Every attempt is activity-logged against the Issue and exact run, including its
outcome and the invariant that the task turn was not replayed.

## Isolation and automation

Cleanup admission is scoped to the owning Issue, backend, and exact remote
cleanup resource. A failed cleanup for one Issue must not block unrelated
Issues using the same backend. The affected Issue remains gated until its own
cleanup and execution reconciliation pass.

The retained cleanup worker and this operator action use the same narrow,
evidence-gated reconciler. Do not broaden its candidate query or supported
runtime/state contract without equivalent proof. Keep recurring recovery
monitors paused and their triggers disabled until deployed-runtime checks prove
both cross-Issue isolation and exact-run recovery. The monitor must inspect
first and act only when the same evidence gate passes; it must never retry task
turns or clear uncertain state.
