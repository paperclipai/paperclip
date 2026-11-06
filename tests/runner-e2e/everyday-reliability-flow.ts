import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pollUntil, type RunnerApi } from "./api.js";
import {
  LONG_SILENT_ITERATION_SECONDS, LONG_SILENT_ITERATIONS, RELIABILITY_BOUNDS, everydayReliabilitySignatures,
  interruptRedirectMessage, queueSteerMessages, queuedRestartMessage, slowStepsPrompt, stopSettleMessage,
  threeTurnRevisions, type EverydayReliabilityCaseId,
} from "./everyday-reliability-cases.js";
import {
  executedRuns, gradeInterruptRedirect, gradeLongSilentCommand, gradeQueueSteer, gradeQueuedAcrossRestart,
  gradeReassignMidrun, gradeResumptionRule, gradeThreeTurnRevise, gradeTreePauseRelease, runIssueId, runsCarrying,
  type ResumptionObservation, type RetryClick,
} from "./everyday-reliability.js";
import { isActiveStoryRun, type StoryCheck, type StoryIssue, type StoryReplyExpectation, type StoryRun } from "./everyday-observations.js";
import { collectRunEvents } from "./run-observations.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
interface StoryState { issues: Array<StoryIssue & Row>; runs: StoryRun[] }

/** Narrow capabilities lent by the everyday workflow; no direct database or runner hooks. */
export interface ReliabilityFlowContext {
  page: Page;
  api: RunnerApi;
  execution: MatrixExecution;
  nonce: string;
  leadAgentId: string;
  helperAgentId?: string;
  workspacePath: string;
  deadlineAt: number;
  parentId: string;
  refresh(): Promise<StoryState>;
  /** Composer reply; returns the stored user comment IDs. */
  reply(message: string): Promise<string[]>;
  openParent(): Promise<void>;
  restart(): Promise<unknown>;
  note(action: string, detail?: unknown): void;
  allowInterrupted(runId: string): void;
  evidence(name: string, value: unknown): Promise<void>;
  capture(id: string, label: string, file: string): Promise<void>;
}

export interface ReliabilityOutcome {
  expectedReply?: StoryReplyExpectation;
  /** Agents permitted to execute on the parent task (reassignment moves ownership). */
  parentAgentIds: string[];
  checks(): Promise<StoryCheck[]>;
}

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Interrupted work resumes automatically, or a Retry works on first use; otherwise fail. */
class ResumptionWatcher {
  readonly observations: ResumptionObservation[] = [];
  readonly retryClicks: RetryClick[] = [];
  stalled?: string;
  constructor(private readonly ctx: ReliabilityFlowContext) {}

  async observe(state: StoryState) {
    const issues = state.issues.filter(issue => issue.id === this.ctx.parentId || issue.parentId === this.ctx.parentId);
    for (const issue of issues) {
      const [detail, execution] = await Promise.all([
        this.ctx.api.get<Row>(`/api/issues/${issue.id}`),
        this.ctx.api.get<Row | null>(`/api/issues/${issue.id}/execution`).catch(() => null),
      ]);
      const observation: ResumptionObservation = {
        at: new Date().toISOString(), issueId: issue.id,
        blocker: detail.executionBlocker ?? null, interruption: detail.interruption ?? null,
        execution: execution?.execution ? { phase: execution.execution.phase, label: execution.execution.label, cause: execution.execution.cause } : null,
      };
      this.observations.push(observation);
      // An automatic retry that is already scheduled is the harness doing its job; wait for it.
      const automatic = Boolean(detail.scheduledRetry) || ["working", "retry_scheduled", "resolved"].includes(detail.interruption?.state);
      const offered = detail.interruption?.canRetry === true || detail.executionBlocker?.canRetry === true;
      if (offered && !automatic && detail.status !== "done"
        && !state.runs.some(run => isActiveStoryRun(run) && runIssueId(run) === issue.id))
        await this.retry(issue.id, detail.interruption?.observedRunId ?? detail.executionBlocker?.runId ?? null);
    }
  }

