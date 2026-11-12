import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChaosApi } from "./api.js";
import { checkCrossServer, readCrossServerEvidence, type ServerProcessWindow } from "./multi-server.js";
import type { ReleaseSwapDriver } from "./release-swap-driver.js";
import {
  gradeReleaseSwapTask, overlappingRuns, releaseSwapMarkdown, summarizeGrades, swapMetrics,
  type DuplicateFacts, type GradeTaskInput, type RetryClick, type SwapRunFact, type TaskGrade,
} from "./release-swap-grade.js";
import type { TimelineEntry } from "./timeline.js";
import type { Db } from "../../packages/db/src/index.js";

type Row = Record<string, unknown>;
type Json = Record<string, any>;

export interface ReleaseSwapFinishInput {
  driver: ReleaseSwapDriver;
  settleMs: number;
  companyId: string;
  api: ChaosApi;
  db: Db;
  board: { clickRetry(identifier: string, issueId: string): Promise<{ accepted: boolean | null; httpStatus: number | null; error: string | null }> } | null;
  timeline: readonly TimelineEntry[];
  issueIdForTask: ReadonlyMap<string, string>;
  serverWindows: readonly ServerProcessWindow[];
  waveDir: string;
  cancelled: () => boolean;
  record: (kind: string, data: Record<string, unknown>) => void;
}

const num = (value: unknown) => value === null || value === undefined ? null : Number(value);
const text = (value: unknown) => value === null || value === undefined ? null : String(value);

async function waitUntil(at: number, cancelled: () => boolean): Promise<void> {
  while (!cancelled() && Date.now() < at) await delay(Math.min(5_000, at - Date.now()));
}

async function companyRuns(db: Db, companyId: string): Promise<Row[]> {
  return await db.$client.unsafe(
    `select r.id::text as "runId", r.issue_id::text as "issueId", r.status, r.error_code as "errorCode", left(r.error, 400) as error,
            floor(extract(epoch from r.created_at) * 1000) as "createdAt", floor(extract(epoch from r.started_at) * 1000) as "startedAt",
            floor(extract(epoch from r.finished_at) * 1000) as "finishedAt", ci.pid as "ownerPid"
       from heartbeat_runs r left join controller_instances ci on ci.boot_id = r.controller_boot_id::text
      where r.company_id::text = $1`, [companyId]) as Row[];
}

async function startedIssues(db: Db, companyId: string): Promise<Row[]> {
  return await db.$client.unsafe(
    `select i.id::text as id, i.identifier, i.title from issues i
      where i.company_id::text = $1 and i.hidden_at is null and exists (select 1 from heartbeat_runs r where r.issue_id = i.id)
      order by i.created_at`, [companyId]) as Row[];
}

async function queuedWakes(db: Db, companyId: string): Promise<Map<string, number>> {
  const rows = await db.$client.unsafe(
    `select payload->>'issueId' as "issueId", count(*)::int as count from agent_wakeup_requests
      where company_id::text = $1 and status in ('queued', 'claimed', 'deferred_issue_execution', 'deferred_comment_wake')
      group by payload->>'issueId'`, [companyId]) as Row[];
  return new Map(rows.flatMap(row => row.issueId ? [[String(row.issueId), Number(row.count)] as const] : []));
}

function view(issue: Json): Omit<GradeTaskInput, "issueId" | "identifier" | "title" | "runs" | "queuedWakes" | "retryClicks"> {
  const interruption = issue.interruption;
  const attention = issue.blockedInboxAttention;
  return {
    status: String(issue.status),
    scheduledRetry: Boolean(issue.scheduledRetry),
    interruption: interruption ? { state: String(interruption.state), canRetry: interruption.canRetry === true, retryWait: Boolean(interruption.retryWait),
      userAction: text(interruption.userAction), providerFailureCategory: text(interruption.providerFailure?.category) } : null,
    activeRecoveryOwner: text(issue.activeRecoveryAction?.ownerType),
    executionBlocker: Boolean(issue.executionBlocker),
    openBlockers: (issue.blockedBy ?? []).filter((blocker: Json) => blocker.status !== "done" && blocker.status !== "cancelled").length,
    pendingApproval: Boolean(attention?.approvalId) || attention?.reason === "pending_board_decision",
    pendingQuestion: Boolean(attention?.interactionId) || attention?.reason === "pending_user_decision",
  };
}

function observedClicks(timeline: readonly TimelineEntry[], issueIdForTask: ReadonlyMap<string, string>): Map<string, RetryClick[]> {
  const clicks = new Map<string, RetryClick[]>();
  for (const entry of timeline) {
    if (entry.kind !== "task_retry_clicked" && entry.kind !== "task_child_retry_clicked") continue;
    const issueId = entry.kind === "task_child_retry_clicked" ? text(entry.childIssueId) : issueIdForTask.get(String(entry.taskId)) ?? null;
    if (!issueId) continue;
    clicks.set(issueId, [...(clicks.get(issueId) ?? []), { at: Date.parse(entry.at), accepted: entry.accepted === true ? true : entry.accepted === false ? false : null, via: "observer" }]);
  }
  return clicks;
}

