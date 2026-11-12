export type TaskVerdict = "pass" | "needed_retry" | "open_no_owner" | "blocked_non_person" | "waiting_on_person" | "still_working" | "cancelled";
export type PersonReason = "approval" | "question" | "dependency" | "review" | "usage_limit" | "budget" | "shared_credential";

export interface GradeRun {
  runId: string;
  status: string;
  errorCode: string | null;
  createdAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastActivityAt?: number | null;
}

export interface GradeInterruption {
  state: string;
  canRetry: boolean;
  retryWait: boolean;
  userAction: string | null;
  responsibility?: string | null;
  providerFailureCategory: string | null;
}

export interface RetryClick {
  at: number;
  accepted: boolean | null;
  via: "observer" | "grader";
}

export interface GradeTaskInput {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  runs: GradeRun[];
  queuedWakes: number;
  scheduledRetry: boolean;
  interruption: GradeInterruption | null;
  activeRecoveryOwner: string | null;
  executionBlocker: boolean;
  openBlockers: number;
  pendingApproval: boolean;
  pendingQuestion: boolean;
  retryClicks: RetryClick[];
  now?: number;
  staleAfterMs?: number;
  scheduledRetryAt?: number | null;
}

export type FailureLabel = "nothing pending" | "blocked for a non-person reason" | "needed Retry";

export interface TaskGrade {
  issueId: string;
  identifier: string | null;
  title: string;
  verdict: TaskVerdict;
  detail: string;
  status: string;
  retry: { clicks: number; accepted: number; worked: boolean | null } | null;
  personReason: PersonReason | null;
  reason: string | null;
  label: FailureLabel | null;
  lastActivityAgeMs: number | null;
  failedRuns: string[];
}

const LIVE_RUN = new Set(["queued", "running", "scheduled_retry"]);
const FAILED_RUN = new Set(["failed", "timed_out", "interrupted"]);
const SUCCEEDED_RUN = new Set(["succeeded"]);

export function personReason(task: GradeTaskInput): PersonReason | null {
  const action = task.interruption?.userAction ?? null;
  if (action === "approval" || task.pendingApproval) return "approval";
  if (action === "budget") return "budget";
  if (action === "reconnect") return "shared_credential";
  const category = task.interruption?.providerFailureCategory ?? null;
  if (category === "rate_limit" || category === "quota_exhausted") return "usage_limit";
  if (category === "authentication" || category === "permission") return "shared_credential";
  if (task.pendingQuestion) return "question";
  if (task.status === "in_review") return "review";
  if (task.openBlockers > 0) return "dependency";
  return null;
}

export function staleRuns(task: GradeTaskInput): GradeRun[] {
  if (task.now === undefined || task.staleAfterMs === undefined) return [];
  return task.runs.filter(run => LIVE_RUN.has(run.status) && (run.lastActivityAt ?? run.createdAt ?? 0) < task.now! - task.staleAfterMs!);
}

function liveOwner(task: GradeTaskInput): string | null {
  const stale = new Set(staleRuns(task).map(run => run.runId));
  const live = task.runs.find(run => LIVE_RUN.has(run.status) && !stale.has(run.runId));
  if (live) return `run ${live.runId} ${live.status}`;
  if (task.now !== undefined) return null;
  if (task.queuedWakes > 0) return `${task.queuedWakes} queued wake(s)`;
  if (task.scheduledRetry && !stale.size) return "scheduled retry";
  const interruption = task.interruption;
  if (!stale.size && interruption && (interruption.state === "working" || interruption.state === "retry_scheduled" || interruption.retryWait)) {
    return `interruption ${interruption.retryWait ? "retry waiting on the system" : interruption.state}`;
  }
  if (task.activeRecoveryOwner && task.activeRecoveryOwner !== "board") return `${task.activeRecoveryOwner} recovery action`;
  return null;
}

function retryPending(task: GradeTaskInput): boolean {
  const stale = new Set(staleRuns(task).map(run => run.runId));
  if (task.runs.some(run => LIVE_RUN.has(run.status) && !stale.has(run.runId))) return true;
  if (task.queuedWakes > 0) return true;
  if (task.scheduledRetry && (task.scheduledRetryAt == null || task.now === undefined || task.scheduledRetryAt > task.now)) return true;
  const interruption = task.interruption;
  return Boolean(interruption && (interruption.state === "working" || interruption.state === "retry_scheduled" || interruption.retryWait));
}