  /** Use an offered Retry once and require a new run on that task. */
  private async retry(issueId: string, observedRunId: string | null) {
    const click: RetryClick = { at: new Date().toISOString(), issueId };
    this.retryClicks.push(click);
    if (this.retryClicks.filter(previous => previous.issueId === issueId).length > 1) return;
    const before = new Set((await this.ctx.refresh()).runs.map(run => run.id));
    const response = await this.ctx.api.post<Row>(`/api/issues/${issueId}/retry`, { idempotencyKey: randomUUID(), observedRunId });
    this.ctx.note("reliability-retry-used", { issueId, observedRunId, accepted: response.accepted, stale: response.stale });
    const started = await pollUntil({
      label: "run started by Retry", deadlineAt: Math.min(this.ctx.deadlineAt, Date.now() + 120_000), intervalMs: 2_000,
      load: () => this.ctx.refresh(),
      accept: state => state.runs.some(run => !before.has(run.id) && runIssueId(run) === issueId),
    }).catch(() => undefined);
    click.startedRunId = started?.runs.find(run => !before.has(run.id) && runIssueId(run) === issueId)?.id;
  }

  /** Poll until accepted, recording blockers and using any offered Retry. */
  async until(label: string, accept: (state: StoryState) => boolean, boundMs: number,
    onPoll?: () => Promise<void>): Promise<StoryState> {
    const deadlineAt = Math.min(this.ctx.deadlineAt, Date.now() + boundMs);
    let last: StoryState | undefined;
    while (Date.now() < deadlineAt) {
      await onPoll?.();
      last = await this.ctx.refresh();
      if (accept(last)) return last;
      await this.observe(last);
      await sleep(3_000);
    }
    this.stalled = `Stalled waiting for ${label} (bound ${Math.round(boundMs / 1000)}s).`;
    throw new Error(this.stalled);
  }

  checks() {
    return gradeResumptionRule({ observations: this.observations, retryClicks: this.retryClicks, stalled: this.stalled });
  }
}

const parentRuns = (ctx: ReliabilityFlowContext, state: StoryState) => state.runs.filter(run => runIssueId(run) === ctx.parentId);
const allDone = (state: StoryState) => state.issues.length > 0
  && state.issues.every(issue => issue.status === "done" && (issue.queuedComments?.entries?.length ?? 0) === 0)
  && !state.runs.some(isActiveStoryRun);

/**
 * A claimed run is not a provider turn: require a completed native tool event,
 * unless the first tool is itself the long command under test.
 */
