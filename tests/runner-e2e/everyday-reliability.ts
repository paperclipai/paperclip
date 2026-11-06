import { RELIABILITY_BOUNDS } from "./everyday-reliability-cases.js";
import { isStoryWorkspaceDeferral, type StoryCheck, type StoryComment, type StoryRun } from "./everyday-observations.js";

/**
 * Pure graders for the staging-soak reliability scenarios. Product rule:
 * work interrupted by a restart, Stop, reassignment or lost runner resumes
 * automatically, or offers a Retry that works on first use. "Send a message
 * to continue", a dead Retry, a silent stall and duplicate execution all fail.
 */

const check = (id: string, passed: boolean, detail: string): StoryCheck => ({ id, passed, detail });
const ms = (value: string | null | undefined) => Date.parse(value ?? "");
/** Clock granularity between separately written run timestamps. */
const OVERLAP_TOLERANCE_MS = 2_000;

export function runIssueId(run: StoryRun): string | undefined {
  const context = run.contextSnapshot ?? {};
  return run.nativeIssueId ?? (typeof context.issueId === "string" ? context.issueId
    : typeof context.taskId === "string" ? context.taskId : undefined);
}

/** Serialized native execution input; a delivered message appears here by ID and body. */
export function runNativeInput(run: StoryRun): string {
  return JSON.stringify(run.runnerProfileJson?.nativeExecutionInput ?? null);
}

/** Runs that reached provider execution (workspace deferrals never did). */
export function executedRuns(runs: readonly StoryRun[]): StoryRun[] {
  return runs.filter(run => !isStoryWorkspaceDeferral(run) && Boolean(run.startedAt));
}

/** Executed runs whose input carried this message. */
export function runsCarrying(runs: readonly StoryRun[], needle: string): StoryRun[] {
  return executedRuns(runs).filter(run => runNativeInput(run).includes(needle));
}

/** Pairs of runs that executed on the same task at the same time. */
export function concurrentExecutors(runs: readonly StoryRun[], issueId: string, now = Date.now()): Array<[string, string]> {
  const spans = executedRuns(runs).filter(run => runIssueId(run) === issueId)
    .map(run => ({ id: run.id, start: ms(run.startedAt), end: Number.isFinite(ms(run.finishedAt)) ? ms(run.finishedAt) : now }))
    .sort((left, right) => left.start - right.start);
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < spans.length; index += 1)
    for (let other = index + 1; other < spans.length; other += 1)
      if (spans[other]!.start + OVERLAP_TOLERANCE_MS < spans[index]!.end) pairs.push([spans[index]!.id, spans[other]!.id]);
  return pairs;
}

/** Exact "step-1".."step-N" lines, each once and in order. */
export function completeStepLines(content: string | undefined, steps: number, prefix = "step"): boolean {
  if (content === undefined) return false;
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.length === steps && lines.every((line, index) => line === `${prefix}-${index + 1}`);
}

export interface ResumptionObservation {
  at: string;
  issueId: string;
  blocker?: { cause?: string | null; nextAction?: string | null; canRetry?: boolean; canContinue?: boolean } | null;
  interruption?: { state?: string; canRetry?: boolean; userAction?: string | null; responsibility?: string } | null;
  execution?: { phase?: string; label?: string; cause?: string | null } | null;
}
export interface RetryClick { at: string; issueId: string; startedRunId?: string }

/** The only way forward is another user message: the S47/S49 failure mode. */
export function requiresUserMessage(observation: ResumptionObservation): boolean {
  const blocker = observation.blocker;
  if (blocker && !blocker.canRetry && /send (?:a |another |a new )?(?:new )?(?:chat )?message/i.test(blocker.nextAction ?? ""))
    return true;
  const interruption = observation.interruption;
  return Boolean(interruption && interruption.state === "waiting_for_user" && !interruption.canRetry && !interruption.userAction);
}

export function gradeResumptionRule(input: {
  observations: readonly ResumptionObservation[];
  retryClicks: readonly RetryClick[];
  stalled?: string;
}): StoryCheck[] {
  const blocked = input.observations.find(requiresUserMessage);
  const dead = input.retryClicks.filter(click => !click.startedRunId);
  const repeated = new Set(input.retryClicks.map(click => click.issueId)).size !== input.retryClicks.length;
  return [
    check("resume.no-send-message-blocker", !blocked,
      blocked ? `Blocked at ${blocked.at}: ${blocked.blocker?.nextAction ?? blocked.interruption?.state}` : "Interrupted work never required another user message to continue."),
    check("resume.retry-works-first-use", dead.length === 0 && !repeated,
      input.retryClicks.length === 0 ? "No Retry was needed; work resumed automatically."
        : dead.length ? `Retry clicked without starting a run at ${dead.map(click => click.at).join(", ")}.`
          : repeated ? "Retry had to be used more than once for the same task." : "Each offered Retry started work on first use."),
    check("resume.no-silent-stall", !input.stalled, input.stalled ?? "Work resumed or finished within the scenario bound."),
  ];
}

