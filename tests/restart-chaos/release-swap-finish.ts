import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChaosApi } from "./api.js";
import { checkCrossServer, readCrossServerEvidence, type ServerProcessWindow } from "./multi-server.js";
import { RUN_OWNER_BOOT_ID, type ReleaseSwapDriver } from "./release-swap-driver.js";
import {
  drainState, failedOutsideSwaps, gradeReleaseSwapTask, isAutoNotice, overlappingRuns, QUIET_PERIOD_MS, releaseSwapMarkdown, summarizeGrades, swapForFailedRun, swapMetrics,
  type DuplicateFacts, type GradeTaskInput, type RetryClick, type SwapRunFact, type TaskGrade,
} from "./release-swap-grade.js";
import { runsStartedDuringSwap, swapMoments, swapMomentsMarkdown } from "./release-swap-moments.js";
import { issueView, shouldClickRetryAfterSettle } from "./staging-mix-retry.js";
import type { TimelineEntry } from "./timeline.js";
import type { Db } from "../../packages/db/src/index.js";

type Row = Record<string, unknown>;
type Json = Record<string, any>;

export interface ReleaseSwapFinishInput {
  driver: Pick<ReleaseSwapDriver, "drain" | "swaps">;
  settleMs: number;
  companyId: string;
  api: Pick<ChaosApi, "get" | "post">;
  db: Pick<Db, "$client">;
  board: { clickRetry(identifier: string, issueId: string): Promise<{ accepted: boolean | null; httpStatus: number | null; error: string | null }> } | null;
  timeline: readonly TimelineEntry[];
  issueIdForTask: ReadonlyMap<string, string>;
  serverWindows: readonly ServerProcessWindow[];
  waveDir: string;
  cancelled: () => boolean;
  record: (kind: string, data: Record<string, unknown>) => void;
  pollMs?: number;
  drainCapMs?: number;
  quietMs?: number;
  onView?: (issueId: string, issue: Json | null, at: number) => void;
}

type Client = Pick<Db, "$client">;
const VIEW_READERS = 8;
const VIEW_DEADLINE_MS = 120_000;

const num = (value: unknown) => value === null || value === undefined ? null : Number(value);
const text = (value: unknown) => value === null || value === undefined ? null : String(value);

async function waitUntil(at: number, cancelled: () => boolean): Promise<void> {
  while (!cancelled() && Date.now() < at) await delay(Math.min(5_000, at - Date.now()));
}

export const PROGRESS_WINDOW_MS = 5 * 60_000;
export const progressWindowMs = (settleMs: number) => Math.min(settleMs, PROGRESS_WINDOW_MS);

async function drainRuns(input: ReleaseSwapFinishInput, lastStop: number): Promise<{ reason: "quiet" | "cap" | "cancelled"; at: string; progressing: number }> {
  const settledAt = lastStop + input.settleMs;
  const capAt = Math.max(settledAt, lastStop + (input.drainCapMs ?? input.settleMs));
  const window = progressWindowMs(input.settleMs);
  input.record("release_swap_settling", { settleUntil: new Date(settledAt).toISOString(), capAt: new Date(capAt).toISOString() });
  await waitUntil(settledAt, input.cancelled);
  for (;;) {
    const now = Date.now();
    const state = drainState((await companyRuns(input.db, input.companyId)).map(run => ({ status: String(run.status), createdAt: num(run.createdAt),
      finishedAt: num(run.finishedAt), lastActivityAt: num(run.lastActivityAt) })), now, window, input.quietMs ?? QUIET_PERIOD_MS);
    const progressing = state.progressing;
    if (input.cancelled()) return { reason: "cancelled", at: new Date(now).toISOString(), progressing };
    if (state.quiet) return { reason: "quiet", at: new Date(now).toISOString(), progressing };
    if (now >= capAt) return { reason: "cap", at: new Date(now).toISOString(), progressing };
    await delay(Math.min(input.pollMs ?? 30_000, Math.max(1, capAt - now)));
  }
}

async function companyRuns(db: Client, companyId: string): Promise<Row[]> {
  return await db.$client.unsafe(
    `select r.id::text as "runId", r.issue_id::text as "issueId", r.status, r.error_code as "errorCode", left(r.error, 400) as error,
            floor(extract(epoch from r.created_at) * 1000) as "createdAt", floor(extract(epoch from r.started_at) * 1000) as "startedAt",
            floor(extract(epoch from r.finished_at) * 1000) as "finishedAt", ci.pid as "ownerPid",
            floor(extract(epoch from coalesce((select max(e.created_at) from heartbeat_run_events e where e.run_id = r.id), r.started_at, r.created_at)) * 1000) as "lastActivityAt"
       from heartbeat_runs r left join native_run_finalizations f on f.run_id = r.id
       left join controller_instances ci on ci.boot_id = ${RUN_OWNER_BOOT_ID}
      where r.company_id::text = $1`, [companyId]) as Row[];
}

