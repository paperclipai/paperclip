# Explicit claim tokens for native execution leases

Status: proposed follow-up (step 2). Step 1 shipped with the host-sleep lease fix.

## Problem

`native_run_finalizations.lease_expires_at` means two things today. It means
"nobody renewed this lease", and many actors also read it as "the owner is gone".
A host sleep makes the first true without the second: the wall clock and the
database clock jump past the 20-minute executor lease, while the server's
monotonic timers barely move. When the next renewal tick ran, it found its own
lease expired and interrupted a healthy turn (`native_session_lease_lost`, and the
user had to click Retry). The restart-chaos fault TM2 reproduces this.

## Step 1 (shipped)

The owner can take back its own lapsed lease in one conditional UPDATE. The UPDATE
runs under the coordinator row lock, followed by a share lock on the run. It
succeeds only when all of these hold:

- the owner token, attempt, controller generation, and controller boot, pid and
  process start are unchanged;
- the phase is `observed` and no result was accepted;
- `recovery_state`, `recovery_request_id`, `failure_code` and `next_attempt_at`
  are null, or (2026-11-10) they still show exactly the local restart-recovery
  claim that granted this lease: the last `recovery_history` entry names this
  boot and generation, its disposition pairs with `recovery_state`
  (`resume_dead_runner`/`resuming_session`, `reattach_existing_runner`/
  `awaiting_runner_reattach`, `bootstrap_incomplete`/`bootstrap_incomplete`),
  and `recovery_request_id` is the request that claim recorded. A resumed run
  keeps that state until a result is accepted, so without this rule it could
  never survive a later host sleep;
- `controller_host_hash` is not the board's attested-stopped stamp;
- the run is still `running`, without the ownership-unverified error code and
  without a `nativeStartupCleanup` marker;
- the run is local.

After a result is accepted, the owner may only relinquish a lapsed lease, and
never renews it. The rule lives in `nativeExecutionLeaseHeldCondition` and
`lockNativeExecutionLeaseForReacquire` (`native-execution-lease.ts`). Renewal,
failure settlement and the final release use it. Budget admission of a restart
claim (`lockRunBudgetRecoveryOwnerInTransaction`) uses it too, through
`holdOwnNativeRecoveryClaimInTransaction` (2026-11-10). A restart claim whose lease
lapsed in a time jump before dispatch therefore takes the lease back when the row
still shows exactly that claim. The budget checks that follow are unchanged.

This works because every consumer that acts on a lapsed executor lease of a
running, pre-result run already writes one of those fields under the coordinator
lock first. Step 1 depends on that convention, so step 2 replaces it with an
explicit token.

## Gaps step 1 leaves open

1. **Workspace finalization** (`native-workspace-finalization-work.ts` →
   `attemptNativeWorkspaceFinalization`). It copies back on a lapsed post-result
   lease. It is fenced only by the copyback advisory lock and the
   `nativeWorkspaceFinalizationOwner` CAS, never by a coordinator write. For this
   reason a post-result lease is never renewed.
2. **Another server's orphan sweep** (`heartbeat/recovery.ts`
   `markNativeOwnershipUnverified`). It writes the run's error code without the
   coordinator lock. If the marker lands first, the owner is fenced. If the sweep
   reads the row before the owner takes the lease back and writes afterwards,
   a live run carries an ownership-unverified error. This needs two server
   processes on one database, and the timing that strands a run is as rare as before.
   Closed without the epoch (2026-11-10): the sweep now writes its marker under the
   coordinator row lock and only while no executor lease on the run is live
   (`setRunStatusFromLive` option `onlyWhileNativeLeaseLapsed`). Test:
   `server/src/__tests__/heartbeat-native-orphan-sweep-lease-race.test.ts`.
3. **Shared-workspace holder detection** (`remote-workspace-writer-hold.ts`
   `runOwnerFenceHeldSql`). This is a read. A run silent past the stale threshold
   with both leases lapsed stops counting as the holder, and nothing is claimed.
4. **Board copyback-owner confirmation on another host**
   (`native-workspace-owner-recovery.ts`). It is accepted on the board's word.
5. **Remote leases.** Unchanged. The remote runner is fenced by its own
   controller lease, and step 1 never takes a remote lease back.

## Step 2

Add `lease_claim_token text` (nullable) and `lease_epoch integer not null default 0`
to `native_run_finalizations` (AGENTS.md §6 migration).

- An owner claim sets `lease_epoch = lease_epoch + 1` and clears `lease_claim_token`.
- A consumer that acts on a lapsed lease first runs
  `update … set lease_claim_token = $consumer, lease_epoch = lease_epoch + 1 where run_id = $1 and lease_epoch = $seen and lease_expires_at <= clock_timestamp() and lease_claim_token is null`.
  Only the winner acts.
- The owner takes a lease back with
  `… where lease_epoch = $mine and lease_claim_token is null`. Expiry is no
  longer part of that decision.
- Move gaps 1, 2 and 4 to that claim. Workspace finalization claims before its
  copyback, and the orphan sweep claims before it writes its marker. Then
  post-result renewal can take the lease back as well.
- Upgrade: rows saved by step 1 have epoch 0 and a null token. A step-1 server
  that is still draining never reads the new columns. Ship the consumers' claims
  before the owner path relies only on the token, so that both orders stay fenced
  during a rolling upgrade.
- Tests: one race test per consumer that runs its real claim against the owner
  taking the lease back, and an old-saved/new-resumed row.