const userCommentsBetween = (comments: readonly StoryComment[], from: number, to: number, except: readonly string[]) =>
  comments.filter(comment => !comment.authorAgentId && !except.includes(comment.id ?? "")
    && ms(comment.createdAt) > from && ms(comment.createdAt) < to);

export function gradeInterruptRedirect(input: {
  runs: readonly StoryRun[];
  comments: readonly StoryComment[];
  interruptedRunId: string;
  interruptCommentId: string;
  interruptedAt: number;
  stopSettle?: { stoppedRunId: string; commentId: string; sentAt: number };
}): StoryCheck[] {
  const interrupted = input.runs.find(run => run.id === input.interruptedRunId);
  const carriers = runsCarrying(input.runs, input.interruptCommentId);
  const continuation = carriers[0];
  const delay = ms(continuation?.startedAt) - input.interruptedAt;
  const extra = continuation ? userCommentsBetween(input.comments, input.interruptedAt, ms(continuation.startedAt), [input.interruptCommentId]) : [];
  const checks = [
    check("interrupt.operator-interrupt", interrupted?.status === "cancelled"
      && (interrupted.errorCode === "operator_interrupted" || interrupted.resultJson?.operatorInterrupted === true),
    `The interrupted run ends as an operator interrupt (observed ${interrupted?.status ?? "missing"}/${interrupted?.errorCode ?? "none"}).`),
    check("interrupt.exactly-one-continuation", carriers.length === 1 && continuation?.status === "succeeded",
      `Exactly one successful continuation carries the interrupt message (observed ${carriers.length}).`),
    check("interrupt.continuation-bounded", Number.isFinite(delay) && delay <= RELIABILITY_BOUNDS.continuationStartMs,
      `The continuation starts within ${RELIABILITY_BOUNDS.continuationStartMs / 1000}s of the interrupt (observed ${Number.isFinite(delay) ? Math.round(delay / 1000) + "s" : "never"}).`),
    check("interrupt.no-second-message", extra.length === 0, "No second user message was needed before the continuation started."),
  ];
  if (input.stopSettle) {
    const stopped = input.runs.find(run => run.id === input.stopSettle!.stoppedRunId);
    const settleCarriers = runsCarrying(input.runs, input.stopSettle.commentId);
    const settleDelay = ms(settleCarriers[0]?.startedAt) - input.stopSettle.sentAt;
    checks.push(
      check("stop-settle.stopped", stopped?.status === "cancelled", "The stopped run is terminal as cancelled."),
      check("stop-settle.consumed-once", settleCarriers.length === 1 && settleCarriers[0]?.status === "succeeded",
        `A message sent while Stop was settling is consumed by exactly one successful run (observed ${settleCarriers.length}).`),
      check("stop-settle.bounded", Number.isFinite(settleDelay) && settleDelay <= RELIABILITY_BOUNDS.continuationStartMs,
        `The workspace_busy retry dispatches within ${RELIABILITY_BOUNDS.continuationStartMs / 1000}s (observed ${Number.isFinite(settleDelay) ? Math.round(settleDelay / 1000) + "s" : "never"}).`),
    );
  }
  return checks;
}

export function gradeReassignMidrun(input: {
  runs: readonly StoryRun[];
  issueId: string;
  oldRunId: string;
  newAgentId: string;
  request: { status: number; latencyMs: number; requestedAt: number };
  stepFile?: string;
  steps: number;
}): StoryCheck[] {
  const old = input.runs.find(run => run.id === input.oldRunId);
  const successor = executedRuns(input.runs).find(run => run.agentId === input.newAgentId && runIssueId(run) === input.issueId
    && ms(run.startedAt) >= input.request.requestedAt);
  const overlaps = concurrentExecutors(input.runs, input.issueId);
  return [
    check("reassign.request-prompt", input.request.status >= 200 && input.request.status < 300
      && input.request.latencyMs <= RELIABILITY_BOUNDS.reassignRequestMs,
    `Reassignment returns ${input.request.status} in ${input.request.latencyMs}ms (bound ${RELIABILITY_BOUNDS.reassignRequestMs}ms, no 409).`),
    check("reassign.old-run-ended", old?.status === "cancelled" && old.errorCode === "issue_reassigned",
      `The original run ends issue_reassigned (observed ${old?.status ?? "missing"}/${old?.errorCode ?? "none"}).`),
    check("reassign.new-assignee-finished", successor?.status === "succeeded", "The new assignee's run starts after the request and succeeds."),
    check("reassign.no-concurrent-executors", overlaps.length === 0,
      overlaps.length ? `Concurrent executions: ${overlaps.map(pair => pair.join("+")).join(", ")}.` : "Never two executions on the task at once."),
    check("reassign.continued-from-saved-files", completeStepLines(input.stepFile, input.steps),
      `The saved step file holds step-1..step-${input.steps} exactly once, so work continued from saved files.`),
  ];
}

