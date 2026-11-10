/**
 * Universal checks U1–U4: scenario-independent rules graded on every task of
 * every wave, whatever its workload. Pure functions over observer samples (no
 * I/O), so they also run over saved evidence (`universal-audit.ts`).
 *
 *   U1 liveness        every non-terminal task has a live owner or a visible, actionable item
 *   U2 retry loop      the same failure does not repeat without the task changing state
 *   U3 diagnosable     every failed run names a specific cause
 *   U4 stale notices   no failure or Retry notice outlives later successful work
 *
 * Each rule is either `enforced` (a violation fails the task) or a warning
 * (reported in the grade and ledger, never fails the task). The split comes
 * from the false-positive audit over saved waves; see README "Universal checks".
 */
import type { RunSample, TaskRecord, TaskSample } from "./types.js";

export type UniversalId = "U1" | "U2" | "U3" | "U4";
export interface UniversalResult { verdict: "pass" | "fail" | "n/a"; detail: string; enforced: boolean;
  /** Measurements behind the verdict (milliseconds or counts), for bound tuning. */
  metrics?: Record<string, number> }
export type UniversalGrade = Record<UniversalId, UniversalResult>;

export interface UniversalBounds {
  /** U1: longest ready-server time a non-terminal task may spend with no live owner and no actionable item. */
  orphanMs: number;
  /** U1: longest ready-server time a run may stay queued without starting. */
  queuedMs: number;
  /** U1: a `running` run with no event, activity or start evidence for this long is not a live owner. */
  silentRunMs: number;
  /** U2: most consecutive failed runs with one failure code while the issue status stays the same. */
  sameFailureRuns: number;
  /** U4: longest a failure or Retry notice may remain after a later run succeeded. */
  staleNoticeMs: number;
}

/**
 * Defaults from the 2026-11-09 audit of 74 saved waves (1,592 tasks; README
 * "Universal checks"). Override with RESTART_CHAOS_U1_ORPHAN_SECONDS,
 * RESTART_CHAOS_U1_QUEUED_SECONDS, RESTART_CHAOS_U2_SAME_FAILURE_RUNS and
 * RESTART_CHAOS_U4_STALE_SECONDS.
 */
export const DEFAULT_UNIVERSAL_BOUNDS: UniversalBounds = {
  orphanMs: 3 * 60_000,
  queuedMs: 5 * 60_000,
  silentRunMs: 3 * 60_000,
  sameFailureRuns: 3,
  staleNoticeMs: 60_000,
};

/** Rules that fail a task. The rest are warnings until the audit shows no false positive on known-good waves. */
export const ENFORCED_UNIVERSAL: ReadonlySet<UniversalId> = new Set<UniversalId>(["U1", "U2", "U4"]);

export function universalBounds(env: NodeJS.ProcessEnv = process.env): UniversalBounds {
  const seconds = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return value;
  };
  return {
    orphanMs: seconds("RESTART_CHAOS_U1_ORPHAN_SECONDS", DEFAULT_UNIVERSAL_BOUNDS.orphanMs / 1000) * 1000,
    queuedMs: seconds("RESTART_CHAOS_U1_QUEUED_SECONDS", DEFAULT_UNIVERSAL_BOUNDS.queuedMs / 1000) * 1000,
    silentRunMs: DEFAULT_UNIVERSAL_BOUNDS.silentRunMs,
    sameFailureRuns: Math.round(seconds("RESTART_CHAOS_U2_SAME_FAILURE_RUNS", DEFAULT_UNIVERSAL_BOUNDS.sameFailureRuns)),
    staleNoticeMs: seconds("RESTART_CHAOS_U4_STALE_SECONDS", DEFAULT_UNIVERSAL_BOUNDS.staleNoticeMs / 1000) * 1000,
  };
}

const TERMINAL_ISSUE = new Set(["done", "cancelled"]);
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const seconds = (value: number) => `${Math.round(value / 1000)}s`;
const ready = (sample: TaskSample) => sample.reachable && sample.serverReady;

/**
 * Codes that name no cause a person can act on. `adapter_failed` is the
 * catch-all an adapter returns when it did not classify its failure; the board
 * shows it as "adapter failed".
 */
export const GENERIC_FAILURE_CODES: ReadonlySet<string> = new Set(["", "error", "unknown", "unknown_error", "failed", "adapter_failed", "internal_error"]);
const FAILED_RUN = new Set(["failed", "timed_out"]);

