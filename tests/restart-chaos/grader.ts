import type { FaultReceipt, OracleResult, RuleId, RuleResult, TaskGrade, TaskRecord, TaskSample } from "./types.js";

/** Pure R1–R6 grading over observer samples (plan §2). No I/O. */

export const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);
export const STALL_LIMIT_MS = 3 * 60_000;
const REST_STATUSES_WITH_WORK = new Set(["todo", "in_progress"]);

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

function faultWindow(fault: FaultReceipt): [number, number] {
  return [fault.startedAt, fault.readyAt ?? fault.healthyAt ?? Number.POSITIVE_INFINITY];
}

/**
 * Restart-crossing: some run of the task (queued wake through finalization)
 * overlaps the fault window, or the task was not yet at rest when it started.
 */
export function crossingFaults(record: TaskRecord, faults: readonly FaultReceipt[]): string[] {
  if (record.createdAt === null) return [];
  const latest = new Map<string, { run: NonNullable<TaskSample["runs"]>[number]; at: number }>();
  for (const sample of record.samples) for (const run of sample.runs ?? []) latest.set(run.id, { run, at: sample.at });
  const runs = new Map<string, { start: number; end: number }>();
  for (const [id, { run, at }] of latest) {
    const start = ms(run.createdAt) || ms(run.startedAt) || at;
    const end = ACTIVE_RUN_STATUSES.has(run.status) ? Number.POSITIVE_INFINITY : (ms(run.finishedAt) || at);
    runs.set(id, { start, end });
  }
  const restAt = record.restAt ?? Number.POSITIVE_INFINITY;
  return faults.filter(fault => {
    const [start, end] = faultWindow(fault);
    if (record.createdAt! <= start && restAt > start) return true;
    return [...runs.values()].some(run => run.start <= end && run.end >= start);
  }).map(fault => fault.faultId);
}

function reachable(samples: readonly TaskSample[]) { return samples.filter(sample => sample.reachable); }

function lastReachable(record: TaskRecord): TaskSample | undefined {
  const values = reachable(record.samples);
  return values[values.length - 1];
}

export function outageOverlapMs(record: TaskRecord, faults: readonly FaultReceipt[]): number {
  if (record.createdAt === null) return 0;
  const end = record.restAt ?? Number.POSITIVE_INFINITY;
  return faults.reduce((total, fault) => {
    const [start, stop] = faultWindow(fault);
    const overlap = Math.min(stop, end) - Math.max(start, record.createdAt!);
    return total + (Number.isFinite(overlap) && overlap > 0 ? overlap : 0);
  }, 0);
}

export function gradeR1(record: TaskRecord, budgetMs: number, faults: readonly FaultReceipt[]): RuleResult {
  if (record.launchError) return { verdict: "fail", detail: `launch_failed: ${record.launchError}` };
  if (record.retry) return { verdict: "n/a", detail: "task rested needing Retry; graded under R3" };
  if (record.finalStatus !== "done") {
    return { verdict: "fail", detail: record.timedOut ? `no_rest_within_budget (last status ${record.finalStatus ?? "unknown"})` : `rested_not_done (status ${record.finalStatus ?? "unknown"}, no Retry offered)` };
  }
  const allowed = budgetMs + outageOverlapMs(record, faults);
  const took = (record.restAt ?? Number.POSITIVE_INFINITY) - record.createdAt!;
  return took <= allowed
    ? { verdict: "pass", detail: `done after ${Math.round(took / 1000)}s (allowed ${Math.round(allowed / 1000)}s)` }
    : { verdict: "fail", detail: `done_too_late ${Math.round(took / 1000)}s > ${Math.round(allowed / 1000)}s` };
}

export function gradeR2(record: TaskRecord, oracle: OracleResult): RuleResult {
  const last = lastReachable(record);
  if (!last) return { verdict: "fail", detail: "no_reachable_sample" };
  if (last.interruption?.workspaceFailure) return { verdict: "fail", detail: `workspace_failure_visible_at_rest: ${last.interruption.workspaceFailure}` };
  if (record.lostFiles?.length) {
    return { verdict: "fail", detail: `pre_fault_files_lost: ${record.lostFiles.slice(0, 10).join(",")}` };
  }
  const fileChecks = oracle.checks.filter(check => /file|workspace_located/.test(check.name) && !check.ok);
  if (fileChecks.length && record.finalStatus === "done") {
    return { verdict: "fail", detail: `workspace_files_missing_after_done: ${fileChecks.map(check => check.name).join(",")}` };
  }
  const transient = record.samples.some(sample => sample.interruption?.workspaceFailure);
  return { verdict: "pass", detail: transient ? "workspace failure appeared during recovery and cleared" : "no workspace failure at rest" };
}

export function gradeR3(record: TaskRecord): RuleResult {
  const last = lastReachable(record);
  if (!record.retry) {
    if (record.finalStatus !== "done" && !record.timedOut && !record.launchError) {
      return { verdict: "fail", detail: `missing_retry: rested ${record.finalStatus ?? "unknown"} with canRetry=${String(last?.interruption?.canRetry ?? false)}` };
    }
    return { verdict: "n/a", detail: "no Retry needed" };
  }
  if (record.retry.error || record.retry.accepted !== true) {
    return { verdict: "fail", detail: `retry_rejected: http=${record.retry.httpStatus ?? "none"} accepted=${String(record.retry.accepted)} ${record.retry.error ?? ""}`.trim() };
  }
  const retryAt = record.retry.at;
  const newRun = record.samples.some(sample => (sample.runs ?? []).some(run => (ms(run.createdAt) || 0) >= retryAt - 1_000));
  if (!newRun) return { verdict: "fail", detail: "retry_no_new_run" };
  if (record.finalStatus !== "done") return { verdict: "fail", detail: `retry_did_not_complete (status ${record.finalStatus ?? "unknown"}${record.timedOut ? ", timed out" : ""})` };
  return { verdict: "pass", detail: "one Retry started a run that completed the task" };
}