export function gradeThreeTurnRevise(input: {
  turnRuns: ReadonlyArray<StoryRun | undefined>;
  content?: string;
  nonce: string;
}): StoryCheck[] {
  const items = ["alpha", "beta", "gamma", "delta", "epsilon"].map(word => `${word} ${input.nonce}`);
  const rows = (input.content ?? "").split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith("|"));
  const header = rows[0]?.toLowerCase() ?? "";
  const body = rows.slice(2);
  const table = /number/.test(header) && /item/.test(header) && /^\|[\s:|-]+\|$/.test(rows[1] ?? "")
    && body.length === items.length && body.every((row, index) => row.includes(items[index]!));
  const bullets = /^\s*[-*]\s+/m.test(input.content ?? "");
  return [
    ...input.turnRuns.map((run, index) => check(`three-turn.turn-${index + 1}-succeeded`, run?.status === "succeeded",
      `Turn ${index + 1} completes in a successful run without a reconciliation stop (observed ${run?.status ?? "no run"}).`)),
    check("three-turn.final-table", table && !bullets, "items.md is a Number/Item table with all five items in order and no bullet list."),
  ];
}

export function gradeLongSilentCommand(input: {
  run?: StoryRun;
  content?: string;
  iterations: number;
  iterationSeconds: number;
  stopSamples: ReadonlyArray<{ at: string; canStop: boolean; source: "api" | "browser" }>;
  reply?: string;
  nonce: string;
}): StoryCheck[] {
  const commandMs = input.iterations * input.iterationSeconds * 1000;
  const elapsed = ms(input.run?.finishedAt) - ms(input.run?.startedAt);
  const named = input.run?.status === "succeeded" || Boolean(input.run?.errorCode);
  return [
    check("silent.completed", input.run?.status === "succeeded",
      `The run completes after the silent command (observed ${input.run?.status ?? "no run"}${input.run?.errorCode ? `/${input.run.errorCode}` : ""}).`),
    check("silent.not-shortened", Number.isFinite(elapsed) && elapsed >= commandMs * 0.95,
      `The run lasted at least the ${input.iterations}-minute command (observed ${Number.isFinite(elapsed) ? Math.round(elapsed / 1000) + "s" : "unknown"}).`),
    check("silent.no-hang", Number.isFinite(elapsed) && elapsed <= commandMs + RELIABILITY_BOUNDS.silentCompletionAfterCommandMs,
      `The run is terminal within ${RELIABILITY_BOUNDS.silentCompletionAfterCommandMs / 60_000} minutes after the command ends.`),
    check("silent.named-failure", named, named ? "Any failure carries a named cause." : "The run ended without a named cause."),
    check("silent.file-complete", completeStepLines(input.content, input.iterations, "tick"),
      `silent.txt holds tick-1..tick-${input.iterations} exactly once.`),
    check("silent.stop-available", input.stopSamples.length >= 3 && input.stopSamples.every(sample => sample.canStop)
      && input.stopSamples.some(sample => sample.source === "browser"),
    `Stop stays available throughout the silent interval (${input.stopSamples.filter(sample => sample.canStop).length}/${input.stopSamples.length} samples).`),
    check("silent.reported", new RegExp(`SILENT_DONE_${input.nonce}\\s+${input.iterations}\\b`).test(input.reply ?? ""),
      "The agent reports the completed line count after the command."),
  ];
}

export function gradeTreePauseRelease(input: {
  runs: readonly StoryRun[];
  childIds: readonly string[];
  holdCreatedAt: number;
  releasedAt: number;
  interruptedRuns: ReadonlyArray<{ id: string; issueId: string }>;
}): StoryCheck[] {
  const executed = executedRuns(input.runs);
  const startedDuringHold = executed.filter(run => input.childIds.includes(runIssueId(run) ?? "")
    && ms(run.startedAt) > input.holdCreatedAt && ms(run.startedAt) < input.releasedAt);
  const interruptedIssues = [...new Set(input.interruptedRuns.map(run => run.issueId))];
  const resumed = (issueId: string) => input.runs.filter(run => runIssueId(run) === issueId
    && run.contextSnapshot?.wakeReason === "issue_tree_resumed" && !isStoryWorkspaceDeferral(run));
  const resumeCounts = interruptedIssues.map(issueId => ({ issueId, count: resumed(issueId).length }));
  const stray = input.runs.filter(run => run.contextSnapshot?.wakeReason === "issue_tree_resumed"
    && !interruptedIssues.includes(runIssueId(run) ?? ""));
  return [
    check("tree.hold-interrupted-work", input.interruptedRuns.length > 0,
      input.interruptedRuns.length ? `The hold interrupted ${input.interruptedRuns.length} run(s).` : "Boundary unexercised: no child work was active or queued when the hold was created."),
    check("tree.no-start-during-hold", startedDuringHold.length === 0,
      startedDuringHold.length ? `Child runs started during the hold: ${startedDuringHold.map(run => run.id).join(", ")}.` : "No child run started while the tree was paused."),
    check("tree.one-resume-per-interrupted", resumeCounts.every(entry => entry.count === 1) && stray.length === 0,
      `Each interrupted task gets exactly one issue_tree_resumed run (observed ${resumeCounts.map(entry => entry.count).join(", ") || "none"}; stray ${stray.length}).`),
  ];
}