async function startedIssues(db: Client, companyId: string): Promise<Row[]> {
  return await db.$client.unsafe(
    `select i.id::text as id, i.identifier, i.title from issues i
      where i.company_id::text = $1 and i.hidden_at is null and exists (select 1 from heartbeat_runs r where r.issue_id = i.id)
      order by i.created_at`, [companyId]) as Row[];
}

async function pendingPersonItems(db: Client, companyId: string): Promise<{ questions: Set<string>; approvals: Set<string> }> {
  const questions = await db.$client.unsafe(
    `select distinct issue_id::text as "issueId" from issue_thread_interactions where company_id::text = $1 and status = 'pending'`, [companyId]) as Row[];
  const approvals = await db.$client.unsafe(
    `select distinct ia.issue_id::text as "issueId" from issue_approvals ia join approvals a on a.id = ia.approval_id
      where ia.company_id::text = $1 and a.status in ('pending', 'revision_requested')`, [companyId]) as Row[];
  return { questions: new Set(questions.map(row => String(row.issueId))), approvals: new Set(approvals.map(row => String(row.issueId))) };
}

async function queuedWakes(db: Client, companyId: string): Promise<Map<string, number>> {
  const rows = await db.$client.unsafe(
    `select payload->>'issueId' as "issueId", count(*)::int as count from agent_wakeup_requests
      where company_id::text = $1 and status in ('queued', 'claimed', 'deferred_issue_execution', 'deferred_comment_wake')
        and not (status = 'claimed' and run_id is not null)
      group by payload->>'issueId'`, [companyId]) as Row[];
  return new Map(rows.flatMap(row => row.issueId ? [[String(row.issueId), Number(row.count)] as const] : []));
}