function retryOutcome(task: GradeTaskInput): TaskGrade["retry"] {
  if (!task.retryClicks.length) return null;
  const accepted = task.retryClicks.filter(click => click.accepted === true);
  const first = Math.min(...accepted.map(click => click.at));
  const worked = accepted.length === 0 ? false
    : task.status === "done" || task.runs.some(run => SUCCEEDED_RUN.has(run.status) && (run.createdAt ?? 0) >= first)
      ? true : retryPending(task) ? null : false;
  return { clicks: task.retryClicks.length, accepted: accepted.length, worked };
}

function namedReason(task: GradeTaskInput, person: PersonReason | null): string | null {
  if (person) return person;
  const interruption = task.interruption;
  if (interruption?.userAction) return `user action ${interruption.userAction}`;
  if (interruption?.responsibility === "user") return `user responsibility, ${interruption.state}`;
  if (interruption) return `interruption ${interruption.state}`;
  if (task.executionBlocker) return "execution blocker";
  if (task.activeRecoveryOwner) return `${task.activeRecoveryOwner} recovery action`;
  return null;
}

export function gradeReleaseSwapTask(task: GradeTaskInput): TaskGrade {
  const failedRuns = task.runs.filter(run => FAILED_RUN.has(run.status)).map(run => run.runId);
  const person = personReason(task);
  const base = { issueId: task.issueId, identifier: task.identifier, title: task.title, status: task.status, failedRuns,
    retry: retryOutcome(task), personReason: person, reason: namedReason(task, person) };
  const label = (value: TaskVerdict): FailureLabel | null => value === "needed_retry" ? "needed Retry"
    : value === "open_no_owner" || value === "cancelled" ? "nothing pending" : value === "blocked_non_person" ? "blocked for a non-person reason" : null;
  const staleIds = new Set(staleRuns(task).map(run => run.runId));
  const liveActivity = task.runs.filter(run => LIVE_RUN.has(run.status) && !staleIds.has(run.runId)).map(run => run.lastActivityAt ?? run.createdAt ?? null).filter((at): at is number => at !== null);
  const lastActivityAgeMs = task.now !== undefined && liveActivity.length ? task.now - Math.max(...liveActivity) : null;
  const verdict = (value: TaskVerdict, detail: string): TaskGrade => ({ ...base, verdict: value, detail, label: label(value), lastActivityAgeMs });
  const stale = staleRuns(task);
  const idle = task.now === undefined ? [] : [
    ...stale.map(run => `run ${run.runId} ${run.status} with no activity for ${Math.round((task.now! - (run.lastActivityAt ?? run.createdAt ?? 0)) / 60_000)} min`),
    ...(task.queuedWakes ? [`${task.queuedWakes} queued wake(s) never dispatched`] : []), ...(task.scheduledRetry ? ["a scheduled retry that never ran"] : []),
    ...(task.interruption && (task.interruption.state === "working" || task.interruption.state === "retry_scheduled" || task.interruption.retryWait)
      ? [`the board shows ${task.interruption.retryWait ? "a Retry waiting on the system" : task.interruption.state}`] : []),
    ...(task.activeRecoveryOwner && task.activeRecoveryOwner !== "board" ? [`a ${task.activeRecoveryOwner} recovery action that made no progress`] : [])];
  const staleNote = idle.length ? `; ${idle.join(", ")}` : "";
  if (task.retryClicks.length) {
    const retry = base.retry!;
    return verdict("needed_retry", `${retry.clicks} Retry click(s), ${retry.accepted} accepted; ${retry.worked === null ? "still running" : retry.worked ? "worked" : "did not work"}; now ${task.status}`);
  }
  if (task.status === "done") return verdict("pass", failedRuns.length ? `done after ${failedRuns.length} failed run(s) recovered without a person` : "done");
  if (task.status === "cancelled") return verdict("cancelled", "cancelled with no person asking");
  const owner = liveOwner(task);
  if (owner) return verdict("still_working", `${task.status}: ${owner}${lastActivityAgeMs !== null ? `, last activity ${Math.round(lastActivityAgeMs / 1000)} s ago` : ""}`);
  if (base.personReason) return verdict("waiting_on_person", `${task.status}: waits on ${base.personReason}`);
  const interruption = task.interruption;
  if (task.status === "blocked" || task.executionBlocker || task.activeRecoveryOwner === "board"
    || (interruption && (interruption.state === "failed" || interruption.state === "waiting_for_user"))) {
    const why = base.reason ?? "blocked with no named reason";
    const note = interruption?.responsibility === "user" ? " (the board asks a person, but this is not one of the grade's person reasons)" : "";
    return verdict("blocked_non_person", `${task.status}: ${why}${note}${staleNote}`);
  }
  return verdict("open_no_owner", `${task.status} with no live run, no queued wake and no named reason${staleNote}`);
}

