import type { FaultReceipt, OracleResult, RuleId, RuleResult, TaskGrade, TaskRecord, TaskSample } from "./types.js";
import { g1Decision } from "./workloads.js";

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

/** The status a task rests in when it succeeds: `done`, or `cancelled` for a G1 request the board rejected. */
export function expectedFinalStatus(record: TaskRecord): string {
  return record.plan.workload === "G1" && g1Decision(record.plan.nonce) === "reject" ? "cancelled" : "done";
}

export function gradeR1(record: TaskRecord, budgetMs: number, faults: readonly FaultReceipt[]): RuleResult {
  if (record.launchError) return { verdict: "fail", detail: `launch_failed: ${record.launchError}` };
  if (record.retry) return { verdict: "n/a", detail: "task rested needing Retry; graded under R3" };
  const expected = expectedFinalStatus(record);
  if (record.finalStatus !== expected) {
    return { verdict: "fail", detail: record.timedOut ? `no_rest_within_budget (last status ${record.finalStatus ?? "unknown"})` : `rested_not_done (status ${record.finalStatus ?? "unknown"}, no Retry offered)` };
  }
  const allowed = budgetMs + outageOverlapMs(record, faults);
  const took = (record.restAt ?? Number.POSITIVE_INFINITY) - record.createdAt!;
  return took <= allowed
    ? { verdict: "pass", detail: `${expected} after ${Math.round(took / 1000)}s (allowed ${Math.round(allowed / 1000)}s)` }
    : { verdict: "fail", detail: `done_too_late ${Math.round(took / 1000)}s > ${Math.round(allowed / 1000)}s` };
}

export function gradeR2(record: TaskRecord, oracle: OracleResult): RuleResult {
  const last = lastReachable(record);
  if (!last) return { verdict: "fail", detail: "no_reachable_sample" };
  if (last.interruption?.workspaceFailure) return { verdict: "fail", detail: `workspace_failure_visible_at_rest: ${last.interruption.workspaceFailure}` };
  if (record.preFaultSnapshotError) {
    return { verdict: "fail", detail: `pre_fault_snapshot_failed: durability not checked (${record.preFaultSnapshotError})` };
  }
  if (record.restSnapshotError) {
    return { verdict: "fail", detail: `rest_snapshot_failed: durability not checked (${record.restSnapshotError})` };
  }
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
  const own = gradeOwnRetry(record);
  const childClicks = record.childRetries?.length ?? 0;
  if (!childClicks || own.verdict === "fail") return own;
  return { verdict: "fail", detail: `retry_needed_on_subtask_${childClicks} (${record.childRetries!.map(attempt => attempt.childIssueId).join(",")})` };
}

