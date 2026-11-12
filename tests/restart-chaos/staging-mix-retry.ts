import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChaosApi } from "./api.js";
import { bannerShownMs, noteRetryBanner } from "./staging-mix.js";
import type { InterruptionSample, TaskPlan, TaskRecord, TaskSample } from "./types.js";

type Json = Record<string, any>;

export interface IssueView { status: string; canRetry: boolean; retryWait: boolean; observedRunId: string | null; interruption: InterruptionSample | null }

export function shouldClickRetryAfterSettle(view: Pick<IssueView, "status" | "canRetry" | "retryWait">, priorClicks: number): boolean {
  return view.status !== "done" && view.canRetry && !view.retryWait && priorClicks === 0;
}

export function issueView(issue: Json | null): IssueView {
  const interruption = issue?.interruption ?? null;
  return {
    status: String(issue?.status ?? "unreadable"),
    canRetry: interruption?.canRetry === true,
    retryWait: Boolean(interruption?.retryWait),
    observedRunId: typeof interruption?.observedRunId === "string" ? interruption.observedRunId : null,
    interruption: interruption ? { state: String(interruption.state), canRetry: interruption.canRetry === true, retryWait: Boolean(interruption.retryWait),
      workspaceFailure: null, observedRunId: typeof interruption.observedRunId === "string" ? interruption.observedRunId : null,
      userAction: typeof interruption.userAction === "string" ? interruption.userAction : null } : null,
  };
}

export interface RetryStageObserver {
  plan: TaskPlan;
  record: TaskRecord;
  done: boolean;
  poll(now?: number): Promise<void>;
  retryAfterSettle(sample: TaskSample, now: number): Promise<void>;
}

export interface RetryStageInput {
  observers: readonly RetryStageObserver[];
  api: Pick<ChaosApi, "get">;
  settleUntil: number;
  settleMs: number;
  cancelled: () => boolean;
  note: (kind: string, data: Record<string, unknown>) => void;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function retryAfterSettleStage(input: RetryStageInput): Promise<{ clicked: string[] }> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (ms => delay(ms));
  const pollMs = input.pollMs ?? 60_000;
  const tracked = input.observers.filter(observer => observer.record.issueId && observer.plan.stagingMix);
  const views = new Map<RetryStageObserver, IssueView>();
  const read = async (observers: readonly RetryStageObserver[]) => {
    for (const observer of observers) {
      const issue = await input.api.get<Json>(`/api/issues/${observer.record.issueId}`, 10_000).catch(() => null);
      const view = issueView(issue);
      views.set(observer, view);
      noteRetryBanner(observer.record.stagingMix ??= {}, view.status !== "done" && view.canRetry, now(), null);
    }
  };
  input.note("staging_mix_settling", { settleUntil: new Date(input.settleUntil).toISOString(), tasks: tracked.length });
  for (;;) {
    await read(tracked.filter(observer => views.get(observer)?.status !== "done"));
    if (input.cancelled() || now() >= input.settleUntil || tracked.every(observer => views.get(observer)?.status === "done")) break;
    await sleep(Math.min(pollMs, Math.max(1, input.settleUntil - now())));
  }
  const clicked: RetryStageObserver[] = [];
  for (const observer of tracked) {
    const view = views.get(observer);
    if (!view || input.cancelled() || !shouldClickRetryAfterSettle(view, observer.record.retry ? 1 : 0)) continue;
    const at = now();
    await observer.retryAfterSettle({ at, reachable: true, serverReady: true, issueStatus: view.status, interruption: view.interruption }, at);
    (observer.record.stagingMix ??= {}).retryAfterSettle = { at, accepted: observer.record.retry?.accepted ?? null, issueStatusAtClick: view.status };
    input.note("staging_mix_retry_after_settle", { taskId: observer.plan.taskId, accepted: observer.record.retry?.accepted ?? null });
    clicked.push(observer);
  }
  const until = now() + input.settleMs;
  while (clicked.some(observer => !observer.done) && !input.cancelled() && now() < until) {
    for (const observer of clicked) if (!observer.done) await observer.poll(now());
    await sleep(Math.min(pollMs, 15_000));
  }
  return { clicked: clicked.map(observer => observer.plan.taskId) };
}

export interface ResultTask { taskId: string; issueId: string | null; record: TaskRecord; pass: boolean; finalStatus: string | null }

export interface StagingMixResult {
  started: number;
  completedHandsOff: number;
  bannerShown: Array<{ taskId: string; firstShownAt: string; shownMs: number; errorCode: string | null; completedAnyway: boolean }>;
  retryClicked: number;
  retryWorked: number;
  invariant: { violationCount: number | null; violations: Record<string, number> | null; agentsWithStalledSlots: number | null; openTasks: number | null; error?: string };
}