async function waitForActiveTurn(ctx: ReliabilityFlowContext, issueId = ctx.parentId, label = "active provider turn",
  requireTool = true): Promise<StoryRun> {
  const state = await pollUntil({
    label, deadlineAt: ctx.deadlineAt, intervalMs: 2_000,
    load: async () => {
      const current = await ctx.refresh();
      const run = current.runs.find(candidate => candidate.status === "running" && runIssueId(candidate) === issueId);
      if (!run) return { current, run: undefined, tool: false };
      if (!requireTool) return { current, run, tool: true };
      const events = await collectRunEvents<Row>((afterSeq, limit) =>
        ctx.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
      return { current, run, tool: events.some(row => row.payload?.prpEvent?.eventType === "tool.execution.completed") };
    },
    accept: value => Boolean(value.run && value.tool),
    reject: value => value.current.issues.find(issue => issue.id === issueId)?.status === "done"
      && !value.current.runs.some(isActiveStoryRun) ? "Boundary unexercised: the task finished before a turn could be interrupted" : undefined,
  });
  ctx.note("reliability-active-turn", { issueId, runId: state.run!.id });
  return state.run!;
}

/** Saved workspace bytes through the public file API, or the local project path. */
async function readWorkspaceFile(ctx: ReliabilityFlowContext, file: string): Promise<string | undefined> {
  try {
    const value = await ctx.api.get<Row>(`/api/issues/${ctx.parentId}/file-resources/content?workspace=execution&path=${encodeURIComponent(file)}`);
    if (value.content?.encoding === "utf8" && typeof value.content.data === "string") return value.content.data;
  } catch { /* Fall back to the local project checkout below. */ }
  if (ctx.execution.environment.id !== "local") return undefined;
  return readFile(path.join(ctx.workspacePath, file), "utf8").catch(() => undefined);
}

async function queue(ctx: ReliabilityFlowContext): Promise<Row> {
  return ctx.api.get<Row>(`/api/issues/${ctx.parentId}/queued-comments`);
}

/** Issue an HTTP mutation without throwing, keeping its status and error code. */
async function send(ctx: ReliabilityFlowContext, method: "post" | "patch" | "delete", url: string, data: unknown) {
  const startedAt = Date.now();
  const response = await ctx.api.request[method](url, { data });
  const body = await response.json().catch(() => ({})) as Row;
  return { status: response.status(), latencyMs: Date.now() - startedAt, body, code: typeof body.code === "string" ? body.code : undefined };
}

async function interruptRedirect(ctx: ReliabilityFlowContext, watcher: ResumptionWatcher): Promise<ReliabilityOutcome> {
  const active = await waitForActiveTurn(ctx);
  const [commentId] = await ctx.reply(interruptRedirectMessage(ctx.nonce));
  if (!commentId) throw new Error("The interrupt follow-up was not stored");
  const interrupt = ctx.page.getByTestId(`task-chat-queued-interrupt-${commentId}`);
  await expect(interrupt).toBeVisible({ timeout: 30_000 });
  ctx.allowInterrupted(active.id);
  const interruptedAt = Date.now();
  await interrupt.click();
  ctx.note("reliability-interrupt-clicked", { runId: active.id, commentId });
  await watcher.until("interrupt continuation finished", state => allDone(state)
    && runsCarrying(state.runs, commentId).some(run => run.status === "succeeded"), RELIABILITY_BOUNDS.continuationStartMs + 10 * 60_000);
  await ctx.capture("reliability-interrupt", "Interrupted follow-up delivered once", "reliability-interrupt.png");

  // Stop, then send while the stopped run's save is still settling: the workspace_busy retry path.
  await ctx.reply(slowStepsPrompt("more-steps.txt", 6, 30));
  const stopped = await waitForActiveTurn(ctx, ctx.parentId, "second active provider turn");
  ctx.allowInterrupted(stopped.id);
  await ctx.page.getByTestId("task-chat-composer-stop").last().click();
  ctx.note("reliability-stop-clicked", { runId: stopped.id });
  const sentAt = Date.now();
  const [settleCommentId] = await ctx.reply(stopSettleMessage(ctx.nonce));
  if (!settleCommentId) throw new Error("The message sent during Stop settlement was not stored");
  await watcher.until("message sent during Stop settlement consumed", state => allDone(state)
    && runsCarrying(state.runs, settleCommentId).some(run => run.status === "succeeded"), RELIABILITY_BOUNDS.continuationStartMs + 10 * 60_000);
  return {
    expectedReply: `Settled ${ctx.nonce}`, parentAgentIds: [ctx.leadAgentId],
    checks: async () => {
      const state = await ctx.refresh();
      const parent = state.issues.find(issue => issue.id === ctx.parentId);
      return gradeInterruptRedirect({ runs: state.runs, comments: parent?.comments ?? [], interruptedRunId: active.id,
        interruptCommentId: commentId, interruptedAt, stopSettle: { stoppedRunId: stopped.id, commentId: settleCommentId, sentAt } });
    },
  };
}

async function reassignMidrun(ctx: ReliabilityFlowContext, watcher: ResumptionWatcher): Promise<ReliabilityOutcome> {
  if (!ctx.helperAgentId) throw new Error("Reassignment requires the second agent before task creation");
  const active = await waitForActiveTurn(ctx);
  ctx.allowInterrupted(active.id);
  const requestedAt = Date.now();
  const response = await send(ctx, "patch", `/api/issues/${ctx.parentId}`, { assigneeAgentId: ctx.helperAgentId });
  ctx.note("reliability-reassigned", { runId: active.id, status: response.status, latencyMs: response.latencyMs, code: response.code });
  if (response.status >= 300) throw new Error(`Reassignment returned ${response.status} ${response.code ?? ""}`);
  await ctx.openParent();
  await watcher.until("reassigned task finished", state => allDone(state)
    && executedRuns(state.runs).some(run => run.agentId === ctx.helperAgentId && run.status === "succeeded"), 20 * 60_000);
  return {
    parentAgentIds: [ctx.leadAgentId, ctx.helperAgentId],
    checks: async () => gradeReassignMidrun({ runs: (await ctx.refresh()).runs, issueId: ctx.parentId, oldRunId: active.id,
      newAgentId: ctx.helperAgentId!, request: { status: response.status, latencyMs: response.latencyMs, requestedAt },
      stepFile: await readWorkspaceFile(ctx, "steps.txt"), steps: 8 }),
  };
}

async function threeTurnRevise(ctx: ReliabilityFlowContext, watcher: ResumptionWatcher): Promise<ReliabilityOutcome> {
  const turnBound = 12 * 60_000;
  await watcher.until("turn 1 finished", allDone, turnBound);
  const commentIds: string[] = [];
  for (const [index, revision] of threeTurnRevisions(ctx.nonce).entries()) {
    const [commentId] = await ctx.reply(revision);
    if (!commentId) throw new Error(`Revision ${index + 2} was not stored`);
    commentIds.push(commentId);
    await watcher.until(`turn ${index + 2} finished`, state => allDone(state)
      && runsCarrying(state.runs, commentId).some(run => run.status === "succeeded"), turnBound);
    ctx.note("reliability-turn-finished", { turn: index + 2, commentId });
  }
  return {
    parentAgentIds: [ctx.leadAgentId],
    checks: async () => {
      const state = await ctx.refresh();
      const first = executedRuns(parentRuns(ctx, state)).sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!))[0];
      return gradeThreeTurnRevise({ nonce: ctx.nonce, content: await readWorkspaceFile(ctx, "items.md"),
        turnRuns: [first, ...commentIds.map(id => runsCarrying(state.runs, id).at(-1))] });
    },
  };
}