function view(issue: Json): Omit<GradeTaskInput, "issueId" | "identifier" | "title" | "runs" | "queuedWakes" | "retryClicks" | "pendingApproval" | "pendingQuestion"> {
  const interruption = issue.interruption;
  return {
    status: String(issue.status),
    scheduledRetry: Boolean(issue.scheduledRetry),
    scheduledRetryAt: issue.scheduledRetry?.scheduledRetryAt ? Date.parse(String(issue.scheduledRetry.scheduledRetryAt)) : null,
    interruption: interruption ? { state: String(interruption.state), canRetry: interruption.canRetry === true, retryWait: Boolean(interruption.retryWait),
      userAction: text(interruption.userAction), responsibility: text(interruption.responsibility), providerFailureCategory: text(interruption.providerFailure?.category) } : null,
    activeRecoveryOwner: text(issue.activeRecoveryAction?.ownerType),
    executionBlocker: Boolean(issue.executionBlocker),
    openBlockers: (issue.blockedBy ?? []).filter((blocker: Json) => blocker.status !== "done" && blocker.status !== "cancelled").length,
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

async function failureChains(db: Client, runIds: readonly string[]): Promise<Map<string, string[]>> {
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

async function firstEventsAfter(db: Client, stops: ReadonlyArray<{ index: number; at: number; runIds: string[] }>): Promise<Map<string, number>> {
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
  const cross = await readCrossServerEvidence(input.db as Db, input.companyId)
    .then(evidence => checkCrossServer({ ...evidence, windows: input.serverWindows })).catch(() => null);
  const repeated = await input.db.$client.unsafe(
    `select issue_id::text as "issueId", body, count(*)::int as count from issue_comments
      where company_id::text = $1 and author_agent_id is not null group by issue_id, author_agent_id, body having count(*) > 1`, [input.companyId]) as Row[];
  const comments = repeated.filter(row => !isAutoNotice(String(row.body ?? "")));
  const notices = repeated.filter(row => isAutoNotice(String(row.body ?? "")));
  const children = await input.db.$client.unsafe(
    `select parent_id::text as "parentId", title, count(*)::int as count from issues
      where company_id::text = $1 and parent_id is not null and hidden_at is null group by parent_id, title having count(*) > 1`, [input.companyId]) as Row[];
  return {
    overlappingRuns: overlappingRuns(facts, waveEnd),
    doubleExecutors: cross?.violations.filter(violation => violation.rule === "MS_double_executor").map(violation => violation.runId) ?? [],
    duplicateComments: comments.map(row => ({ issueId: String(row.issueId), count: Number(row.count) })),
    duplicateChildren: children.map(row => ({ parentId: String(row.parentId), title: String(row.title), count: Number(row.count) })),
    autoNoticeRepeats: notices.map(row => ({ issueId: String(row.issueId), count: Number(row.count) })),
  };
}

export async function finishReleaseSwap(input: ReleaseSwapFinishInput): Promise<{ headline: string; pass: boolean; markdown: string }> {
  const { driver, db, companyId } = input;
  await driver.drain(input.cancelled);
  const lastStop = driver.swaps.length ? Math.max(...driver.swaps.map(swap => swap.stoppedAt ?? swap.requestedAt)) : Date.now();
  const drained = await drainRuns(input, lastStop);
  input.record("release_swap_drained", drained);
  const clicks = observedClicks(input.timeline, input.issueIdForTask);
  const views = new Map<string, Json>();
  const readViews = async (ids: readonly string[]) => {
    const deadline = Date.now() + VIEW_DEADLINE_MS;
    const queue = [...ids];
    await Promise.all(Array.from({ length: Math.min(VIEW_READERS, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const left = deadline - Date.now();
        views.set(id, left <= 0 ? { status: "unreadable", error: "view deadline passed" }
          : await input.api.get<Json>(`/api/issues/${id}`, Math.min(10_000, left)).catch(error => ({ status: "unreadable", error: String(error) })));
        input.onView?.(id, views.get(id)!, Date.now());
      }
    }));
  };
  let issues = await startedIssues(db, companyId);
  await readViews(issues.map(issue => String(issue.id)));
  const retried: string[] = [];
  for (const issue of issues) {
    const id = String(issue.id);
    const current = views.get(id)!;
    if (!shouldClickRetryAfterSettle(issueView(current), clicks.get(id)?.length ?? 0)) continue;
    const click = await clickRetry(input, id, text(issue.identifier) ?? id, text(current.interruption?.observedRunId));
    clicks.set(id, [...(clicks.get(id) ?? []), click]);
    retried.push(id);
  }
  if (retried.length) {
    const until = Date.now() + input.settleMs;
    while (!input.cancelled() && Date.now() < until) {
      await delay(input.pollMs ?? 15_000);
      await readViews(retried);
      if (retried.every(id => views.get(id)?.status === "done")) break;
    }
    issues = await startedIssues(db, companyId);
    await readViews(issues.map(issue => String(issue.id)));
  }
  const person = await pendingPersonItems(db, companyId);
  const runs = await companyRuns(db, companyId);
  const wakes = await queuedWakes(db, companyId);
  const runsByIssue = new Map<string, Row[]>();
  for (const run of runs) if (run.issueId) runsByIssue.set(String(run.issueId), [...(runsByIssue.get(String(run.issueId)) ?? []), run]);
  const now = Date.now();
  const unreadable = issues.filter(issue => (views.get(String(issue.id)) ?? { status: "unreadable" }).status === "unreadable");
  if (unreadable.length) input.record("release_swap_views_unreadable", { count: unreadable.length, issueIds: unreadable.map(issue => String(issue.id)) });
  const grades: TaskGrade[] = issues.filter(issue => !unreadable.includes(issue)).map(issue => {
    const id = String(issue.id);
    const current = views.get(id)!;
    return gradeReleaseSwapTask({ now, staleAfterMs: progressWindowMs(input.settleMs), issueId: id, identifier: text(issue.identifier), title: String(issue.title), ...view(current),
      runs: (runsByIssue.get(id) ?? []).map(run => ({ runId: String(run.runId), status: String(run.status), errorCode: text(run.errorCode),
        createdAt: num(run.createdAt), startedAt: num(run.startedAt), finishedAt: num(run.finishedAt), lastActivityAt: num(run.lastActivityAt) })),
      queuedWakes: wakes.get(id) ?? 0, retryClicks: clicks.get(id) ?? [], pendingApproval: person.approvals.has(id), pendingQuestion: person.questions.has(id) });
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
  const result = summarizeGrades(grades, unreadable.length, drained.reason);
  const failed = runs.filter(run => ["failed", "timed_out", "interrupted"].includes(String(run.status)));
  const chains = await failureChains(db, failed.map(run => String(run.runId)));
  const failedRuns = failed.map(run => ({ runId: String(run.runId), issueId: text(run.issueId), status: String(run.status), errorCode: text(run.errorCode),
    error: text(run.error), finishedAt: num(run.finishedAt), ownerPid: traceOwner.get(String(run.runId)) ?? num(run.ownerPid),
    swap: (() => { const fact = facts.find(candidate => candidate.runId === String(run.runId)); return fact ? swapForFailedRun(windows, fact) : null; })(), chain: chains.get(String(run.runId)) ?? [] }));
  const evidence = driver.swaps.map(swap => swap.evidence ? { index: swap.index, ...swap.evidence } : null);
  const markdown = `${releaseSwapMarkdown(result, metrics, evidence, duplicates, grades, failedOutsideSwaps(windows, facts))}\nSwap moments (incoming server spawned and ready, traffic switched, outgoing server sent SIGTERM and exited):\n\n${swapMomentsMarkdown(driver.swaps).join("\n")}\n`;
  await writeFile(path.join(input.waveDir, "release-swap.json"), `${JSON.stringify({ schema: "paperclip.restart-chaos.release-swap/v1", result, metrics,
    swaps: driver.swaps.map(swap => ({ ...swap, moments: swapMoments(swap), runsStartedDuringSwap: runsStartedDuringSwap(swap) })), duplicates, failedRuns, grades }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(input.waveDir, "release-swap-summary.md"), markdown, { mode: 0o600 });
  input.record("release_swap_graded", { headline: result.headline, byVerdict: result.byVerdict, retry: result.retry,
    failedPerSwap: metrics.map(metric => metric.failedRuns.length), lostWhileOldAlive: metrics.map(metric => metric.lostWhileOldAlive.length) });
  return { headline: result.headline, pass: result.uncollected === 0 && result.stillRunning === 0 && result.started > 0 && result.completedWithoutHuman === result.started, markdown };
}