/** A message whose only cause is a bare exception class or "unknown" (the #20385 "last cause: Error" class). */
export function bareCauseMessage(message: string | null | undefined): boolean {
  const text = (message ?? "").trim();
  if (!text) return true;
  if (/^(error|unknown|unknown_error|internal error)\.?$/i.test(text)) return true;
  return /\b(?:last cause|cause|reason)\s*[:=]\s*\(?\s*(?:Error|unknown_error|unknown|undefined|null)\s*\)?(?:\s|[;,.)]|$)/.test(text)
    || /^Error at source seq \d+$/.test(text) || /:\s*Error at source seq \d+/.test(text);
}

/** Latest view of each run across the samples. */
function finalRuns(record: TaskRecord): Map<string, RunSample & { firstSeenAt: number; finishedSeenAt: number | null; statusWhenFinished: string | null }> {
  const runs = new Map<string, RunSample & { firstSeenAt: number; finishedSeenAt: number | null; statusWhenFinished: string | null }>();
  for (const sample of record.samples) {
    if (!sample.reachable) continue;
    for (const run of sample.runs ?? []) {
      const prior = runs.get(run.id);
      const finished = !["queued", "running", "scheduled_retry"].includes(run.status);
      runs.set(run.id, { ...run, firstSeenAt: prior?.firstSeenAt ?? sample.at,
        finishedSeenAt: prior?.finishedSeenAt ?? (finished ? sample.at : null),
        statusWhenFinished: prior?.statusWhenFinished ?? (finished ? sample.issueStatus ?? null : null) });
    }
  }
  return runs;
}

/** U1: what keeps this task moving at this sample, or null when nothing does. */
export function liveOwner(sample: TaskSample, queuedFor: ReadonlyMap<string, number>, bounds: UniversalBounds): string | null {
  for (const run of sample.runs ?? []) {
    if (run.status === "running") {
      if (run.toolInFlight || run.processAlive) return `run ${run.id} running (tool or process alive)`;
      const evidence = Math.max(ms(run.lastEvidenceAt) || 0, ms(run.startedAt) || 0);
      if (!evidence || sample.at - evidence <= bounds.silentRunMs) return `run ${run.id} running`;
    }
    if (run.status === "queued" || run.status === "scheduled_retry") {
      if ((queuedFor.get(run.id) ?? 0) <= bounds.queuedMs) return `run ${run.id} ${run.status}`;
    }
  }
  // A retry row stays on the issue after its run is dispatched; once a run exists the run's own bounds above decide.
  const dispatched = (sample.runs ?? []).some(run => ["queued", "running", "scheduled_retry"].includes(run.status));
  if (!dispatched && (sample.scheduledRetry || sample.interruption?.retryWait || sample.interruption?.state === "retry_scheduled")) return "retry timer";
  if (sample.activeRecoveryAction && sample.recoveryOwner !== "board") return "system recovery action";
  return null;
}

/** U1: an item a person can see and act on (Retry, a question, an approval, a board-owned recovery, a named blocker). */
export function actionableItem(sample: TaskSample): string | null {
  const interruption = sample.interruption;
  if (interruption?.canRetry) return "Retry";
  if (interruption?.userAction) return `user action ${interruption.userAction}`;
  if (interruption && (interruption.state === "waiting_for_user" || interruption.state === "failed")) return `interruption ${interruption.state}`;
  if (sample.activeRecoveryAction && sample.recoveryOwner === "board") return "board recovery action";
  if (sample.executionBlocker) return "execution blocker";
  // Blocked and in-review issues wait on another issue, an approval or a person by definition.
  if (sample.issueStatus === "blocked" || sample.issueStatus === "in_review") return `status ${sample.issueStatus}`;
  return null;
}

