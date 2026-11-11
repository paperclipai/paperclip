# Durable records for cut-off turn starts and orphaned tool calls

Status: approved by Dotta (2026-11-10), being implemented in two PRs
Goal: after a control-plane restart or freeze, 0% of tasks need Retry, and Retry still works whenever it is shown.
Parent plan: `2026-11-07-durable-ownership-and-reconciliation.md`, section B (write-ahead intents) and section F (charge only on recorded outcomes).

## Rule

Recovery may resend, replay or continue only when a durable record proves that no provider work and no tool effect can be duplicated or lost. A duplicated prompt or a second write is worse than a Retry click. When the record cannot prove it, the existing behaviour stays: a working Retry.

## Change 1: a turn start cut off before the prompt reached the provider

**What happens today.** Restart-chaos wave `w-20261110T185315-s9107`, task t05 (claude, workload C1, fault TM2). A follow-up run's `turn.start` reaches the Runner, which saves the ACPX session as `turn_starting` and asks the ACPX sidecar to start the turn. For a resumed Claude session the sidecar first starts Claude and loads the conversation; the prompt is sent only after that. Under load this took more than 24 s. Then the harness froze the server, the Runner, the sidecar and Claude together (SIGSTOP) for 33 s. On thaw the Runner's 30 s sidecar request deadline had passed, so it reaped the sidecar and saved the session as `closed`. Every same-run resume then failed with `ACPX session is not open`, recovery stopped with `native_session_retry_exhausted`, and a person had to click Retry.

The Runner cannot tell from its own state whether Claude received the prompt. Resending could duplicate it; a continuation could lose it.

**The record: a sidecar prompt-dispatch journal.** The ACPX sidecar writes one small file in the session's private runtime directory (`0700`) for each turn:

1. When the runtime port starts the turn, before any provider work: one line `{"schema":…,"turnId":X,"phase":"received"}`, truncating the previous turn's file. No fsync.
2. When ACPX is about to write that turn's first `session/prompt` request to the provider's stdin: one appended line `{"phase":"dispatched"}`, then `fsync`, and only then the write. ACPX calls the host's `onAcpMessage("outbound", …)` hook synchronously before it hands the bytes to the provider stream, so a failed journal write aborts the prompt write.

The file name and record shape are declared in `protocol/provider-schemas/acpx-sidecar.schema.json` and generated into TypeScript and Rust, so the pack contract digest covers them.

**What it proves.** The Runner reads the journal only after it has proved that the sidecar and the provider are gone (it terminated the sidecar and acquired the provider lifetime fence, the same proof the existing lost-turn restore uses). A dead sidecar cannot write or send anything more.

| Journal for the active turn | Meaning | Recovery |
|---|---|---|
| exactly one complete `received` line | the prompt was never written to the provider | restore the session with no active turn; emit `harness.diagnostic` `acpx_turn_start_not_dispatched`; the same-run resume sends the run's `turn.start` once |
| a `dispatched` line | the provider may have the prompt | unchanged: the existing lost-turn path (restore and continue in the same conversation, or close) |
| missing, another turn, malformed, torn | unknown | unchanged |

Both cut-off shapes use it: a sidecar request that failed in flight (timeout or sidecar exit), and a Runner killed while the session was `turn_starting`.

**Resend exactly once.** The cut-off `turn.start` command stays failed; it is never executed again. The restored session has no active turn, so the next same-run resume starts the turn with the run's own input. If that start is cut off too, the journal decides again.

## Change 2: a tool call orphaned by a restart

**What happens today.** Daytona wave `w-20261110T174930-s9205`, task t01 (codex, C1, RR2): a restart cut a `write_document` callback after the Runner journaled its input and before a result was saved. Close could not prove the provider drained, so the session quarantined (`native_session_cleanup_quarantined`). Since #20628 a callback admitted by an earlier controller settles as `tool_call_interrupted_by_restart` (unknown outcome, never executed again); a callback the current controller admitted still stays pending.

**The record already exists.** The intent is the Runner's durable semantic input (committed before dispatch, keyed by call ID). The outcome is the server's idempotency receipt in `heartbeat_runs.result_json.semanticToolReceipts`. For `write_document` the revision, the activity row and the receipt commit in one transaction under the run and issue row locks, and the revision is compare-and-swap on `baseRevisionId`.

**What it proves.** Receipt present: applied. Receipt absent: not applied, because the effect cannot commit without it. So recovery runs the same receipt-guarded mutation. It replays the saved result or applies the write for the first time, never twice. A late original callback then replays the receipt. A stale base, a reused key or invalid input is the call's definite outcome and settles as a tool error. Any other failure leaves the call unsettled, as before. The set of operations with this proof is explicit (`TRANSACTIONAL_RECEIPT_OPERATIONS`, `write_document` only); other tools keep their current rules.

This makes the gateway call idempotent on its durable input, which is the cleaner proof the brief allowed. It needs no Runner change and no new image.

**Not done.** Exposing the cleanup-gate owner's run id so the server can drop the 50-run scan bound from #20639 (optional in the brief) is left out to keep scope.

## Upgrade safety

- Old saved state, new code. A `turn_starting` session saved by an older Runner has no journal (or one for another turn): unknown, so the old lost-turn path runs unchanged. Old receipts already have the shape the transactional recovery reads.
- New state, old code mid-deploy. Change 1 adds no field to `acpx-provider-state.json` (its decoder denies unknown fields). It only saves lifecycles an old Runner already handles (`prepared`, then `suspended`/`session_open`). An old Runner ignores the journal file. Change 2 changes no saved shape.
- New Runner, old sidecar. Possible only with a stale pack; the contract digest prevents reuse. If it happens anyway, an old sidecar writes no `received` line, so the proof never forms.

## Time to first token

Change 2 touches only recovery. Change 1 adds to every turn, before the prompt reaches the provider: one small unsynced file write when the turn starts, and one append plus `fsync` immediately before the prompt write. It adds no wait, no file transfer and no round trip. The measured cost is in the change 1 PR (target: well under 5 ms p95 on local disks, against a 9.5–16.5 s TTFT p50 budget). Recovery-time work (fence proof, journal read) runs only after a failure.