async function clickRetry(input: ReleaseSwapFinishInput, issueId: string, ref: string, observedRunId: string | null): Promise<RetryClick> {
  const at = Date.now();
  if (input.board) {
    const click = await input.board.clickRetry(ref, issueId).catch(error => ({ accepted: false, httpStatus: null, error: String(error) }));
    input.record("release_swap_retry_clicked", { issueId, via: "ui", accepted: click.accepted, httpStatus: click.httpStatus, error: click.error });
    return { at, accepted: click.accepted, via: "grader" };
  }
  try {
    const result = await input.api.post<{ accepted?: boolean }>(`/api/issues/${issueId}/retry`, { idempotencyKey: randomUUID(), observedRunId });
    input.record("release_swap_retry_clicked", { issueId, via: "api", accepted: result?.accepted === true });
    return { at, accepted: result?.accepted === true, via: "grader" };
  } catch (error) {
    input.record("release_swap_retry_clicked", { issueId, via: "api", accepted: false, error: String(error) });
    return { at, accepted: false, via: "grader" };
  }
}

async function failureChains(db: Db, runIds: readonly string[]): Promise<Map<string, string[]>> {
  if (!runIds.length) return new Map();
  const rows = await db.$client.unsafe(
    `select run_id::text as "runId", event_type as "eventType", level, left(message, 240) as message from (
       select e.*, row_number() over (partition by e.run_id order by e.created_at desc, e.id desc) as position
         from heartbeat_run_events e
        where e.run_id::text = any($1) and (e.level in ('error', 'warn') or e.event_type ilike '%fail%' or e.event_type ilike '%error%' or e.event_type ilike '%lost%')
     ) ranked where position <= 6 order by "runId", created_at`, [runIds]) as Row[];
  const chains = new Map<string, string[]>();
  for (const row of rows) chains.set(String(row.runId), [...(chains.get(String(row.runId)) ?? []), `${row.eventType}${row.message ? `: ${row.message}` : ""}`]);
  return chains;
}

async function firstEventsAfter(db: Db, stops: ReadonlyArray<{ index: number; at: number; runIds: string[] }>): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const stop of stops) {
    if (!stop.runIds.length) continue;
    const rows = await db.$client.unsafe(
      `select run_id::text as "runId", floor(extract(epoch from min(created_at)) * 1000) as at from heartbeat_run_events
        where run_id::text = any($1) and created_at > to_timestamp($2::double precision / 1000) group by run_id`, [stop.runIds, stop.at]) as Row[];
    for (const row of rows) found.set(`${stop.index}:${row.runId}`, Number(row.at));
  }
  return found;
}

async function duplicateFacts(input: ReleaseSwapFinishInput, facts: readonly SwapRunFact[], waveEnd: number): Promise<DuplicateFacts> {
  const cross = await readCrossServerEvidence(input.db, input.companyId)
    .then(evidence => checkCrossServer({ ...evidence, windows: input.serverWindows })).catch(() => null);
  const comments = await input.db.$client.unsafe(
    `select issue_id::text as "issueId", count(*)::int as count from issue_comments
      where company_id::text = $1 and author_agent_id is not null group by issue_id, author_agent_id, body having count(*) > 1`, [input.companyId]) as Row[];
  const children = await input.db.$client.unsafe(
    `select parent_id::text as "parentId", title, count(*)::int as count from issues
      where company_id::text = $1 and parent_id is not null and hidden_at is null group by parent_id, title having count(*) > 1`, [input.companyId]) as Row[];
  return {
    overlappingRuns: overlappingRuns(facts, waveEnd),
    doubleExecutors: cross?.violations.filter(violation => violation.rule === "MS_double_executor").map(violation => violation.runId) ?? [],
    duplicateComments: comments.map(row => ({ issueId: String(row.issueId), count: Number(row.count) })),
    duplicateChildren: children.map(row => ({ parentId: String(row.parentId), title: String(row.title), count: Number(row.count) })),
  };
}