export function gradeQueueSteer(input: {
  runs: readonly StoryRun[];
  activeRunId: string;
  edited: { commentId: string; originalMarker: string; editedMarker: string };
  discarded: { commentId: string; marker: string };
  steered: { commentId: string; marker: string };
  steerAttempts: ReadonlyArray<{ status: number; code?: string }>;
  files: { edited?: string; discarded?: string; steered?: string };
}): StoryCheck[] {
  const executed = executedRuns(input.runs);
  const anyInput = (needle: string) => executed.some(run => runNativeInput(run).includes(needle));
  const active = input.runs.find(run => run.id === input.activeRunId);
  const acks = (active?.resultJson?.queuedSteeringAcknowledgements ?? {}) as Record<string, { status?: string }>;
  const editedCarriers = runsCarrying(input.runs, input.edited.commentId);
  const steerReplays = runsCarrying(input.runs, input.steered.commentId);
  const finalAttempt = input.steerAttempts.at(-1);
  const retriesValid = input.steerAttempts.slice(0, -1).every(attempt => attempt.code === "steering_temporarily_unavailable");
  return [
    check("queue.edit-used", anyInput(input.edited.editedMarker) && !anyInput(input.edited.originalMarker)
      && (input.files.edited ?? "").includes(input.edited.editedMarker),
    "The edited text reached the agent; the original text never did."),
    check("queue.remaining-handled-once", editedCarriers.length === 1 && editedCarriers[0]?.status === "succeeded",
      `The remaining queued message is handled by exactly one successful run (observed ${editedCarriers.length}).`),
    check("queue.discard-never-delivered", !anyInput(input.discarded.marker) && !anyInput(input.discarded.commentId)
      && !acks[input.discarded.commentId] && input.files.discarded === undefined,
    "The discarded message never reached the agent."),
    check("queue.steer-consumed-in-active-run", acks[input.steered.commentId]?.status === "acknowledged" && steerReplays.length === 0
      && (input.files.steered ?? "").includes(input.steered.marker),
    "The steered message is acknowledged by the active turn, acted on there, and never replayed as a new run."),
    check("queue.steer-retry-bounded", Boolean(finalAttempt && finalAttempt.status >= 200 && finalAttempt.status < 300) && retriesValid,
      `Steering succeeded after ${input.steerAttempts.length} attempt(s); only steering_temporarily_unavailable was retried.`),
  ];
}

export function gradeQueuedAcrossRestart(input: {
  runs: readonly StoryRun[];
  commentId: string;
  restartReadyAt: number;
  waitObservations: ReadonlyArray<{ at: string; phase?: string; label?: string; cause?: string | null }>;
}): StoryCheck[] {
  const carriers = runsCarrying(input.runs, input.commentId);
  const start = ms(carriers[0]?.startedAt);
  const bare = input.waitObservations.filter(observation => observation.phase === "queued"
    && (!observation.cause || observation.label === "Queued"));
  return [
    check("restart.boundary-exercised", Number.isFinite(start) ? start >= input.restartReadyAt : true,
      "The queued follow-up dispatched only after the controller restart."),
    check("restart.dispatched-bounded", Number.isFinite(start) && start - input.restartReadyAt <= RELIABILITY_BOUNDS.restartDispatchMs,
      `The follow-up dispatches automatically within ${RELIABILITY_BOUNDS.restartDispatchMs / 60_000} minutes of restart (observed ${Number.isFinite(start) ? Math.round((start - input.restartReadyAt) / 1000) + "s" : "never"}).`),
    check("restart.exactly-once", carriers.length === 1 && carriers[0]?.status === "succeeded",
      `The follow-up is consumed by exactly one successful run (observed ${carriers.length}).`),
    check("restart.named-wait", bare.length === 0,
      bare.length ? `Bare Queued without a cause at ${bare.map(observation => observation.at).join(", ")}.`
        : `Every observed wait names its cause (${input.waitObservations.length} observations).`),
  ];
}
