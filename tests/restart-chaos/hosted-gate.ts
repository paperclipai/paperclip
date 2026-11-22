import { agentSlotsFromRows, queueWaitFairnessFrom, type QueueWaitFairness } from "./agent-slots.js";
import { gradeR1 } from "./grader.js";
import type { ContinuityReport, DetectedRelease } from "./hosted-release.js";
import { ms, type HostedRunRow } from "./hosted-readers.js";
import type { HostedTaskRecord } from "./hosted-workload.js";
import type { RetryClick, SwapMetrics } from "./release-swap-grade.js";
import { stagingMixBudgetMs, SUBTASK_ROUNDS } from "./staging-mix.js";
import type { FaultReceipt, RuleResult, RunSample, TaskRecord } from "./types.js";

const iso = (at: number | null) => at === null ? null : new Date(at).toISOString();

/**
 * Only a release whose health probes failed had an outage. A release that two builds served without a failed probe
 * gives R1 no outage credit, so a slow task after a clean swap still fails R1.
 */
export function releaseOutages(releases: readonly DetectedRelease[]): FaultReceipt[] {
  return releases.filter(release => release.firstFailureAt !== null && release.firstFailureAt < release.firstNewAt).map((release): FaultReceipt => ({
    faultId: `release-${release.index}`, kind: "K15", requestedBy: "hosted-release", signal: "none", holdMs: 0,
    requestedAt: release.firstFailureAt!, startedAt: release.firstFailureAt!, stoppedAt: null, restartedAt: null,
    healthyAt: release.firstNewAt, readyAt: release.firstNewAt, phases: [], serverLogOffsetAtStart: 0, serverLogOffsetAtReady: null, error: null,
  }));
}

function runSample(run: HostedRunRow): RunSample {
  return { id: run.runId, status: run.status, createdAt: iso(run.createdAt), startedAt: iso(run.startedAt), finishedAt: iso(run.finishedAt),
    errorCode: run.errorCode, retryOfRunId: run.retryOfRunId, wakeCommentIds: run.wakeCommentIds, livenessState: null };
}

/** The task view fields R1 reads. */
export interface HostedIssueView { status?: string | null; completedAt?: string | number | null }
/** The agent fields the queue-wait proof reads. */
export interface HostedAgentRow { id: string; runtimeConfig?: { heartbeat?: { maxConcurrentRuns?: unknown } } | null }

/** The fields of `TaskRecord` that `gradeR1` reads, so the hosted adapter's boundary is checked by the compiler. */
type R1Subject = Pick<TaskRecord, "issueId" | "identifier" | "createdAt" | "launchError" | "samples" | "restAt" | "finalStatus" | "timedOut" | "followUp">
  & { plan: Pick<TaskRecord["plan"], "workload" | "nonce">; retry: { at: number } | null };

/**
 * The queue-wait proof for every run of the company, built once per grade. `missing` names the run's agents whose
 * `maxConcurrentRuns` could not be read (an unreadable agent list or a restricted agent view), so no wait of theirs can
 * be proven fair; the gate fails on it instead of grading R1 without the evidence.
 */
export function hostedQueueWait(agentIds: readonly string[], agents: readonly HostedAgentRow[], companyRuns: readonly HostedRunRow[]):
  { queueWait: QueueWaitFairness; missing: string[] } {
  const slots = agentSlotsFromRows(agents.map(agent => ({ id: agent.id, maxConcurrentRuns: agent.runtimeConfig?.heartbeat?.maxConcurrentRuns })),
    companyRuns.map(run => ({ id: run.runId, agentId: run.agentId, createdAt: run.createdAt, invocationSource: run.invocationSource,
      retryOfRunId: run.retryOfRunId, startedAt: run.startedAt, finishedAt: run.finishedAt })));
  const capped = new Set(slots.agents.filter(agent => agent.maxConcurrentRuns !== null).map(agent => agent.agentId));
  return { queueWait: queueWaitFairnessFrom(slots), missing: agentIds.filter(id => !capped.has(id)) };
}

/**
 * The local waves' R1 for one hosted task: done within the staging-mix budget plus outage time, plus the first run's
 * queue wait when the agent's slots prove it fair. The API has no wake evidence, so a follow-up run's wait is never
 * credited (the local grader refuses it the same way).
 */
export function hostedR1(input: { record: HostedTaskRecord; view: HostedIssueView | undefined; runs: readonly HostedRunRow[];
  queueWait: QueueWaitFairness; outages: readonly FaultReceipt[] }): RuleResult {
  const { record, view } = input;
  const completedAt = ms(view?.completedAt);
  const status = String(view?.status ?? record.status);
  const restAt = status === "done" ? (completedAt ?? record.doneAt) : null;
  const subject: R1Subject = {
    plan: { workload: "SM", nonce: record.plan.nonce }, issueId: record.issueId, identifier: record.identifier, createdAt: record.createdAt,
    launchError: record.createError, samples: [{ at: restAt ?? Date.now(), reachable: true, serverReady: true, runs: input.runs.map(runSample) }],
    retry: record.retryClicks.length ? { at: record.retryClicks[0]!.at } : null, restAt, finalStatus: status, timedOut: false,
    followUp: record.followUp ? { at: record.followUp.at, commentId: record.followUp.commentId, error: record.followUp.error } : null,
  };
  // gradeR1 reads only the R1Subject fields; without runWakes it refuses a follow-up run's queue credit, as above.
  return gradeR1(subject as unknown as TaskRecord, stagingMixBudgetMs(record.plan.task), input.outages, input.queueWait);
}