async function longSilentCommand(ctx: ReliabilityFlowContext, watcher: ResumptionWatcher): Promise<ReliabilityOutcome> {
  const commandMs = LONG_SILENT_ITERATIONS * LONG_SILENT_ITERATION_SECONDS * 1000;
  const run = await waitForActiveTurn(ctx, ctx.parentId, "silent command run", false);
  const samples: Array<{ at: string; canStop: boolean; source: "api" | "browser" }> = [];
  const browserAt = new Set([0, Math.floor(LONG_SILENT_ITERATIONS / 2), LONG_SILENT_ITERATIONS - 1]);
  const bound = Date.now() + commandMs + RELIABILITY_BOUNDS.silentCompletionAfterCommandMs;
  for (let minute = 0; Date.now() < Math.min(bound, ctx.deadlineAt); minute += 1) {
    const current = await ctx.api.get<StoryRun>(`/api/heartbeat-runs/${run.id}`);
    if (current.status !== "running") break;
    const projection = await ctx.api.get<Row | null>(`/api/issues/${ctx.parentId}/execution`).catch(() => null);
    samples.push({ at: new Date().toISOString(), canStop: projection?.execution?.canStop === true, source: "api" });
    if (browserAt.has(minute)) {
      await ctx.openParent();
      samples.push({ at: new Date().toISOString(), source: "browser",
        canStop: await ctx.page.getByTestId("task-chat-composer-stop").last().isVisible().catch(() => false) });
    }
    await sleep(60_000);
  }
  ctx.note("reliability-stop-samples", samples);
  await watcher.until("silent command run finished", allDone, RELIABILITY_BOUNDS.silentCompletionAfterCommandMs);
  return {
    expectedReply: body => body.includes(`SILENT_DONE_${ctx.nonce}`), parentAgentIds: [ctx.leadAgentId],
    checks: async () => {
      const state = await ctx.refresh();
      const reply = state.issues.find(issue => issue.id === ctx.parentId)?.comments
        ?.filter(comment => comment.authorAgentId).map(comment => String(comment.body ?? "")).join("\n");
      return gradeLongSilentCommand({ run: state.runs.find(candidate => candidate.id === run.id), content: await readWorkspaceFile(ctx, "silent.txt"),
        iterations: LONG_SILENT_ITERATIONS, iterationSeconds: LONG_SILENT_ITERATION_SECONDS, stopSamples: samples, reply, nonce: ctx.nonce });
    },
  };
}

