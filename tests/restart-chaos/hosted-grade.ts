import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HostedApi } from "./hosted-api.js";
import { trackBanner, type RetryBanner } from "./hosted-workload.js";
import { handsOffSummary, invariantLine, readAssignedWorkInvariant } from "./hosted-handsoff.js";
import { releaseMarkdown, type ContinuityReport, type DetectedRelease } from "./hosted-release.js";
import {
  duplicateAgentComments, duplicateChildren, failureChain, firstEventAfter, gradeRuns, hostedCompanyRuns, hostedIssues, issueViewFields,
  pendingPersonItems, startedIssues, UNAVAILABLE_OVER_API, type HostedRunRow,
} from "./hosted-readers.js";
import {
  gradeReleaseSwapTask, overlappingRuns, releaseSwapMarkdown, summarizeGrades, swapMetrics, type RetryClick, type SwapRunFact, type SwapWindow, type TaskGrade,
} from "./release-swap-grade.js";

type Json = Record<string, any>;
export type GradeApi = Pick<HostedApi, "get" | "post">;
export const PROGRESS_WINDOW_MS = 5 * 60_000;

export interface HostedGradeInput {
  api: GradeApi;
  companyId: string;
  agentIds: string[];
  releases: DetectedRelease[];
  health: () => ContinuityReport;
  apiContinuity: () => ContinuityReport;
  stopObserver: () => Promise<void>;
  agentNames?: string[];
  observedClicks: () => ReadonlyMap<string, RetryClick[]>;
  banners?: () => ReadonlyMap<string, RetryBanner>;
  lastReleaseAt: number;
  settleMs: number;
  drainMs: number;
  dir: string;
  cancelled: () => boolean;
  record: (kind: string, data: Record<string, unknown>) => void;
  pollMs?: number;
  now?: () => number;
}

export function releaseWindows(releases: readonly DetectedRelease[]): SwapWindow[] {
  return releases.map(release => ({ index: release.index, requestedAt: release.lastOldOnlyAt, spawnedAt: release.firstNewAt,
    stopRequestedAt: release.lastOldAt, stoppedAt: release.lastOldAt, fromPid: null }));
}

export async function drainHosted(input: Pick<HostedGradeInput, "api" | "companyId" | "agentIds" | "lastReleaseAt" | "settleMs" | "drainMs" | "cancelled" | "record" | "pollMs" | "now">):
  Promise<{ reason: "quiet" | "cap" | "cancelled"; progressing: number }> {
  const now = input.now ?? Date.now;
  const settledAt = input.lastReleaseAt + input.settleMs;
  const capAt = Math.max(settledAt, input.lastReleaseAt + input.drainMs);
  const window = PROGRESS_WINDOW_MS;
  input.record("hosted_settling", { settleUntil: new Date(settledAt).toISOString(), capAt: new Date(capAt).toISOString() });
  while (!input.cancelled() && now() < settledAt) await delay(Math.min(input.pollMs ?? 15_000, Math.max(1, settledAt - now())));
  for (;;) {
    const at = now();
    const runs = await hostedCompanyRuns(input.api, input.companyId, input.agentIds);
    const progressing = runs.filter(run => ["queued", "running", "scheduled_retry"].includes(run.status) && (run.lastActivityAt ?? 0) >= at - window).length;
    if (input.cancelled()) return { reason: "cancelled", progressing };
    if (!progressing) return { reason: "quiet", progressing };
    if (at >= capAt) return { reason: "cap", progressing };
    await delay(Math.min(input.pollMs ?? 30_000, Math.max(1, capAt - at)));
  }
}

