/**
 * Registry of named crash points (durable ownership plan, "Testing: enumerate
 * crash points"). Browser-safe data only; the helper is in `crash-points.ts`.
 *
 * Each point marks one durable write boundary. Add a point by adding an entry
 * here and one `crashPoint("<name>")` call at the boundary; see
 * tests/restart-chaos/README.md, "Crash-point suite".
 *
 * Name: `<subsystem>.<record>.<before|after>_<step>`, lower snake case.
 * `kinds` are ownable kind ids from server/src/services/recovery/ownership-registry.ts
 * (the Phase 1 registry of doc/plans/2026-11-07-ownership-inventory.md). `invariants` are the plan's
 * I1–I8 that a crash here puts at risk. `environments` are where a suite task
 * reaches the point (a local run never creates a sandbox, for example).
 */

export type CrashPointInvariant = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8";
export type CrashPointEnvironment = "local" | "daytona";

export type CrashPointDefinition = {
  description: string;
  environments: readonly CrashPointEnvironment[];
  kinds: readonly string[];
  invariants: readonly CrashPointInvariant[];
  /** What a run must go through first when one plain task does not reach the point. */
  prerequisite?: string;
};

export const CRASH_POINT_NAME_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.(before|after)_[a-z0-9_]+$/;

export const CRASH_POINTS = {
  "sandbox.create.after_intent_before_provider": {
    description: "The sandbox_creation_operations intent is committed; the provider create call has not been made. Recovery must settle the intent without a sandbox to find.",
    environments: ["daytona"],
    kinds: ["sandbox_creation_intent"],
    invariants: ["I1", "I2", "I7"],
  },
  "sandbox.create.after_provider_before_lease": {
    description: "The provider created the sandbox; no environment lease row records it yet. Recovery must adopt or destroy the sandbox from the intent, never leak it.",
    environments: ["daytona"],
    kinds: ["sandbox_creation_intent", "environment_run_lease_active"],
    invariants: ["I2", "I7"],
  },
  "native.process_start.after_requested_before_spawn": {
    description: "native.process_start_requested is in the run log; runnerd has not been spawned. No provider work started, so a resumed attempt must not be charged.",
    environments: ["local", "daytona"],
    kinds: ["native_startup_context", "native_executor_claim"],
    invariants: ["I2", "I5", "I7"],
  },
  "runner.process.after_spawn_before_identity": {
    description: "runnerd is spawned (own process group, survives the server); its pid and process identity are not yet recorded on the run. Recovery must find or stop the orphan by identity. Local spawns only: a remote launcher returns before runnerd exists.",
    environments: ["local"],
    kinds: ["native_executor_claim", "detached_process_marker"],
    invariants: ["I1", "I2", "I5"],
  },
  "runner.turn_start.after_runner_accept_before_controller_checkpoint": {
    description: "runnerd returned the turn.start result; the controller's command journal still says pending. Recovery must adopt the accepted turn, not start a second one.",
    environments: ["local", "daytona"],
    kinds: ["native_executor_claim", "native_restart_recovery_claim"],
    invariants: ["I4", "I5", "I6"],
  },
  "runner.turn_start.after_controller_journal_before_db_checkpoint": {
    description: "The controller journal recorded the turn.start result; the next send and (remote runs) the database checkpoint have not happened.",
    environments: ["local", "daytona"],
    kinds: ["native_restart_recovery_claim"],
    invariants: ["I4", "I6"],
  },
  "native.result.after_accept_before_finalize": {
    description: "The run's result and its workspace_finalizing finalization row are committed; finalization has not started. The accepted result must be finalized exactly once.",
    environments: ["local", "daytona"],
    kinds: ["native_accepted_result_lease", "native_finalizer_lease"],
    invariants: ["I2", "I4", "I7"],
  },
  "native.finalize.after_decision_before_projection": {
    description: "The status decision is committed; the run and issue projection is not. Recovery must finish the projection, not decide again.",
    environments: ["local", "daytona"],
    kinds: ["native_finalizer_lease"],
    invariants: ["I2", "I7"],
  },
  "workspace.finalize.after_start_before_copyback": {
    description: "A workspace_finalize operation row is running; copyback or export has not started. Recovery must settle the operation and keep the workspace.",
    environments: ["local", "daytona"],
    kinds: ["native_workspace_finalize_attempt", "copyback_owner_hold"],
    invariants: ["I1", "I2", "I7"],
  },
  "workspace.finalize.after_copyback_before_done": {
    description: "Copyback or export finished; the workspace operation row still says running. Recovery must settle it without copying again over newer work.",
    environments: ["local", "daytona"],
    kinds: ["native_workspace_finalize_attempt", "copyback_owner_hold"],
    invariants: ["I2", "I7"],
  },
  "environment.lease_release.after_provider_before_lease": {
    description: "The provider released the sandbox; the environment lease row is still active.",
    environments: ["daytona"],
    kinds: ["environment_run_lease_active"],
    invariants: ["I2"],
  },
  "environment.teardown.after_claim_before_destroy": {
    description: "A pending_cleanup teardown claim is held; the provider destroy has not been called. Proof of the dead claimant must release the claim, not a TTL.",
    environments: ["daytona"],
    kinds: ["environment_teardown_claim", "environment_pending_cleanup"],
    invariants: ["I2", "I7"],
    prerequisite: "A pending_cleanup lease: a provider release that failed or could not be verified. A plain task's release succeeds and never claims a teardown.",
  },
  "environment.teardown.after_destroy_before_lease": {
    description: "A reusable sandbox was destroyed at the provider; its lease row is not released.",
    environments: ["daytona"],
    kinds: ["environment_run_lease_active", "environment_retained_hold"],
    invariants: ["I2"],
    prerequisite: "A reuse_by_environment lease that expires or is replaced (destroyReusableSandboxLease). The chaos Daytona environment's leases are ephemeral by default.",
  },
  "environment.stop_retain.after_claim_before_stop": {
    description: "A stop-and-retain intent and its claim are committed; the provider stop has not been retried.",
    environments: ["daytona"],
    kinds: ["environment_stop_and_retain_intent"],
    invariants: ["I2", "I7"],
    prerequisite: "A stop-and-retain intent: a run whose sandbox must be stopped but kept, for a native workspace export resume.",
  },
  "environment.lease.after_release_before_runtime_services": {
    description: "The run's environment leases are released; its workspace runtime services are not.",
    environments: ["local", "daytona"],
    kinds: ["execution_workspace_runtime_lease", "workspace_runtime_service"],
    invariants: ["I2"],
  },
  "wake.claim.after_run_running_before_wakeup_claimed": {
    description: "The claimed run is running; its wake request still says queued. The wake must be delivered exactly once.",
    environments: ["local", "daytona"],
    kinds: ["wake_request_claimed"],
    invariants: ["I4", "I7"],
  },
  "budget.reservation.after_hold_before_dispatch": {
    description: "The run's budget reservation hold is committed; the run has not been dispatched. The hold must not gate admission or outlive the run.",
    environments: ["local", "daytona"],
    kinds: ["run_accounting_debt"],
    invariants: ["I2", "I3", "I5"],
  },
  "accounting.usage_receipt.after_spool_before_db": {
    description: "A usage receipt is fsynced to the local spool; its database row is not written.",
    environments: ["local", "daytona"],
    kinds: ["usage_receipt_spool"],
    invariants: ["I3", "I4"],
  },
  "accounting.usage_receipt.after_db_before_unlink": {
    description: "The usage receipt row is written; its spool file is not removed. Replaying the spool must not double-count.",
    environments: ["local", "daytona"],
    kinds: ["usage_receipt_spool"],
    invariants: ["I4"],
  },
  "accounting.closure.after_commit_before_spool_unlink": {
    description: "Run accounting is closed (reservation settled, cost recorded); the recovered spool files are not removed.",
    environments: ["local", "daytona"],
    kinds: ["run_accounting_debt", "usage_receipt_spool"],
    invariants: ["I3", "I4"],
  },
} as const satisfies Record<string, CrashPointDefinition>;

export type CrashPointName = keyof typeof CRASH_POINTS;

export function isCrashPointName(value: string): value is CrashPointName {
  return Object.prototype.hasOwnProperty.call(CRASH_POINTS, value);
}