export function summarizeStagingMix(tasks: readonly ResultTask[], extraClicks: ReadonlyMap<string, boolean | null>, invariant: StagingMixResult["invariant"], now = Date.now()): StagingMixResult {
  const clicked = (task: ResultTask) => Boolean(task.record.retry || task.record.priorRetries?.length || (task.issueId && extraClicks.has(task.issueId)));
  const clickedTasks = tasks.filter(clicked);
  return {
    started: tasks.length,
    completedHandsOff: tasks.filter(task => task.pass && !clicked(task)).length,
    bannerShown: tasks.flatMap(task => task.record.stagingMix?.retryBanner ? [{ taskId: task.taskId, firstShownAt: new Date(task.record.stagingMix.retryBanner.firstShownAt).toISOString(),
      shownMs: bannerShownMs(task.record.stagingMix.retryBanner, now), errorCode: task.record.stagingMix.retryBanner.errorCode,
      completedAnyway: task.finalStatus === "done" && !clicked(task) }] : []),
    retryClicked: clickedTasks.length,
    retryWorked: clickedTasks.filter(task => task.finalStatus === "done").length,
    invariant,
  };
}

export function stagingMixHeadline(result: StagingMixResult): string[] {
  return [
    `completed hands-off / started: ${result.completedHandsOff} / ${result.started}`,
    `Retry banner shown: ${result.bannerShown.length} tasks`,
    `Retry worked / Retry clicked: ${result.retryWorked} / ${result.retryClicked}`,
  ];
}

export async function readAssignedWorkInvariant(api: Pick<ChaosApi, "get">, companyId: string): Promise<StagingMixResult["invariant"]> {
  try {
    const report = await api.get<Json>(`/api/companies/${companyId}/assigned-work-invariant`, 30_000);
    return { violationCount: typeof report.violationCount === "number" ? report.violationCount : null, violations: report.violations ?? null,
      agentsWithStalledSlots: Array.isArray(report.agentsWithStalledSlots) ? report.agentsWithStalledSlots.length : null,
      openTasks: typeof report.openTasks === "number" ? report.openTasks : null };
  } catch (error) {
    return { violationCount: null, violations: null, agentsWithStalledSlots: null, openTasks: null, error: String(error) };
  }
}

export async function writeStagingMixResults(input: { waveDir: string; api: Pick<ChaosApi, "get">; companyId: string;
  tasks: ReadonlyArray<{ plan: TaskPlan; record: TaskRecord }>; passed: ReadonlyMap<string, boolean>;
  timeline: ReadonlyArray<{ kind: string; [key: string]: unknown }> }): Promise<StagingMixResult> {
  const extraClicks = new Map<string, boolean | null>(input.timeline.filter(entry => entry.kind === "release_swap_retry_clicked" && typeof entry.issueId === "string")
    .map(entry => [String(entry.issueId), entry.accepted === true ? true : entry.accepted === false ? false : null]));
  const tasks: ResultTask[] = [];
  for (const task of input.tasks) {
    const issue = task.record.issueId ? await input.api.get<Json>(`/api/issues/${task.record.issueId}`, 10_000).catch(() => null) : null;
    tasks.push({ taskId: task.plan.taskId, issueId: task.record.issueId, record: task.record, pass: input.passed.get(task.plan.taskId) === true,
      finalStatus: issue?.status ?? task.record.finalStatus });
  }
  const result = summarizeStagingMix(tasks, extraClicks, await readAssignedWorkInvariant(input.api, input.companyId));
  await writeFile(path.join(input.waveDir, "staging-mix-results.json"), `${JSON.stringify({ schema: "paperclip.restart-chaos.staging-mix/v1",
    headline: stagingMixHeadline(result), ...result }, null, 2)}\n`, { mode: 0o600 });
  const invariant = result.invariant.violationCount === null ? `unreadable${result.invariant.error ? ` (${result.invariant.error})` : ""}`
    : `${result.invariant.violationCount} violations, ${result.invariant.agentsWithStalledSlots} agents with stalled slots, ${result.invariant.openTasks} open tasks`;
  await writeFile(path.join(input.waveDir, "staging-mix-summary.md"), [...stagingMixHeadline(result), `Assigned-work invariant: ${invariant}`, "",
    ...result.bannerShown.map(entry => `- ${entry.taskId}: Retry banner from ${entry.firstShownAt} for ${Math.round(entry.shownMs / 1000)} s`
      + `${entry.errorCode ? ` (${entry.errorCode})` : ""}${entry.completedAnyway ? ", completed without a click" : ""}`), ""].join("\n"), { mode: 0o600 });
  return result;
}
