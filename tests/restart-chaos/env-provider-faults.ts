/**
 * Environment-provider fault family (EP1): pure catalog, control format and oracle.
 *
 * Staging (2026-11-11, 14:00-14:45Z) had five Daytona lease acquisitions time
 * out ("Daytona lease acquisition timed out; allocation cleanup is pending")
 * and one fail on a database query, all before any provider work. None got a
 * bounded retry, and two tasks were left blocked on a board-owned
 * `stranded_assigned_issue` recovery action. Every other harness fault hits
 * the control plane, storage or the provider stream; nothing failed lease
 * acquisition itself.
 *
 * The server seam is `server/src/services/environment-lease-fault-injection.ts`
 * (test mode only): it throws the staging error shapes for each task's first
 * N acquisitions, before any provider call, so a local wave exercises the
 * same retry and Retry paths a Daytona outage does.
 *
 * Oracle, per task:
 *   1. bounded retry: exactly the expected number of runs fail with
 *      `environment_provider_unavailable`, never a generic `setup_failed`;
 *   2. no board-owned recovery action is ever active on the task;
 *   3. EP1/EP1D: the task completes with no user action;
 *      EP1N (never clears): the task rests offering Retry, and after the
 *      harness disarms the fault and clicks Retry the task completes;
 *   4. the A1 brief oracle passes.
 *
 * I/O lives in env-provider-wave.ts; this file is credential-free and unit tested.
 */

export const ENV_PROVIDER_FAULT_KINDS = ["EP1", "EP1N", "EP1D"] as const;
export type EnvProviderFaultKind = (typeof ENV_PROVIDER_FAULT_KINDS)[number];

/** BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS in server/src/services/heartbeat/retries.ts. */
export const AUTOMATIC_RETRY_BOUND = 2;

export interface EnvProviderFault {
  kind: EnvProviderFaultKind;
  label: string;
  /** The server seam's error shape. */
  shape: "timeout" | "database";
  /** Failures per task; null never clears until the harness disarms it. */
  failures: number | null;
}

export const ENV_PROVIDER_FAULTS: Record<EnvProviderFaultKind, EnvProviderFault> = {
  EP1: { kind: "EP1", label: "Lease acquisition times out N times, then succeeds", shape: "timeout", failures: AUTOMATIC_RETRY_BOUND },
  EP1N: { kind: "EP1N", label: "Lease acquisition times out on every attempt", shape: "timeout", failures: null },
  EP1D: { kind: "EP1D", label: "A database query fails during lease acquisition once", shape: "database", failures: 1 },
};

/** The control file the seam reads (PAPERCLIP_CHAOS_LEASE_FAULT_CONTROL). An empty file disarms. */
export function leaseFaultControl(fault: EnvProviderFault, token: string): string {
  return JSON.stringify({ token, kind: fault.shape, failures: fault.failures });
}

/** Runs of the task in creation order, as `/api/issues/:id/runs` reports them. */
export interface EpRunSample { id: string; status: string; errorCode: string | null }

export interface EpTaskRecord {
  taskId: string;
  nonce: string;
  fault: EnvProviderFaultKind;
  issueId: string | null;
  harnessError: string | null;
  runs: EpRunSample[];
  /** Every recovery action seen active on the task at any poll. */
  activeRecoveryActions: Array<{ ownerType: string; kind: string; cause: string | null }>;
  /** Polls that read the task's recovery actions, and polls where that read failed. */
  recoveryReads: number;
  recoveryReadFailures: number;
  /** EP1N: the resting state before Retry. */
  rested: { issueStatus: string; canRetry: boolean; observedRunId: string | null } | null;
  retryClicked: boolean;
  finalStatus: string | null;
  briefOk: boolean | null;
}

export interface EpCheck { name: string; pass: boolean; detail: string }
export interface EpGrade { pass: boolean; checks: EpCheck[] }

export function gradeEnvProviderTask(record: EpTaskRecord): EpGrade {
  const fault = ENV_PROVIDER_FAULTS[record.fault];
  const failed = record.runs.filter(run => run.errorCode === "environment_provider_unavailable").length;
  const generic = record.runs.filter(run => run.errorCode === "setup_failed").length;
  const expected = fault.failures ?? AUTOMATIC_RETRY_BOUND + 1;
  const board = record.activeRecoveryActions.filter(action => action.ownerType === "board");
  const checks: EpCheck[] = [
    { name: "no_harness_error", pass: record.harnessError === null, detail: record.harnessError ?? "ok" },
    { name: "bounded_retry", pass: failed === expected && generic === 0,
      detail: `${failed} environment_provider_unavailable run(s), expected ${expected}; ${generic} setup_failed` },
    { name: "recovery_evidence_read", pass: record.recoveryReads > 0 && record.recoveryReadFailures === 0,
      detail: `${record.recoveryReads} read(s), ${record.recoveryReadFailures} failed` },
    { name: "no_board_recovery_action", pass: board.length === 0,
      detail: board.length ? board.map(action => `${action.kind}/${action.cause ?? "-"}`).join(", ") : "none" },
  ];
  if (fault.failures === null) {
    checks.push({ name: "rests_with_retry", pass: record.rested !== null && record.rested.canRetry,
      detail: record.rested ? `${record.rested.issueStatus}, canRetry=${String(record.rested.canRetry)}` : "never rested" });
    checks.push({ name: "retry_completes", pass: record.retryClicked && record.finalStatus === "done",
      detail: `retry ${record.retryClicked ? "clicked" : "not clicked"}, final ${record.finalStatus ?? "unknown"}` });
  } else {
    checks.push({ name: "completes_without_user", pass: !record.retryClicked && record.finalStatus === "done",
      detail: `final ${record.finalStatus ?? "unknown"}` });
  }
  checks.push({ name: "brief_oracle", pass: record.briefOk === true, detail: record.briefOk === null ? "not read" : String(record.briefOk) });
  return { pass: checks.every(check => check.pass), checks };
}