export function gradeU1(record: TaskRecord, bounds: UniversalBounds): Omit<UniversalResult, "enforced"> {
  if (!record.samples.some(ready)) return { verdict: "n/a", detail: "no ready sample" };
  // Ready-server time each run has spent queued (outages do not count).
  const queuedFor = new Map<string, number>();
  let orphanMs = 0, worstOrphan = 0, orphanFrom: number | null = null, lastAt: number | null = null;
  let worstQueued = 0, worstQueuedRun = "";
  for (const sample of record.samples) {
    // Outages pause the clock: a down server is the fault's time, not the task's.
    if (!ready(sample)) { lastAt = null; continue; }
    for (const run of sample.runs ?? []) {
      if (run.status === "queued" || run.status === "scheduled_retry") {
        const waited = (queuedFor.get(run.id) ?? 0) + (lastAt !== null && queuedFor.has(run.id) ? sample.at - lastAt : 0);
        queuedFor.set(run.id, waited);
        if (waited > worstQueued) { worstQueued = waited; worstQueuedRun = run.id; }
      }
    }
    if (TERMINAL_ISSUE.has(sample.issueStatus ?? "")) { orphanMs = 0; orphanFrom = null; lastAt = sample.at; continue; }
    const owned = liveOwner(sample, queuedFor, bounds) ?? actionableItem(sample);
    if (owned) { orphanMs = 0; orphanFrom = null; }
    else {
      if (orphanFrom === null) orphanFrom = sample.at;
      else if (lastAt !== null) orphanMs += sample.at - lastAt;
      worstOrphan = Math.max(worstOrphan, orphanMs);
      if (orphanMs > bounds.orphanMs) {
        const queued = (sample.runs ?? []).filter(run => run.status === "queued" || run.status === "scheduled_retry");
        return { verdict: "fail", metrics: { ownerlessMs: orphanMs, queuedMs: worstQueued }, detail: `no_owner_no_action ${seconds(orphanMs)} in ${sample.issueStatus ?? "unknown"}`
          + (queued.length ? ` with ${queued.map(run => `${run.id} queued ${seconds(queuedFor.get(run.id) ?? 0)}`).join(",")}` : "")
          + ` (interruption ${sample.interruption?.state ?? "none"})` };
      }
    }
    lastAt = sample.at;
  }
  return { verdict: "pass", metrics: { ownerlessMs: worstOrphan, queuedMs: worstQueued }, detail: `longest ownerless ${seconds(worstOrphan)}; longest queued ${seconds(worstQueued)}${worstQueuedRun ? ` (${worstQueuedRun})` : ""}` };
}

/** The issue status seen between two failures (both finish polls included) was not one value throughout. */
function issueStatusChanged(record: TaskRecord, before: { finishedSeenAt: number | null; statusWhenFinished: string | null },
  after: { finishedSeenAt: number | null; statusWhenFinished: string | null }): boolean {
  if (before.statusWhenFinished !== after.statusWhenFinished) return true;
  const [from, to] = [before.finishedSeenAt ?? 0, after.finishedSeenAt ?? Number.POSITIVE_INFINITY];
  return record.samples.some(sample => sample.reachable && sample.at >= from && sample.at <= to && sample.issueStatus !== before.statusWhenFinished);
}

export function gradeU2(record: TaskRecord, bounds: UniversalBounds): Omit<UniversalResult, "enforced"> {
  // Every finished run in creation order: a succeeded run between two failures is progress and ends the streak.
  const finished = [...finalRuns(record).values()].filter(run => run.finishedSeenAt !== null)
    .sort((a, b) => (ms(a.createdAt) || a.firstSeenAt) - (ms(b.createdAt) || b.firstSeenAt));
  const isFailure = (run: RunSample) => FAILED_RUN.has(run.status) || run.status === "interrupted";
  if (!finished.some(isFailure)) return { verdict: "n/a", detail: "no failed run" };
  let streak = 0, worst = 0, worstCode = "";
  let previous: (typeof finished)[number] | null = null;
  for (const current of finished) {
    if (!isFailure(current)) {
      // A cancellation (for example a superseded continuation) is neither progress nor a repeat.
      if (current.status !== "cancelled") { streak = 0; previous = null; }
      continue;
    }
    const same = previous !== null && `${previous.status}:${previous.errorCode}` === `${current.status}:${current.errorCode}`
      && !issueStatusChanged(record, previous, current);
    streak = same ? streak + 1 : 1;
    previous = current;
    if (streak > worst) { worst = streak; worstCode = `${current.status}:${current.errorCode ?? "none"}`; }
  }
  return worst > bounds.sameFailureRuns
    ? { verdict: "fail", metrics: { sameFailureRuns: worst }, detail: `same_failure_repeated ${worst}x ${worstCode} without a task state change` }
    : { verdict: "pass", metrics: { sameFailureRuns: worst }, detail: `most repeats of one failure ${worst} (${worstCode})` };
}

/** What the wave database adds for U3: each run's error text and the task's recovery actions. */
export interface UniversalDbEvidence {
  runMessages: ReadonlyMap<string, string | null>;
  recoveryActions: ReadonlyArray<{ id: string; kind: string; cause: string | null; nextAction: string | null }>;
}