export async function gradeHosted(input: HostedGradeInput): Promise<{ headline: string; pass: boolean; markdown: string }> {
  const { api, companyId, agentIds } = input;
  const now = input.now ?? Date.now;
  const drained = await drainHosted(input);
  input.record("hosted_drained", drained);
  await input.stopObserver();
  const clicks = new Map<string, RetryClick[]>([...input.observedClicks()].map(([id, list]) => [id, [...list]]));
  const views = new Map<string, Json>();
  const readViews = async (ids: readonly string[]) => {
    for (const id of ids) views.set(id, await api.get<Json>(`/api/issues/${id}`).catch(error => ({ status: "unreadable", error: String(error) })));
  };
  let runs = await hostedCompanyRuns(api, companyId, agentIds);
  let issues = startedIssues(await hostedIssues(api, companyId, agentIds), runs);
  await readViews(issues.map(issue => issue.id));
  const banners = new Map<string, RetryBanner>(input.banners?.() ?? []);
  for (const issue of issues) {
    const view = views.get(issue.id)!;
    const offered = view.status !== "done" && view.interruption?.canRetry === true && !view.interruption?.retryWait;
    const next = trackBanner(banners.get(issue.id) ?? null, offered, now()).banner;
    if (next) banners.set(issue.id, next);
  }
  const retried: string[] = [];
  for (const issue of issues) {
    const current = views.get(issue.id)!;
    if (current.status === "done" || current.interruption?.canRetry !== true || current.interruption?.retryWait) continue;
    const click: RetryClick = { at: now(), accepted: false, via: "grader" };
    try {
      const result = await api.post<{ accepted?: boolean }>(`/api/issues/${issue.id}/retry`, { idempotencyKey: randomUUID(), observedRunId: current.interruption?.observedRunId ?? null });
      click.accepted = result?.accepted === true;
    } catch (error) {
      input.record("hosted_retry_click_failed", { issueId: issue.id, error: String(error) });
    }
    input.record("hosted_retry_clicked", { issueId: issue.id, accepted: click.accepted });
    clicks.set(issue.id, [...(clicks.get(issue.id) ?? []), click]);
    retried.push(issue.id);
  }
  if (retried.length) {
    const until = now() + input.settleMs;
    while (!input.cancelled() && now() < until) {
      await delay(input.pollMs ?? 15_000);
      await readViews(retried);
      if (retried.every(id => views.get(id)?.status === "done")) break;
    }
    runs = await hostedCompanyRuns(api, companyId, agentIds);
    const all = await hostedIssues(api, companyId, agentIds);
    issues = startedIssues(all, runs);
    await readViews(issues.map(issue => issue.id));
  }
  const allIssues = await hostedIssues(api, companyId, agentIds);
  const person = await pendingPersonItems(api, issues.map(issue => issue.id));
  const runsByIssue = new Map<string, HostedRunRow[]>();
  for (const run of runs) if (run.issueId) runsByIssue.set(run.issueId, [...(runsByIssue.get(run.issueId) ?? []), run]);
  const gradedAt = now();
  const unreadable = issues.filter(issue => (views.get(issue.id) ?? { status: "unreadable" }).status === "unreadable" || person.unreadable.includes(issue.id));
  if (unreadable.length) input.record("hosted_views_unreadable", { count: unreadable.length, issueIds: unreadable.map(issue => issue.id) });
  const grades: TaskGrade[] = issues.filter(issue => !unreadable.includes(issue)).map(issue => gradeReleaseSwapTask({
    now: gradedAt, staleAfterMs: PROGRESS_WINDOW_MS, issueId: issue.id, identifier: issue.identifier, title: issue.title, ...issueViewFields(views.get(issue.id)!),
    runs: gradeRuns(runsByIssue.get(issue.id) ?? []), queuedWakes: 0, retryClicks: clicks.get(issue.id) ?? [],
    pendingApproval: person.approvals.has(issue.id), pendingQuestion: person.questions.has(issue.id) }));
  const facts: SwapRunFact[] = runs.map(run => ({ runId: run.runId, issueId: run.issueId, status: run.status, errorCode: run.errorCode,
    startedAt: run.startedAt, finishedAt: run.finishedAt, ownerPidBeforeEnd: null }));
  const windows = releaseWindows(input.releases);
  const firstEvents = new Map<string, number>();
  for (const window of windows) {
    const stop = window.stopRequestedAt!;
    for (const fact of facts.filter(fact => fact.startedAt !== null && fact.startedAt < stop && (fact.finishedAt === null || fact.finishedAt > stop))) {
      const at = await firstEventAfter(api, fact.runId, stop);
      if (at !== null) firstEvents.set(`${window.index}:${fact.runId}`, at);
    }
  }
  const waveEnd = now();
  const metrics = swapMetrics(windows, facts, firstEvents, waveEnd);
  const duplicates = { overlappingRuns: overlappingRuns(facts, waveEnd), doubleExecutors: [] as string[],
    duplicateComments: await duplicateAgentComments(api, issues.map(issue => issue.id)), duplicateChildren: duplicateChildren(allIssues) };
  const result = summarizeGrades(grades, unreadable.length, drained.reason);
  const handsOff = handsOffSummary(result, issues.map(issue => issue.id), banners);
  const invariant = await readAssignedWorkInvariant(api, companyId, { identifiers: new Set(issues.flatMap(issue => issue.identifier ? [issue.identifier] : [])),
    agentNames: new Set(input.agentNames ?? []) });
  const failed = runs.filter(run => ["failed", "timed_out", "interrupted"].includes(run.status));
  const failedRuns = [];
  for (const run of failed) failedRuns.push({ ...run, release: [...windows].reverse().find(window => (run.finishedAt ?? 0) >= window.requestedAt)?.index ?? null,
    chain: await failureChain(api, run.runId) });
  const health = input.health();
  const apiContinuity = input.apiContinuity();
  const markdown = [
    ...handsOff.lines,
    invariantLine(invariant),
    "",
    releaseSwapMarkdown(result, metrics, windows.map(() => null), duplicates, grades).trimEnd(),
    "",
    "Hosted mode: releases came from the instance's own deploys, detected by polling /api/health. Lost-while-old-alive and late/preparation probes are not measured (see Unavailable).",
    ...releaseMarkdown(input.releases, health, apiContinuity),
    "",
    "Unavailable over the API:",
    ...UNAVAILABLE_OVER_API.map(item => `- ${item}`),
    "",
  ].join("\n");
  await writeFile(path.join(input.dir, "hosted-release-swap.json"), `${JSON.stringify({ schema: "paperclip.restart-chaos.hosted-release-swap/v1", result, handsOff: { ...handsOff, banners: Object.fromEntries(banners) }, invariant,
    releases: input.releases, health, api: apiContinuity, metrics, duplicates, failedRuns, grades, drained,
    unavailable: UNAVAILABLE_OVER_API }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(input.dir, "SUMMARY.md"), markdown, { mode: 0o600 });
  input.record("hosted_graded", { headline: result.headline, byVerdict: result.byVerdict, byLabel: result.byLabel, retry: result.retry,
    failedPerRelease: metrics.map(metric => metric.failedRuns.length) });
  return { headline: handsOff.lines[0]!, markdown,
    pass: result.uncollected === 0 && result.stillRunning === 0 && result.started > 0 && result.completedWithoutHuman === result.started };
}