function gradeOwnRetry(record: TaskRecord): RuleResult {
  const last = lastReachable(record);
  if (!record.retry) {
    if (record.finalStatus !== expectedFinalStatus(record) && !record.timedOut && !record.launchError) {
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
  if (record.finalStatus !== expectedFinalStatus(record)) return { verdict: "fail", detail: `retry_did_not_complete (status ${record.finalStatus ?? "unknown"}${record.timedOut ? ", timed out" : ""})` };
  const clicks = 1 + (record.priorRetries?.length ?? 0);
  const failed = failedRunCodes(record).join(",") || "unknown";
  if (clicks > 1) return { verdict: "fail", detail: `retry_needed_${clicks}_clicks (${failed})` };
  return { verdict: "fail", detail: `retry_needed (${failed})` };
}

function failedRunCodes(record: TaskRecord): string[] {
  const codes = new Map<string, string>();
  for (const sample of record.samples) {
    for (const run of sample.runs ?? []) if (run.status === "failed") codes.set(run.id, run.errorCode ?? "failed");
  }
  return [...codes.values()];
}

/** Run cancellations decided before adapter dispatch: the run never executed. */
const PRE_DISPATCH_CANCELLATIONS = new Set(["continuation_task_ownership_changed"]);

/**
 * R4 is about duplicate execution. A queued or scheduled wake waiting behind a
 * running run (for example a follow-up comment, cancelled when the running run
 * finished) never executed, so it is not a duplicate. Fail only when two runs
 * of the issue actually executed at the same time (both running in a sample,
 * or overlapping started→finished windows), or when a comment is consumed
 * twice: a wake comment may be reused only by a run that follows a run which
 * did not succeed (an explicit retry or continuation after a failure); reuse
 * after a successful run is a replay.
 */
export function gradeR4(record: TaskRecord): RuleResult {
  const finalRuns = new Map<string, NonNullable<TaskSample["runs"]>[number]>();
  for (const sample of reachable(record.samples)) for (const run of sample.runs ?? []) finalRuns.set(run.id, run);
  // Claiming marks a run running before dispatch, so a run that ended as a
  // pre-dispatch cancellation never executed, whatever a poll saw.
  const neverExecuted = (id: string) => {
    const final = finalRuns.get(id);
    return final?.status === "cancelled" && PRE_DISPATCH_CANCELLATIONS.has(final.errorCode ?? "");
  };
  for (const sample of reachable(record.samples)) {
    const running = (sample.runs ?? []).filter(run => run.status === "running" && !neverExecuted(run.id));
    if (running.length > 1) return { verdict: "fail", detail: `concurrent_runs: ${running.map(run => `${run.id}(${run.status})`).join(",")}` };
  }
  const begun = [...finalRuns.values()].filter(run => run.startedAt)
    .sort((a, b) => (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0));
  // A continuation cancelled as stale before adapter dispatch was claimed but
  // never executed (chaos s9401/t72), so it cannot overlap another run. Its
  // message is saved and delivered by a later run, counted once below.
  const executed = begun.filter(run => !(run.status === "cancelled" && PRE_DISPATCH_CANCELLATIONS.has(run.errorCode ?? "")));
  // Execution windows seen between polls: started → finished (or still going at the last sample).
  const lastAt = Math.max(0, ...reachable(record.samples).map(sample => sample.at));
  const window = (run: (typeof begun)[number]) => ({ start: ms(run.startedAt) || 0,
    end: run.finishedAt ? ms(run.finishedAt) || 0 : ACTIVE_RUN_STATUSES.has(run.status) ? lastAt : ms(run.startedAt) || 0 });
  for (let index = 0; index < executed.length; index += 1) for (let other = index + 1; other < executed.length; other += 1) {
    const [a, b] = [window(executed[index]!), window(executed[other]!)];
    if (a.start < b.end && b.start < a.end) {
      return { verdict: "fail", detail: `concurrent_runs: ${executed[index]!.id}(${executed[index]!.status}),${executed[other]!.id}(${executed[other]!.status}) executed together` };
    }
  }
  const consumers = new Map<string, typeof begun>();
  for (const run of begun) for (const commentId of run.wakeCommentIds) consumers.set(commentId, [...(consumers.get(commentId) ?? []), run]);
  for (const [commentId, runs] of consumers) {
    const replayed = runs.findIndex((_run, index) => index > 0 && runs.slice(0, index).some(prior => prior.status === "succeeded"));
    if (replayed > 0) return { verdict: "fail", detail: `comment_consumed_twice: ${commentId} by ${runs.slice(0, replayed + 1).map(run => run.id).join(",")}` };
  }
  return { verdict: "pass", detail: "no two runs executed together; no comment consumed after a successful run" };
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

export function deadRunningRun(sample: TaskSample, readySince: number): { id: string; idleMs: number } | null {
  if (!sample.reachable || !sample.serverReady || sample.at - readySince <= STALL_LIMIT_MS) return null;
  for (const run of sample.runs ?? []) {
    if (run.status !== "running") continue;
    // Quiet is not dead while a tool is still in flight or the run's process is verifiably alive.
    if (run.toolInFlight || run.processAlive) continue;
    const evidence = Math.max(ms(run.lastEvidenceAt) || 0, ms(run.startedAt) || 0, readySince);
    if (sample.at - evidence > STALL_LIMIT_MS) return { id: run.id, idleMs: sample.at - Math.max(ms(run.lastEvidenceAt) || 0, ms(run.startedAt) || 0) };
  }
  return null;
}

export function gradeR5(record: TaskRecord): RuleResult {
  let stallStart: number | null = null;
  let worst = 0;
  let readySince: number | null = null;
  for (const sample of record.samples) {
    if (!sample.reachable || !sample.serverReady) { stallStart = null; readySince = null; continue; }
    readySince ??= sample.at;
    const dead = deadRunningRun(sample, readySince);
    if (dead) return { verdict: "fail", detail: `silent_dead_run ${dead.id} running with no event, activity or start evidence for ${Math.round(dead.idleMs / 1000)}s` };
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
    ...(sweep.daytonaLeaks ?? []),
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