async function treePauseRelease(ctx: ReliabilityFlowContext, watcher: ResumptionWatcher): Promise<ReliabilityOutcome> {
  const childrenOf = (state: StoryState) => state.issues.filter(issue => issue.parentId === ctx.parentId);
  const waitingStatuses = ["queued", "scheduled_retry"];
  const boundary = await pollUntil({
    label: "delegated child running with a sibling queued", deadlineAt: ctx.deadlineAt, intervalMs: 2_000,
    load: async () => {
      const state = await ctx.refresh();
      const children = childrenOf(state);
      const childRuns = state.runs.filter(run => children.some(child => child.id === runIssueId(run)));
      return { state, children, running: childRuns.find(run => run.status === "running"), waiting: childRuns.find(run => waitingStatuses.includes(run.status)),
        allActive: children.length >= 2 && children.every(child => childRuns.some(run => runIssueId(run) === child.id && isActiveStoryRun(run))) };
    },
    // A queued sibling or parked workspace_busy retry is the S50 boundary; two concurrently active children also qualify.
    accept: value => value.children.length >= 2 && (Boolean(value.waiting) || value.allActive),
    reject: value => value.children.length >= 2 && value.children.every(child => child.status === "done")
      ? "Boundary unexercised: both children finished before the hold" : undefined,
  });
  const childIds = boundary.children.map(child => child.id);
  ctx.note("reliability-tree-boundary", { childIds, running: boundary.running?.id, waiting: boundary.waiting?.id, waitingStatus: boundary.waiting?.status });
  const holdCreatedAt = Date.now();
  const created = await ctx.api.post<Row>(`/api/issues/${ctx.parentId}/tree-holds`, { mode: "pause", reason: `Reliability eval pause ${ctx.nonce}` });
  const holdId = String(created.hold?.id ?? "");
  const interruptedRuns = ((created.preview?.activeRuns ?? []) as Row[]).map(run => ({ id: String(run.id), issueId: String(run.issueId) }));
  for (const run of interruptedRuns) ctx.allowInterrupted(run.id);
  ctx.note("reliability-tree-held", { holdId, interruptedRuns });
  if (!holdId) throw new Error("Tree hold was not created");
  // Hold past the parked retry's due time so a premature dispatch would be observed.
  const dueAt = Math.max(0, ...boundary.state.runs.map(run => Date.parse(String((run as Row).scheduledRetryAt ?? ""))).filter(Number.isFinite));
  const holdUntil = Math.min(ctx.deadlineAt, Math.max(holdCreatedAt + RELIABILITY_BOUNDS.holdObservationMs, dueAt + 15_000), holdCreatedAt + 5 * 60_000);
  while (Date.now() < holdUntil) {
    const state = await ctx.refresh();
    const early = executedRuns(state.runs).find(run => childIds.includes(runIssueId(run) ?? "") && Date.parse(run.startedAt!) > holdCreatedAt);
    if (early) throw new Error(`Child run ${early.id} started during the tree hold`);
    await sleep(5_000);
  }
  const releasedAt = Date.now();
  await ctx.api.post(`/api/issues/${ctx.parentId}/tree-holds/${holdId}/release`, { reason: `Reliability eval release ${ctx.nonce}` });
  ctx.note("reliability-tree-released", { holdId, wakeAgents: false });
  await ctx.openParent();
  await watcher.until("released tree finished", allDone, 20 * 60_000);
  return {
    parentAgentIds: [ctx.leadAgentId],
    checks: async () => gradeTreePauseRelease({ runs: (await ctx.refresh()).runs, childIds, holdCreatedAt, releasedAt, interruptedRuns }),
  };
}

async function queueSteer(ctx: ReliabilityFlowContext, watcher: ResumptionWatcher): Promise<ReliabilityOutcome> {
  const messages = queueSteerMessages(ctx.nonce);
  const active = await waitForActiveTurn(ctx);
  const post = async (body: string) => (await ctx.api.post<Row>(`/api/issues/${ctx.parentId}/comments`, { body })).id as string;
  const editedId = await post(messages.original);
  const discardedId = await post(messages.discarded);
  const steeredId = await post(messages.steered);
  ctx.note("reliability-queued", { editedId, discardedId, steeredId, runId: active.id });
  let current = await pollUntil({ label: "three queued follow-ups", deadlineAt: ctx.deadlineAt, intervalMs: 1_000,
    load: () => queue(ctx), accept: value => [editedId, discardedId, steeredId]
      .every(id => (value.entries ?? []).some((entry: Row) => entry.comment?.id === id)) });
  const edit = await send(ctx, "patch", `/api/issues/${ctx.parentId}/queued-comments/${editedId}`,
    { queueId: current.queueId, revision: current.revision, body: messages.edited });
  if (edit.status >= 300) throw new Error(`Queued edit returned ${edit.status} ${edit.code ?? ""}`);
  current = await queue(ctx);
  const discard = await send(ctx, "delete", `/api/issues/${ctx.parentId}/queued-comments/${discardedId}`,
    { queueId: current.queueId, revision: current.revision });
  if (discard.status >= 300) throw new Error(`Queued discard returned ${discard.status} ${discard.code ?? ""}`);
  const steerAttempts: Array<{ status: number; code?: string }> = [];
  const steerUntil = Date.now() + RELIABILITY_BOUNDS.steeringRetryWindowMs;
  for (;;) {
    current = await queue(ctx);
    const attempt = await send(ctx, "post", `/api/issues/${ctx.parentId}/queued-comments/${steeredId}/steer`,
      { queueId: current.queueId, revision: current.revision, targetRunId: current.targetRunId ?? active.id });
    steerAttempts.push({ status: attempt.status, code: attempt.code });
    if (attempt.status < 300 || attempt.code !== "steering_temporarily_unavailable" || Date.now() > steerUntil) break;
    await sleep(5_000);
  }
  ctx.note("reliability-steer-attempts", steerAttempts);
  await watcher.until("queued follow-ups finished", state => allDone(state)
    && runsCarrying(state.runs, editedId).some(run => run.status === "succeeded"), 20 * 60_000);
  return {
    parentAgentIds: [ctx.leadAgentId],
    checks: async () => gradeQueueSteer({ runs: (await ctx.refresh()).runs, activeRunId: active.id, steerAttempts,
      edited: { commentId: editedId, originalMarker: `ORIGINAL_${ctx.nonce}`, editedMarker: `EDITED_${ctx.nonce}` },
      discarded: { commentId: discardedId, marker: `DISCARDED_${ctx.nonce}` },
      steered: { commentId: steeredId, marker: `STEERED_${ctx.nonce}` },
      files: { edited: await readWorkspaceFile(ctx, "edited.txt"), discarded: await readWorkspaceFile(ctx, "discarded.txt"),
        steered: await readWorkspaceFile(ctx, "steered.txt") } }),
  };
}