/** U3: failure codes from the samples; with database evidence, also run error text and recovery-action causes. */
export function gradeU3(record: TaskRecord, db?: UniversalDbEvidence): Omit<UniversalResult, "enforced"> {
  const failed = [...finalRuns(record).values()].filter(run => FAILED_RUN.has(run.status));
  const actions = db?.recoveryActions ?? [];
  if (!failed.length && !actions.length) return { verdict: "n/a", detail: "no failed run or recovery action" };
  const messages = db?.runMessages;
  const vague: string[] = [];
  for (const action of actions) {
    if (bareCauseMessage(action.cause) || bareCauseMessage(action.nextAction)) {
      vague.push(`recovery ${action.id}(${action.kind}) cause=${JSON.stringify((action.cause ?? "").slice(0, 80))} next=${JSON.stringify((action.nextAction ?? "").slice(0, 80))}`);
    }
  }
  for (const run of failed) {
    const code = run.errorCode ?? "";
    if (GENERIC_FAILURE_CODES.has(code.trim().toLowerCase())) vague.push(`${run.id}:code=${code || "none"}`);
    else if (messages?.has(run.id) && bareCauseMessage(messages.get(run.id))) {
      vague.push(`${run.id}:${code} message=${JSON.stringify((messages.get(run.id) ?? "").slice(0, 120))}`);
    }
  }
  return vague.length
    ? { verdict: "fail", detail: `undiagnosable_failure ${vague.slice(0, 4).join("; ")}${vague.length > 4 ? ` (+${vague.length - 4})` : ""}` }
    : { verdict: "pass", detail: `${failed.length} failed run(s) name a specific cause${messages ? " and message" : ""}; ${actions.length} recovery action(s)` };
}

/** A failure or Retry notice the board shows for this sample. */
function failureNotice(sample: TaskSample): string | null {
  const interruption = sample.interruption;
  if (!interruption) return null;
  if (interruption.canRetry) return "Retry offered";
  if (interruption.state === "failed") return "failed notice";
  return null;
}

export function gradeU4(record: TaskRecord, bounds: UniversalBounds): Omit<UniversalResult, "enforced"> {
  let staleFrom: number | null = null, worst = 0, what = "";
  const latestFinish = new Map<string, RunSample>();
  for (const sample of record.samples) {
    if (!ready(sample)) continue;
    for (const run of sample.runs ?? []) latestFinish.set(run.id, run);
    const runs = [...latestFinish.values()].sort((a, b) => (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0));
    const latest = runs[runs.length - 1];
    const active = runs.some(run => ["queued", "running", "scheduled_retry"].includes(run.status));
    const succeededLast = latest?.status === "succeeded" && !active;
    const notice = succeededLast ? failureNotice(sample) : null;
    if (!notice) { staleFrom = null; continue; }
    staleFrom ??= sample.at;
    if (sample.at - staleFrom > worst) { worst = sample.at - staleFrom; what = `${notice} after ${latest!.id} succeeded (status ${sample.issueStatus ?? "unknown"})`; }
  }
  // A notice still shown at rest is stale however briefly it was observed.
  const last = [...record.samples].reverse().find(ready);
  const atRest = record.restAt !== null && staleFrom !== null && last !== undefined && failureNotice(last) !== null;
  if (worst > bounds.staleNoticeMs || atRest) return { verdict: "fail", metrics: { staleNoticeMs: worst }, detail: `stale_notice ${what} for ${seconds(worst)}${atRest ? ", still shown at rest" : ""}` };
  return { verdict: "pass", metrics: { staleNoticeMs: worst }, detail: worst ? `notice cleared ${seconds(worst)} after success` : "no notice after success" };
}

export function gradeUniversal(record: TaskRecord, options: { bounds?: UniversalBounds; db?: UniversalDbEvidence;
  enforced?: ReadonlySet<UniversalId> } = {}): UniversalGrade {
  const bounds = options.bounds ?? universalBounds();
  const enforced = options.enforced ?? ENFORCED_UNIVERSAL;
  const results = {
    U1: gradeU1(record, bounds),
    U2: gradeU2(record, bounds),
    U3: gradeU3(record, options.db),
    U4: gradeU4(record, bounds),
  };
  return Object.fromEntries(Object.entries(results).map(([id, result]) => [id, { ...result, enforced: enforced.has(id as UniversalId) }])) as UniversalGrade;
}

/** Violations that fail the task (enforced rules only). */
export const enforcedUniversalFailures = (grade: UniversalGrade) =>
  (Object.entries(grade) as Array<[UniversalId, UniversalResult]>).filter(([, result]) => result.enforced && result.verdict === "fail");
/** Violations reported as warnings. */
export const universalWarnings = (grade: UniversalGrade) =>
  (Object.entries(grade) as Array<[UniversalId, UniversalResult]>).filter(([, result]) => !result.enforced && result.verdict === "fail");