export async function finishReleaseSwap(input: ReleaseSwapFinishInput): Promise<{ headline: string; pass: boolean; markdown: string }> {
  const { driver, db, companyId } = input;
  await driver.drain();
  const lastStop = Math.max(0, ...driver.swaps.map(swap => swap.stoppedAt ?? swap.requestedAt));
  input.record("release_swap_settling", { until: new Date(Math.max(Date.now(), lastStop + input.settleMs)).toISOString() });
  await waitUntil(lastStop + input.settleMs, input.cancelled);
  const clicks = observedClicks(input.timeline, input.issueIdForTask);
  const views = new Map<string, Json>();
  const readViews = async (ids: readonly string[]) => {
    for (const id of ids) views.set(id, await input.api.get<Json>(`/api/issues/${id}`, 10_000).catch(error => ({ status: "unreadable", error: String(error) })));
  };
  const issues = await startedIssues(db, companyId);
  await readViews(issues.map(issue => String(issue.id)));
  const retried: string[] = [];
  for (const issue of issues) {
    const id = String(issue.id);
    const current = views.get(id)!;
    if (current.status === "done" || current.interruption?.canRetry !== true || current.interruption?.retryWait) continue;
    const click = await clickRetry(input, id, text(issue.identifier) ?? id, text(current.interruption?.observedRunId));
    clicks.set(id, [...(clicks.get(id) ?? []), click]);
    retried.push(id);
  }
  if (retried.length) {
    const until = Date.now() + input.settleMs;
    while (!input.cancelled() && Date.now() < until) {
      await delay(15_000);
      await readViews(retried);
      if (retried.every(id => views.get(id)?.status === "done")) break;
    }
  }
  const runs = await companyRuns(db, companyId);
  const wakes = await queuedWakes(db, companyId);
  const runsByIssue = new Map<string, Row[]>();
  for (const run of runs) if (run.issueId) runsByIssue.set(String(run.issueId), [...(runsByIssue.get(String(run.issueId)) ?? []), run]);
  const grades: TaskGrade[] = issues.map(issue => {
    const id = String(issue.id);
    const current = views.get(id) ?? { status: "unreadable" };
    return gradeReleaseSwapTask({ issueId: id, identifier: text(issue.identifier), title: String(issue.title), ...view(current),
      runs: (runsByIssue.get(id) ?? []).map(run => ({ runId: String(run.runId), status: String(run.status), errorCode: text(run.errorCode),
        createdAt: num(run.createdAt), startedAt: num(run.startedAt), finishedAt: num(run.finishedAt) })),
      queuedWakes: wakes.get(id) ?? 0, retryClicks: clicks.get(id) ?? [] });
  });
  const traceOwner = new Map<string, number>();
  for (const swap of driver.swaps) for (const trace of Object.values(swap.runs)) {
    const owned = trace.samples.filter(sample => sample.ownerPid !== null && (trace.finishedAt === null || sample.at <= trace.finishedAt));
    if (owned.length) traceOwner.set(trace.runId, owned[owned.length - 1]!.ownerPid!);
  }
  const facts: SwapRunFact[] = runs.map(run => ({ runId: String(run.runId), issueId: text(run.issueId), status: String(run.status), errorCode: text(run.errorCode),
    startedAt: num(run.startedAt), finishedAt: num(run.finishedAt), ownerPidBeforeEnd: traceOwner.get(String(run.runId)) ?? num(run.ownerPid) }));
  const waveEnd = Date.now();
  const windows = driver.swaps.map(swap => ({ index: swap.index, requestedAt: swap.requestedAt, spawnedAt: swap.spawnedAt, stopRequestedAt: swap.stopRequestedAt,
    stoppedAt: swap.stoppedAt, fromPid: swap.fromPid }));
  const stops = windows.flatMap(swap => swap.stopRequestedAt === null ? [] : [{ index: swap.index, at: swap.stopRequestedAt,
    runIds: facts.filter(fact => fact.startedAt !== null && fact.startedAt < swap.stopRequestedAt! && (fact.finishedAt === null || fact.finishedAt > swap.stopRequestedAt!))
      .map(fact => fact.runId) }]);
  const metrics = swapMetrics(windows, facts, await firstEventsAfter(db, stops), waveEnd);
  const duplicates = await duplicateFacts(input, facts, waveEnd);
  const result = summarizeGrades(grades);
  const failed = runs.filter(run => ["failed", "timed_out", "interrupted"].includes(String(run.status)));
  const chains = await failureChains(db, failed.map(run => String(run.runId)));
  const failedRuns = failed.map(run => ({ runId: String(run.runId), issueId: text(run.issueId), status: String(run.status), errorCode: text(run.errorCode),
    error: text(run.error), finishedAt: num(run.finishedAt), ownerPid: traceOwner.get(String(run.runId)) ?? num(run.ownerPid),
    swap: [...windows].reverse().find(swap => (num(run.finishedAt) ?? 0) >= swap.requestedAt)?.index ?? null, chain: chains.get(String(run.runId)) ?? [] }));
  const evidence = driver.swaps.map(swap => swap.evidence ? { index: swap.index, ...swap.evidence } : null);
  const markdown = releaseSwapMarkdown(result, metrics, evidence, duplicates, grades);
  await writeFile(path.join(input.waveDir, "release-swap.json"), `${JSON.stringify({ schema: "paperclip.restart-chaos.release-swap/v1", result, metrics,
    swaps: driver.swaps, duplicates, failedRuns, grades }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(input.waveDir, "release-swap-summary.md"), markdown, { mode: 0o600 });
  input.record("release_swap_graded", { headline: result.headline, byVerdict: result.byVerdict, retry: result.retry,
    failedPerSwap: metrics.map(metric => metric.failedRuns.length), lostWhileOldAlive: metrics.map(metric => metric.lostWhileOldAlive.length) });
  return { headline: result.headline, pass: result.started > 0 && result.completedWithoutHuman === result.started, markdown };
}