/** A planned task's agent-created subtask graded on its own: created when the issue was, with the budget of its two rounds. */
export function subtaskRecord(view: { id: string; identifier?: string | null; status?: string | null; createdAt?: string | number | null }, retryClicks: readonly RetryClick[]): HostedTaskRecord {
  const created = ms(view.createdAt);
  return { plan: { index: -1, adapter: "opencode", nonce: String(view.id), task: { turnMinutes: 0, rounds: SUBTASK_ROUNDS, subtasks: 0, followUpAfterMs: null,
    arriveAtMs: 0, holdMs: 0 } }, issueId: String(view.id), identifier: view.identifier ? String(view.identifier) : null,
    createdAt: created, createError: created === null ? "subtask has no createdAt" : null,
    status: String(view.status), lastLiveAt: null, followUp: null, retryClicks: [...retryClicks], retriedRuns: [], doneAt: null };
}

export interface HostedGate {
  pass: boolean;
  r1Failed: Array<{ identifier: string | null; detail: string }>;
  bannersShown: number;
  healthFailures: number;
  duplicates: number;
  stopThenStart: number[];
  unloaded: number[];
  lines: string[];
}

/**
 * Gate D: every task hands-off and inside R1, no Retry banner, no failed health probe, no duplicated work, and every
 * release a swap two builds served (never stop-then-start) with at least one live run carried across it. A fixed batch
 * (`--hosted-releases 0`) waits for no release, so it is not required to see one.
 */
export function hostedGate(input: { handsOffPass: boolean; wantedReleases: number; createErrors: number; slotEvidenceMissing: readonly string[]; r1: ReadonlyArray<{ identifier: string | null; result: RuleResult }>; bannersShown: number;
  health: ContinuityReport; duplicates: { overlappingRuns: readonly unknown[]; duplicateComments: readonly unknown[]; duplicateChildren: readonly unknown[] };
  releases: readonly DetectedRelease[]; metrics: readonly SwapMetrics[] }): HostedGate {
  const r1Failed = input.r1.filter(entry => entry.result.verdict === "fail").map(entry => ({ identifier: entry.identifier, detail: entry.result.detail }));
  const duplicates = input.duplicates.overlappingRuns.length + input.duplicates.duplicateComments.length + input.duplicates.duplicateChildren.length;
  const stopThenStart = input.releases.filter(release => release.shape === "stop_then_start").map(release => release.index);
  const unloaded = input.metrics.filter(metric => metric.survivors.length === 0).map(metric => metric.index);
  const checks: Array<[string, boolean, string]> = [
    ["hands-off", input.handsOffPass, input.handsOffPass ? "every started task done without a person" : "a task did not finish hands-off"],
    ["R1", r1Failed.length === 0, r1Failed.length ? `${r1Failed.length} failed (${r1Failed.slice(0, 3).map(entry => `${entry.identifier ?? "?"}: ${entry.detail}`).join("; ")})`
      : `${input.r1.filter(entry => entry.result.verdict === "pass").length} passed`],
    ["agent slot evidence", input.slotEvidenceMissing.length === 0, input.slotEvidenceMissing.length
      ? `maxConcurrentRuns unreadable for ${input.slotEvidenceMissing.length} agent(s), so R1 queue credit cannot be proven` : "read for every agent"],
    ["tasks created", input.createErrors === 0, `${input.createErrors} task(s) could not be created`],
    ["Retry banners", input.bannersShown === 0, `${input.bannersShown} shown`],
    ["health probes", input.health.failures === 0, `${input.health.failures} of ${input.health.requests} failed`],
    ["duplicates", duplicates === 0, `${duplicates} (overlapping runs, duplicated agent comments, duplicated subtasks)`],
    ["swap shape", stopThenStart.length === 0, stopThenStart.length ? `stop-then-start at release ${stopThenStart.join(", ")}` : "no stop-then-start release"],
    ...(input.wantedReleases > 0 ? [["releases under load", input.releases.length > 0 && unloaded.length === 0,
      input.releases.length === 0 ? "no release detected" : unloaded.length ? `no live run across release ${unloaded.join(", ")}`
        : `${input.releases.length} release(s), each with a live run`]] as Array<[string, boolean, string]> : []),
  ];
  const pass = checks.every(([, ok]) => ok);
  return { pass, r1Failed, bannersShown: input.bannersShown, healthFailures: input.health.failures, duplicates, stopThenStart, unloaded,
    lines: [`Gate D: ${pass ? "PASS" : "FAIL"}`, ...checks.map(([name, ok, detail]) => `- ${ok ? "pass" : "FAIL"} ${name}: ${detail}`)] };
}
