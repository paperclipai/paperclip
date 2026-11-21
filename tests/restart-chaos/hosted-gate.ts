import { agentSlotsFromRows, queueWaitFairnessFrom } from "./agent-slots.js";
import { gradeR1 } from "./grader.js";
import type { ContinuityReport, DetectedRelease } from "./hosted-release.js";
import type { HostedRunRow } from "./hosted-readers.js";
import type { HostedTaskRecord } from "./hosted-workload.js";
import type { RetryClick, SwapMetrics } from "./release-swap-grade.js";
import { stagingMixBudgetMs, SUBTASK_ROUNDS } from "./staging-mix.js";
import type { FaultReceipt, RuleResult, RunSample, TaskRecord } from "./types.js";

type Json = Record<string, any>;

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

/**
 * The local waves' R1 for one hosted task: done within the staging-mix budget plus outage time, plus the first run's
 * queue wait when the agent's slots prove it fair. The API has no wake evidence, so a follow-up run's wait is never
 * credited (the local grader refuses it the same way).
 */
export function hostedR1(input: { record: HostedTaskRecord; view: Json | undefined; runs: readonly HostedRunRow[]; agents: readonly Json[];
  companyRuns: readonly HostedRunRow[]; outages: readonly FaultReceipt[] }): RuleResult {
  const { record, view } = input;
  const completedAt = Date.parse(String(view?.completedAt ?? ""));
  const status = String(view?.status ?? record.status);
  const restAt = status === "done" ? (Number.isFinite(completedAt) ? completedAt : record.doneAt) : null;
  const task: TaskRecord = {
    plan: { workload: "SM", nonce: record.plan.nonce }, issueId: record.issueId, identifier: record.identifier, createdAt: record.createdAt,
    launchError: record.createError, samples: [{ at: restAt ?? Date.now(), reachable: true, serverReady: true, runs: input.runs.map(runSample) }],
    retry: record.retryClicks.length ? { at: record.retryClicks[0]!.at } : null, restAt, finalStatus: status, deadlineAt: null, timedOut: false,
    followUp: record.followUp ? { at: record.followUp.at, commentId: record.followUp.commentId, error: record.followUp.error } : null,
    faultIds: [], sweep: null, preFaultFiles: null, lostFiles: null,
  } as unknown as TaskRecord;
  const slots = agentSlotsFromRows(input.agents.map(agent => ({ id: agent.id, maxConcurrentRuns: agent.runtimeConfig?.heartbeat?.maxConcurrentRuns })),
    input.companyRuns.map(run => ({ id: run.runId, agentId: run.agentId, createdAt: run.createdAt, invocationSource: run.invocationSource,
      retryOfRunId: run.retryOfRunId, startedAt: run.startedAt, finishedAt: run.finishedAt })));
  return gradeR1(task, stagingMixBudgetMs(record.plan.task), input.outages, queueWaitFairnessFrom(slots));
}

/** An agent-created subtask graded on its own: created when the issue was, with the budget of its two rounds. */
export function subtaskRecord(view: Json, retryClicks: readonly RetryClick[]): HostedTaskRecord {
  const created = Date.parse(String(view.createdAt ?? ""));
  return { plan: { index: -1, adapter: "opencode", nonce: String(view.id), task: { turnMinutes: 0, rounds: SUBTASK_ROUNDS, subtasks: 0, followUpAfterMs: null,
    arriveAtMs: 0, holdMs: 0 } }, issueId: String(view.id), identifier: view.identifier ? String(view.identifier) : null,
    createdAt: Number.isFinite(created) ? created : null, createError: Number.isFinite(created) ? null : "subtask has no createdAt",
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
export function hostedGate(input: { handsOffPass: boolean; wantedReleases: number; createErrors: number; r1: ReadonlyArray<{ identifier: string | null; result: RuleResult }>; bannersShown: number;
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