export function gradeR4(record: TaskRecord): RuleResult {
  for (const sample of reachable(record.samples)) {
    const running = (sample.runs ?? []).filter(run => run.status === "running");
    if (running.length > 1) return { verdict: "fail", detail: `concurrent_runs: ${running.map(run => run.id).join(",")}` };
  }
  const consumed = new Map<string, Set<string>>();
  const finalRuns = new Map<string, { status: string; wakeCommentIds: string[] }>();
  for (const sample of reachable(record.samples)) for (const run of sample.runs ?? []) finalRuns.set(run.id, run);
  for (const [runId, run] of finalRuns) {
    if (run.status !== "succeeded") continue;
    for (const commentId of run.wakeCommentIds) {
      const runs = consumed.get(commentId) ?? new Set<string>();
      runs.add(runId);
      consumed.set(commentId, runs);
    }
  }
  const duplicate = [...consumed].find(([, runs]) => runs.size > 1);
  if (duplicate) return { verdict: "fail", detail: `comment_consumed_twice: ${duplicate[0]} by ${[...duplicate[1]].join(",")}` };
  return { verdict: "pass", detail: "at most one running run per sample; no comment consumed twice" };
}

function namedWait(sample: TaskSample): boolean {
  const interruption = sample.interruption;
  return Boolean(sample.executionBlocker || sample.scheduledRetry || sample.activeRecoveryAction || interruption?.retryWait
    || interruption?.state === "retry_scheduled" || interruption?.canRetry
    || (interruption && ["failed", "waiting_for_user"].includes(interruption.state)));
}

export function isStalledSample(sample: TaskSample): boolean {
  if (!sample.reachable || !sample.serverReady) return false;
  if (!REST_STATUSES_WITH_WORK.has(sample.issueStatus ?? "")) return false;
  if ((sample.runs ?? []).some(run => ACTIVE_RUN_STATUSES.has(run.status))) return false;
  return !namedWait(sample);
}

export function gradeR5(record: TaskRecord): RuleResult {
  let stallStart: number | null = null;
  let worst = 0;
  for (const sample of record.samples) {
    if (!sample.reachable || !sample.serverReady) { stallStart = null; continue; }
    if (isStalledSample(sample)) {
      stallStart ??= sample.at;
      worst = Math.max(worst, sample.at - stallStart);
      if (sample.at - stallStart > STALL_LIMIT_MS) {
        return { verdict: "fail", detail: `silent_stall ${Math.round((sample.at - stallStart) / 1000)}s in ${sample.issueStatus} with no live run, wake or wait reason` };
      }
    } else stallStart = null;
  }
  return { verdict: "pass", detail: worst ? `longest unexplained idle ${Math.round(worst / 1000)}s` : "no unexplained idle" };
}

export function gradeR6(record: TaskRecord): RuleResult {
  const sweep = record.sweep;
  if (!sweep) return { verdict: "fail", detail: "rest_sweep_missing" };
  if (sweep.error) return { verdict: "fail", detail: `rest_sweep_error: ${sweep.error}` };
  const leaks = [
    ...(sweep.activeRuns.length ? [`active_runs=${sweep.activeRuns.join(",")}`] : []),
    ...(sweep.runningWorkspaceOperations.length ? [`running_workspace_operations=${sweep.runningWorkspaceOperations.join(",")}`] : []),
    ...(sweep.activeRecoveryAction ? ["active_recovery_action"] : []),
  ];
  return leaks.length ? { verdict: "fail", detail: `leak: ${leaks.join("; ")}` } : { verdict: "pass", detail: "clean rest" };
}

export function gradeTask(record: TaskRecord, faults: readonly FaultReceipt[], budgetMs: number, oracle: OracleResult): TaskGrade {
  const crossing = crossingFaults(record, faults);
  const rules: Record<RuleId, RuleResult> = {
    R1: gradeR1(record, budgetMs, faults),
    R2: gradeR2(record, oracle),
    R3: gradeR3(record),
    R4: gradeR4(record),
    R5: gradeR5(record),
    R6: gradeR6(record),
  };
  const failed = (Object.entries(rules) as Array<[RuleId, RuleResult]>).find(([, rule]) => rule.verdict === "fail");
  const pass = !failed && oracle.verdict === "pass";
  let signature: string | null = null;
  if (failed) signature = `${failed[0]}:${failed[1].detail.split(/[\s:(]/)[0]}:${record.plan.workload}:${record.plan.fault}`;
  else if (oracle.verdict === "fail") signature = `T:${oracle.checks.find(check => !check.ok)?.name ?? "unknown"}:${record.plan.workload}:${record.plan.fault}`;
  return { crossed: crossing.length > 0, crossingFaults: crossing, rules, T: oracle, pass, signature };
}