export interface SwapWindow {
  index: number;
  requestedAt: number;
  spawnedAt: number | null;
  stopRequestedAt: number | null;
  stoppedAt: number | null;
  fromPid: number | null;
}

export interface SwapRunFact {
  runId: string;
  issueId: string | null;
  status: string;
  errorCode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  ownerPidBeforeEnd: number | null;
}

export const LOST_RUN_CODES: ReadonlySet<string> = new Set(["process_lost", "native_execution_ownership_unverified", "controller_lease_lost",
  "runner_remote_process_identity_unavailable", "native_continuation_requires_reconciliation", "native_session_interrupted"]);

export interface SwapMetrics {
  index: number;
  failedRuns: string[];
  lostWhileOldAlive: string[];
  survivors: Array<{ runId: string; nextEventAfterMs: number | null }>;
  nextEventP50Ms: number | null;
  nextEventMaxMs: number | null;
  survivorsWithoutEvent: number;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

export const RELEASE_FAILURE_WINDOW_MS = 15 * 60_000;

export function failedAtSwap(swap: SwapWindow, run: SwapRunFact, windowMs = RELEASE_FAILURE_WINDOW_MS): boolean {
  if (!FAILED_RUN.has(run.status) || run.finishedAt === null) return false;
  const stop = swap.stopRequestedAt ?? swap.stoppedAt ?? swap.spawnedAt ?? swap.requestedAt;
  const liveAtStop = run.startedAt !== null && run.startedAt <= stop && run.finishedAt >= stop;
  return liveAtStop || (run.finishedAt >= swap.requestedAt && run.finishedAt <= stop + windowMs);
}

export function swapForFailedRun(swaps: readonly SwapWindow[], run: SwapRunFact, windowMs = RELEASE_FAILURE_WINDOW_MS): number | null {
  const matching = swaps.filter(swap => failedAtSwap(swap, run, windowMs));
  return matching.length ? matching[matching.length - 1]!.index : null;
}

export function failedOutsideSwaps(swaps: readonly SwapWindow[], runs: readonly SwapRunFact[], windowMs = RELEASE_FAILURE_WINDOW_MS): string[] {
  return runs.filter(run => FAILED_RUN.has(run.status) && run.finishedAt !== null && swapForFailedRun(swaps, run, windowMs) === null).map(run => run.runId);
}

export const QUIET_PERIOD_MS = 90_000;

export interface DrainRun { status: string; createdAt: number | null; finishedAt: number | null; lastActivityAt: number | null }

export function drainState(runs: readonly DrainRun[], now: number, windowMs: number, quietMs = QUIET_PERIOD_MS): { progressing: number; lastChangeAt: number | null; quiet: boolean } {
  const progressing = runs.filter(run => LIVE_RUN.has(run.status) && (run.lastActivityAt ?? 0) >= now - windowMs).length;
  const changes = runs.flatMap(run => [run.createdAt, run.finishedAt]).filter((at): at is number => at !== null);
  const lastChangeAt = changes.length ? Math.max(...changes) : null;
  return { progressing, lastChangeAt, quiet: progressing === 0 && (lastChangeAt === null || now - lastChangeAt >= quietMs) };
}

export const AUTO_NOTICE = /^Prepared .+ for this response\.$/;
export const isAutoNotice = (body: string) => AUTO_NOTICE.test(body.trim());

export function swapMetrics(swaps: readonly SwapWindow[], runs: readonly SwapRunFact[], firstEventAfterStop: ReadonlyMap<string, number>, waveEnd: number,
  failureWindowMs = RELEASE_FAILURE_WINDOW_MS): SwapMetrics[] {
  return swaps.map(swap => {
    const failedRuns = runs.filter(run => swapForFailedRun(swaps, run, failureWindowMs) === swap.index).map(run => run.runId);
    const aliveUntil = swap.stopRequestedAt ?? swap.stoppedAt;
    const lostWhileOldAlive = runs.filter(run => run.errorCode !== null && LOST_RUN_CODES.has(run.errorCode) && run.finishedAt !== null
      && swap.fromPid !== null && run.ownerPidBeforeEnd === swap.fromPid && aliveUntil !== null
      && run.finishedAt >= (swap.spawnedAt ?? swap.requestedAt) && run.finishedAt < aliveUntil).map(run => run.runId);
    const stop = swap.stopRequestedAt;
    const survivors = stop === null ? [] : runs.filter(run => run.startedAt !== null && run.startedAt < stop
      && (run.finishedAt === null || run.finishedAt > stop) && !FAILED_RUN.has(run.status) && run.status !== "cancelled")
      .map(run => {
        const at = firstEventAfterStop.get(`${swap.index}:${run.runId}`);
        return { runId: run.runId, nextEventAfterMs: at === undefined ? null : at - stop };
      });
    const delays = survivors.flatMap(survivor => survivor.nextEventAfterMs === null ? [] : [survivor.nextEventAfterMs]);
    return { index: swap.index, failedRuns, lostWhileOldAlive, survivors, nextEventP50Ms: percentile(delays, 0.5),
      nextEventMaxMs: delays.length ? Math.max(...delays) : null, survivorsWithoutEvent: survivors.length - delays.length };
  });
}

export interface DuplicateFacts {
  overlappingRuns: Array<{ issueId: string; runIds: [string, string] }>;
  doubleExecutors: string[];
  duplicateComments: Array<{ issueId: string; count: number }>;
  duplicateChildren: Array<{ parentId: string; title: string; count: number }>;
  autoNoticeRepeats?: Array<{ issueId: string; count: number }>;
}

export function overlappingRuns(runs: ReadonlyArray<SwapRunFact>, waveEnd: number): DuplicateFacts["overlappingRuns"] {
  const byIssue = new Map<string, SwapRunFact[]>();
  for (const run of runs) {
    if (!run.issueId || run.startedAt === null) continue;
    byIssue.set(run.issueId, [...(byIssue.get(run.issueId) ?? []), run]);
  }
  const found: DuplicateFacts["overlappingRuns"] = [];
  for (const [issueId, list] of byIssue) {
    const sorted = [...list].sort((left, right) => left.startedAt! - right.startedAt!);
    const open: SwapRunFact[] = [];
    for (const next of sorted) {
      const still = open.filter(earlier => next.startedAt! < (earlier.finishedAt ?? waveEnd));
      for (const earlier of still) found.push({ issueId, runIds: [earlier.runId, next.runId] });
      open.splice(0, open.length, ...still, next);
    }
  }
  return found;
}

export interface ReleaseSwapResult {
  headline: string;
  completedWithoutHuman: number;
  started: number;
  byVerdict: Record<TaskVerdict, number>;
  byReason: Record<string, number>;
  byLabel: Record<string, number>;
  uncollected: number;
  stillRunning: number;
  drainReason: "quiet" | "cap" | "cancelled" | null;
  retry: { tasks: number; worked: number; didNotWork: number; pending: number };
}

export function retryLabel(grade: TaskGrade): string | null {
  if (!grade.label) return null;
  if (grade.label !== "needed Retry") return grade.label;
  const worked = grade.retry?.worked;
  return `needed Retry (${worked === true ? "click worked" : worked === false ? "click did not work" : "click result pending"})`;
}

export function summarizeGrades(grades: readonly TaskGrade[], uncollected = 0, drainReason: "quiet" | "cap" | "cancelled" | null = null): ReleaseSwapResult {
  const byVerdict = { pass: 0, needed_retry: 0, open_no_owner: 0, blocked_non_person: 0, waiting_on_person: 0, still_working: 0, cancelled: 0 } as Record<TaskVerdict, number>;
  for (const grade of grades) byVerdict[grade.verdict] += 1;
  const byReason: Record<string, number> = {};
  for (const grade of grades) if (grade.verdict !== "pass") {
    const key = `${grade.verdict}: ${grade.reason ?? "none"}`;
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  const byLabel: Record<string, number> = {};
  for (const grade of grades) {
    const key = retryLabel(grade);
    if (key) byLabel[key] = (byLabel[key] ?? 0) + 1;
  }
  const retried = grades.filter(grade => grade.retry);
  const completedWithoutHuman = byVerdict.pass;
  const started = grades.length - byVerdict.still_working;
  const running = grades.filter(grade => grade.verdict === "still_working");
  const ages = running.flatMap(grade => grade.lastActivityAgeMs === null ? [] : [`${Math.round(grade.lastActivityAgeMs / 1000)} s`]).join(", ");
  const when = drainReason === "cap" ? "at the drain cap" : drainReason === "cancelled" ? "when the harness was interrupted" : "at the end-of-wave read";
  const past = running.length ? `; ${running.length} still running ${when}, not counted${ages ? ` (last activity ${ages} ago)` : ""}` : "";
  const incomplete = uncollected ? ` (incomplete: ${uncollected} task(s) could not be read and are not counted)` : "";
  return { headline: `${completedWithoutHuman} / ${started} tasks completed without human action${past}${incomplete}`, completedWithoutHuman, started,
    stillRunning: running.length, drainReason,
    byVerdict, byReason, byLabel, uncollected, retry: { tasks: retried.length, worked: retried.filter(grade => grade.retry!.worked === true).length,
      didNotWork: retried.filter(grade => grade.retry!.worked === false).length, pending: retried.filter(grade => grade.retry!.worked === null).length } };
}

export function releaseSwapMarkdown(result: ReleaseSwapResult, metrics: readonly SwapMetrics[], evidence: ReadonlyArray<{ index: number; lateOk: boolean; prepOk: boolean; findings: string[] } | null>,
  duplicates: DuplicateFacts, grades: readonly TaskGrade[], failedOutside: readonly string[] = []): string {
  const seconds = (ms: number | null) => ms === null ? "–" : `${Math.round(ms / 1000)} s`;
  const lines = [
    result.headline,
    "",
    `Verdicts: ${Object.entries(result.byVerdict).filter(([, count]) => count).map(([verdict, count]) => `${verdict} ${count}`).join(", ") || "none"}.`,
    `Failing: ${Object.entries(result.byLabel).map(([label, count]) => `${label} ${count}`).join("; ") || "none"}.`,
    `Reasons: ${Object.entries(result.byReason).map(([reason, count]) => `${reason} ${count}`).join("; ") || "none"}.`,
    `Retry: ${result.retry.tasks} task(s) needed it; worked ${result.retry.worked}, did not work ${result.retry.didNotWork}, still running ${result.retry.pending}.`,
    `Duplicates: ${duplicates.overlappingRuns.length} overlapping run pair(s), ${duplicates.doubleExecutors.length} double executor(s), `
      + `${duplicates.duplicateComments.length} duplicated agent comment(s), ${duplicates.duplicateChildren.length} duplicated subtask title(s)`
      + `${duplicates.autoNoticeRepeats ? `; informational: ${duplicates.autoNoticeRepeats.length} task(s) repeat the "Prepared ... for this response." notice` : ""}.`,
    `Failed outside a release window (more than ${RELEASE_FAILURE_WINDOW_MS / 60_000} min after a stop and not live at it): ${failedOutside.length ? failedOutside.join(", ") : "none"}.`,
    "",
    "| Swap | Failed runs | Lost while old alive | Survivors | Next event p50 | Next event max | No event | Late start on old | Prep during recovery |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...metrics.map((metric, position) => {
      const swap = evidence[position];
      return `| ${metric.index} | ${metric.failedRuns.length} | ${metric.lostWhileOldAlive.length} | ${metric.survivors.length} | ${seconds(metric.nextEventP50Ms)} | `
        + `${seconds(metric.nextEventMaxMs)} | ${metric.survivorsWithoutEvent} | ${swap ? (swap.lateOk ? "yes" : "no") : "–"} | ${swap ? (swap.prepOk ? "yes" : "no") : "–"} |`;
    }),
    "",
    ...evidence.flatMap(swap => swap?.findings.map(finding => `- Swap ${swap.index}: ${finding}`) ?? []),
    ...grades.filter(grade => grade.verdict !== "pass").map(grade => `- ${grade.identifier ?? grade.issueId} ${retryLabel(grade) ?? grade.verdict}: ${grade.detail}`),
  ];
  return `${lines.join("\n")}\n`;
}