async function queuedAcrossRestart(ctx: ReliabilityFlowContext, watcher: ResumptionWatcher): Promise<ReliabilityOutcome> {
  const active = await waitForActiveTurn(ctx);
  const [commentId] = await ctx.reply(queuedRestartMessage(ctx.nonce));
  if (!commentId) throw new Error("The queued follow-up was not stored");
  // The original turn may be interrupted by shutdown; its recovery is graded by the resumption rule.
  ctx.allowInterrupted(active.id);
  await ctx.restart();
  const restartReadyAt = Date.now();
  ctx.note("reliability-controller-restarted", { runId: active.id, commentId });
  const waitObservations: Array<{ at: string; phase?: string; label?: string; cause?: string | null }> = [];
  await watcher.until("queued follow-up dispatched after restart", state => runsCarrying(state.runs, commentId).length > 0,
    RELIABILITY_BOUNDS.restartDispatchMs + 60_000, async () => {
      const value = await ctx.api.get<Row | null>(`/api/issues/${ctx.parentId}/execution`).catch(() => null);
      if (value?.execution) waitObservations.push({ at: new Date().toISOString(), phase: value.execution.phase,
        label: value.execution.label, cause: value.execution.cause });
    });
  await ctx.openParent();
  await watcher.until("queued follow-up finished", allDone, 15 * 60_000);
  return {
    expectedReply: `Restarted ${ctx.nonce}`, parentAgentIds: [ctx.leadAgentId],
    checks: async () => gradeQueuedAcrossRestart({ runs: (await ctx.refresh()).runs, commentId, restartReadyAt, waitObservations }),
  };
}

const scenarios: Record<EverydayReliabilityCaseId, (ctx: ReliabilityFlowContext, watcher: ResumptionWatcher) => Promise<ReliabilityOutcome>> = {
  "interrupt-redirect": interruptRedirect,
  "reassign-midrun": reassignMidrun,
  "three-turn-revise": threeTurnRevise,
  "long-silent-command": longSilentCommand,
  "tree-pause-release": treePauseRelease,
  "queue-steer": queueSteer,
  "queued-across-restart": queuedAcrossRestart,
};

/** Drive one reliability scenario after task creation; checks combine its grader and the resumption rule. */
export async function driveReliabilityScenario(caseId: EverydayReliabilityCaseId, ctx: ReliabilityFlowContext): Promise<ReliabilityOutcome> {
  ctx.note("reliability-scenario", { caseId, ...everydayReliabilitySignatures[caseId] });
  const watcher = new ResumptionWatcher(ctx);
  try {
    const outcome = await scenarios[caseId](ctx, watcher);
    return { ...outcome, checks: async () => {
      const checks = [...await outcome.checks(), ...watcher.checks()];
      await ctx.evidence("reliability-observations.json", { caseId, signature: everydayReliabilitySignatures[caseId],
        observations: watcher.observations, retryClicks: watcher.retryClicks, checks });
      return checks;
    } };
  } catch (error) {
    await ctx.evidence("reliability-observations.json", { caseId, signature: everydayReliabilitySignatures[caseId],
      observations: watcher.observations, retryClicks: watcher.retryClicks, stalled: watcher.stalled,
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
