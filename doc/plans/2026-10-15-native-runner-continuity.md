# Native runner continuity through controller and process loss

## Goal and delivery boundary

Ship a verified fix to the selected staging instance and recover the two reported
tasks from their retained work. Normal follow-up messages, server restarts, and
recoverable runner loss must not strand a task behind
`native_continuation_requires_reconciliation` or
`runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate`.
Removing an error label, clearing a hold without evidence, or blindly starting
another provider does not meet this goal.

The user authorized implementation, review, merge, staging deployment, and task
recovery. The supported release covers the affected native Codex and native
OpenCode remote execution paths, plus shared lifecycle regression controls.
It preserves existing company, ownership, Stop, pause, approval, budget, and
workspace boundaries. Genuine conflicting ownership or an unresolved external
effect must remain safe and actionable. This is not a promise that infrastructure
can never fail; it is a checkable promise that the specified failures do not lose
work or require users to diagnose runner internals.

Warm process reuse is a firm requirement. The user superseded the earlier
save-and-suspend choice: healthy follow-up turns must keep the existing provider
process. Durable ownership and recovery must coexist with that behavior. The
suspend-every-turn candidate is withdrawn from delivery; PR #16451 is draft and
has not been merged or deployed.

## Acceptance matrix

| Journey or fault | Required result | Evidence |
| --- | --- | --- |
| Completed turn followed immediately by another user message | Next turn starts once with the saved history, workspace, and message | Real assembled-service regression and staging journey |
| Healthy remote warm follow-up | Same runner and provider process, with a verified handoff to the new run | Process-start identity and call-log assertions across real turns |
| Controller restart while a session is idle, including immediately after completion | Durable evidence suffices to resume or safely replace the runner; no process-local ownership dependency strands the task | Hard and graceful restart fault tests |
| Restart during startup or an active turn | Adopt the exact live execution or fence it before one bounded successor; preserve accepted results and pending messages | Real process/transport boundary fault tests |
| Remote process exits or identity cannot initially be read | Distinguish a transient probe failure, a dead execution, and a conflicting owner; reconcile automatically when evidence permits | Linux remote-process tests and persisted recovery timeline |
| Crash during checkpoint, recovery, or workspace copy-back | Resume the persistence obligation without replaying completed provider work; retain the sole recoverable source until saved | Restart/concurrency regression with independently checked file contents |
| Existing saved or quarantined state from the affected release | Recover eligible old state without requiring a newly created task or discarding its history | Compatibility fixture and recovery of both reported tasks |
| Duplicate recovery workers, lost acknowledgements, and newer user messages | At most one successor and one delivery of each message; no replay of a completed external action | Durable ledger and side-effect counter assertions |
| Wrong company/session, a genuinely live competing owner, Stop/pause, revoked access, or unknown external effect | No unsafe adoption, signalling, destruction, or speculative action replay; concrete remaining blocker | Negative controls |
| Deployment | Running staging application and any changed runner artifact match the tested revisions; both tasks have useful results or their genuine task-level disposition | Live revision, run, file, and task inspection |

Use the existing recovery budgets (three provider attempts including the original,
30-second failure retry interval) and control-transition contract (60-second
deadline, 15-second reconciliation, resolution or explicit blocker within 90 seconds
with healthy dependencies). Provider work duration is not bounded by this timer.
Restarts must not reset budgets. Any necessary departure requires explicit evidence
and an updated contract, not a silent relaxation of acceptance.

## Investigation and implementation slices

1. Establish both baseline failure paths from persisted evidence. The remote
   identity failure still needs its exact failing operation established; do not
   infer process death from the generic error alone.
2. Close the completed-turn ownership/checkpoint gap in its existing lifecycle
   owner, including compatibility with retained old state. Test prevention and
   recovery, not only an isolated predicate.
3. Close the demonstrated remote recovery gap using existing fencing, finalization,
   workspace retention, and continuation services. Keep diagnostics precise enough
   to distinguish probe unavailability from conflicting identity.
4. Qualify the changed boundary locally first, then on a representative remote
   Linux target and staging. Prepare reviewable changes and required repository
   checks; deploy the verified revision and recover the original tasks.

The first discriminating experiment is a completed native remote turn whose
controller is lost before a follow-up. Recreate the old persisted state through
the real lifecycle, then attempt the follow-up with an empty process-local owner
map. Preserve real persistence, transport, and process boundaries where mocks
would hide the failure. Existing recovery E2E and native restart suites are the
starting harnesses; past passing evidence does not qualify this change.

## Current state

- Branch: `codex/native-runner-recovery`, based on `afe5b3418d`.
- PR: https://github.com/paperclipai/paperclip/pull/16451 (draft, unmerged).
- Normal warm turns retain their processes. The previous suspend-every-turn
  implementation is withdrawn. Earlier suspension tests are historical only.
- The base includes #16432 (idle expiry serialized with admission) and #16441
  (exact warm-owner identity independent of configuration changes).
- The revised executor can recover a completed remote session after its
  controller dies. It checks the committed prior result, frozen scope, saved
  checkpoint, exact remote identity, and current task/coordinator lease. It
  reconnects through the prior route before authenticated run attachment.
- A saved process-configuration digest controls reuse after controller loss.
  Legacy metadata or changed configuration uses verified close and checkpoint
  followed by saved-history resume. Healthy warm follow-ups stay open.
- Four Linux container/TLS/PostgreSQL cases pass: ordinary warm reuse, actual
  controller SIGKILL, older checkpoint metadata, and changed environment.
  They assert one thread creation and exactly three turn starts, including a
  healthy follow-up after recovery. The hard-restart
  cases also reject a still-live prior controller and a replacement sandbox.
  Normal follow-ups use one provider process; recovery may refresh the provider.
  These are real runner/process tests with a deterministic fake Codex, not live
  Daytona or live model evidence. The prior lease fixture uses the expired status
  observed on staging. The third turn retains the runner and provider processes.
- Full workspace typecheck and production build pass on the warm candidate.
  The server and UI typechecks and production build also pass after the final
  changes. All 749 focused executor/restart tests pass; the full required test
  suite is running.
- Greptile found a stale recovery ownership check retained across later warm
  turns. Recovery admission now retires after verified attachment; the three-turn
  regression passes. The earlier saved-state diagnostic finding is also fixed.
  The third-turn fix received 5/5. Fresh review of the final changes is pending.
- The existing source-only file-recovery form now supports retained native holds
  as well as legacy holds. It preserves board authority, exact stop-receipt
  validation, task status, and the prohibition on replaying the original run.
  All 52 UI/native recovery tests, token gates, and map checks pass.
- Fresh read-only staging records confirm both original tasks remain blocked.
  The Codex failure preceded its coordinator claim. The OpenCode failure followed
  controller takeover, with an active turn in the saved checkpoint. Its original
  log lacks the failed probe reason; process death is not established.
- Both retained sandboxes were restored for file inspection. The completed
  website commit is intact; the other workspace retains a benchmark script and
  lockfile changes. Backup and task disposition remain in progress. No agent
  turn, task status, or deployment has been changed.
- The selected tenant has an existing fleet rollout deferred by active work.
  Do not override it. Remaining: full tests and review, staging qualification,
  retained-state recovery, and useful disposition of both tasks.

Deferred: unrelated skill-import setup failures, database query optimization,
general UI redesign, and broad provider qualification unrelated to the changed
shared lifecycle.
