# Watchdog runbook — silent-run detection, retry-stall auto-recovery, cascade guard

This runbook covers the api_retry-aware silent-run watchdog landed in AUR-33
(implementation issue AUR-57). It complements the AUR-35 family
(idempotency dedup, kill helper, source-issue wake) which provides the
underlying primitives.

## What the watchdog does

There are now **three** detectors that read state written by the heartbeat
runtime and may act on a long-running heartbeat run:

| Detector                    | Threshold (default)                                                                                | Action on fire                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Silent-output (suspicious)  | `lastLivenessAt` ≥ 1h ago                                                                          | Create a `stale_active_run_evaluation` review issue assigned to the run owner.                                            |
| Silent-output (critical)    | `lastLivenessAt` ≥ 4h ago                                                                          | Escalate the existing review issue, block the source issue.                                                               |
| Retry-stall (api_retry)     | `lastRetryAttempt ≥ 3` **and** `retryStallStartedAt ≥ 5m` without an intervening non-retry event   | `killProcessGroup(pgid)` → mark run `failed` with `errorCode=runtime_api_retry_exhausted` → emit one `runtime_api_retry_exhausted` review issue. |

All three detectors share a **single hard cascade guard** at the review-issue
emission entry point. The guard short-circuits unconditionally when the source
run's source issue has `originKind ∈ {stale_active_run_evaluation,
runtime_api_retry_exhausted}` (i.e. the source issue was itself created by
the watchdog) and emits a structured `cascade_suppressed` log line instead.
This is the depth-cap that prevents an outage-driven cascade where a review
issue spawns its own review issue.

## Why `lastLivenessAt` exists separately from `lastOutputAt`

The Claude CLI writes nothing to stdout while it is internally retrying
transient upstream Anthropic API failures. It does emit
`{"type":"system","subtype":"api_retry","attempt":N,...}` events on the
run-log stream during each retry. AUR-33 parses those events in
`server/src/services/recovery/api-retry-parser.ts`. When the chunk contains
only api_retry events, the heartbeat runtime updates `lastLivenessAt` only;
when the chunk contains real progress, it updates both `lastLivenessAt` and
`lastOutputAt`. The silent-output thresholds evaluate against
`lastLivenessAt`, so an actively-retrying CLI is no longer mis-classified as
silent. `lastOutputAt` remains available for diagnostics and is still
displayed on the evaluation issues.

## What `runtime_api_retry_exhausted` means vs. `stale_active_run_evaluation`

- **`stale_active_run_evaluation`** — the silent-output detector fired. The
  CLI has been quiet (no liveness signal, including no api_retry events) for
  ≥ 1h (suspicious) or ≥ 4h (critical). The run is still alive at the OS
  level; a human or assigned recovery owner must decide whether to continue,
  snooze, or cancel.
- **`runtime_api_retry_exhausted`** — the retry-stall detector fired. The CLI
  is alive and emitting api_retry events, but it has been stuck at
  `attempt ≥ PAPERCLIP_WATCHDOG_RETRY_STALL_ATTEMPT` for longer than
  `PAPERCLIP_WATCHDOG_RETRY_STALL_BUDGET_SEC` with no intervening real
  output. The watchdog has already attempted SIGTERM → SIGKILL on the
  process group and marked the run terminal (`status=failed`,
  `errorCode=runtime_api_retry_exhausted`). The review issue is informational
  — no recovery action is required if the source issue can simply be
  requeued once the upstream API outage clears.

## What `cascade_suppressed` log lines mean

Look for log entries of shape:

```json
{
  "event": "cascade_suppressed",
  "runId": "...",
  "sourceIssueId": "...",
  "sourceOriginKind": "stale_active_run_evaluation" | "runtime_api_retry_exhausted",
  "thresholdLevel": "suspicious" | "critical" | "retry_stall"
}
```

These mean: the watchdog wanted to open a review issue for `runId`, but the
source run's source issue was itself a watchdog-emitted recovery issue. The
guard suppressed the emission so we do not stack a second layer of review
work on top of an active outage. **No review issue was created.** If the
underlying outage is real you will still see one review issue at the bottom
of the chain (the one that triggered the first cascade); the cascade just
does not deepen past that.

## Manual recovery

1. Identify the affected run via the review issue's `Run` link.
2. If the CLI process is still alive (silent-output detectors only), decide
   whether to `recordWatchdogDecision({decision: "continue"})` or cancel the
   run via the existing cancel-run controls.
3. If the run is already terminal (`runtime_api_retry_exhausted`), confirm the
   upstream API has recovered, then requeue the source issue's heartbeat
   (assignment wake, or create a fresh heartbeat run on the source issue).
4. Close the review issue with a brief note (`done` if the source issue has
   resumed, `cancelled` if the source issue was abandoned).

## Rollback

Toggle the master flag off to revert all three behaviours simultaneously:

```bash
PAPERCLIP_WATCHDOG_API_RETRY_AWARE=false
```

With the flag off:

- The api_retry parser stops writing `lastLivenessAt`; silent-output
  detectors fall back to `lastOutputAt` (legacy behaviour, bit-equivalent).
- The retry-stall detector becomes a no-op.
- The hard cascade guard becomes a no-op.

No schema migration is required to roll back. The new columns (`last_liveness_at`,
`last_retry_attempt`, `last_retry_error_status`, `last_retry_error_message`,
`retry_stall_started_at`) and the partial unique index
`issues_active_runtime_api_retry_exhausted_uq` can stay in place; they are
inert when the flag is off.

## Configuration reference

All env vars are read at scan time so changes take effect on the next
heartbeat tick — no restart required.

| Env var                                       | Default       | Purpose                                                                              |
| --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `PAPERCLIP_WATCHDOG_API_RETRY_AWARE`          | `true`        | Master kill switch for AUR-33 behaviour.                                              |
| `PAPERCLIP_WATCHDOG_AUTO_RECOVER`             | `true`        | When `false`, retry-stall detector still emits the review issue but does not signal. |
| `PAPERCLIP_WATCHDOG_RETRY_STALL_ATTEMPT`      | `3`           | Minimum `attempt` value at which the retry-stall budget clock starts.                |
| `PAPERCLIP_WATCHDOG_RETRY_STALL_BUDGET_SEC`   | `300`         | Seconds the run may sit at `attempt ≥ threshold` before the detector fires.          |
| `PAPERCLIP_WATCHDOG_KILL_GRACE_MS`            | `10_000`      | Wait between SIGTERM and SIGKILL when terminating a stalled retry loop.              |

## False-positive playbook

Per the AUR-35 CEO directive, **any false-positive kill is treated as P1**.
If you see a `runtime_api_retry_exhausted` review issue and the run was in
fact making progress:

1. Page the platform on-call.
2. Capture the full run log (`run.logRef`) before any further action.
3. Bump `PAPERCLIP_WATCHDOG_RETRY_STALL_ATTEMPT` and/or
   `PAPERCLIP_WATCHDOG_RETRY_STALL_BUDGET_SEC` upward as a tactical mitigation.
4. File a follow-up issue with the captured log so the parser/detector
   thresholds can be tuned with evidence.

## Compose with the AUR-35 family

- AUR-37 — owns the `idempotencyKey` column. Until it lands, the AUR-33
  retry-stall detector stores its idempotency key in `originFingerprint` and
  is also protected by the partial unique index
  `issues_active_runtime_api_retry_exhausted_uq`.
- AUR-41 — owns the `process_auto_recovered` source-issue wake. The
  AUR-33 hard cascade guard sits one layer above and prevents the
  review-issue creation path from ever recursing.
- AUR-42 — owns the production `killProcessGroup` helper. AUR-33 ships with
  a minimal inline version in `server/src/services/recovery/kill-process-group.ts`
  so the retry-stall detector is usable today; AUR-42 will replace it.
