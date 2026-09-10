import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, issues } from "@paperclipai/db";
import type { RunnerTimeoutEvidence } from "../execution-resource-admission.js";
import { readContinuationAttempt } from "./run-liveness-continuations.js";

/**
 * Bounded, progress-aware continuation of a contained run that hit its timeout.
 *
 * A contained run can time out with real work behind it: the worker session
 * still holds its checkpoint, and its external effects are recorded as native
 * receipts. Restarting the task from scratch redoes that work and can repeat
 * effects that are not idempotent; raising the timeout moves the same wall
 * later without bounding anything. So the continuation instead resumes the SAME
 * worker session from its checkpoint, is capped by its own attempt budget, and
 * carries the receipts-aware instruction.
 *
 * Only evidence of real progress qualifies: a run that timed out before
 * reaching the model, or without a single request through its run proxy, has no
 * checkpoint worth resuming and stays with the ordinary timeout handling.
 */

export const RUNNER_TIMEOUT_CONTINUATION_REASON = "runner_timeout_continuation";
export const DEFAULT_MAX_RUNNER_TIMEOUT_CONTINUATIONS = 2;

const CONTINUABLE_ISSUE_STATUSES: Record<string, true> = { todo: true, in_progress: true };
const CONTINUABLE_AGENT_STATUSES: Record<string, true> = { active: true, idle: true, running: true, error: true };
const IDEMPOTENT_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed", "completed"];

type IssueRow = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "status" | "assigneeAgentId" | "executionState" | "projectId"
>;
type AgentRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "status">;

/**
 * The persisted source-run fields this decision reads. Deliberately structural:
 * the recovery sweep holds a narrow run projection, and the continuation
 * counter is supplied by the caller from the field it actually reads (the run
 * column or its own persisted wake context), never assumed to exist here.
 */
export type RunnerTimeoutContinuationRun = {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  errorCode?: string | null;
  resultJson?: unknown;
};

export type RunnerTimeoutContinuationDecision =
  | {
      kind: "enqueue";
      nextAttempt: number;
      maxAttempts: number;
      idempotencyKey: string;
      resumeSessionId: string | null;
      instruction: string;
      extraContext: Record<string, unknown>;
    }
  | { kind: "exhausted"; attempt: number; maxAttempts: number; comment: string }
  /** This exact attempt already has a live continuation wake. A caller must not
   * fall through to any other continuation: that would create a second wake for
   * one source run and restart the bounded session chain from a fresh counter. */
  | { kind: "duplicate"; attempt: number; nextAttempt: number; idempotencyKey: string }
  | { kind: "skip"; reason: string };

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Reads the resumable evidence a timed-out contained run persisted in its
 * result payload, with the same strictness the adapter applied on the way in. */
export function readPersistedRunnerTimeout(run: {
  status?: string | null;
  resultJson?: unknown;
}): RunnerTimeoutEvidence | null {
  if (run.status !== "timed_out") return null;
  if (!run.resultJson || typeof run.resultJson !== "object" || Array.isArray(run.resultJson)) return null;
  const persisted = (run.resultJson as Record<string, unknown>).runnerTimeout;
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) return null;
  const record = persisted as Record<string, unknown>;
  if (record.modelStarted !== true) return null;
  const progress = record.progress && typeof record.progress === "object" && !Array.isArray(record.progress)
    ? (record.progress as Record<string, unknown>)
    : null;
  return {
    sessionId: readNonEmptyString(record.sessionId),
    modelStarted: true,
    resumable: record.resumable === true,
    progress: progress
      ? {
          requests: readCount(progress.requests),
          denials: readCount(progress.denials),
          lastRequestAt: readNonEmptyString(progress.lastRequestAt),
        }
      : null,
  };
}

export function buildRunnerTimeoutContinuationIdempotencyKey(input: {
  issueId: string;
  sourceRunId: string;
  nextAttempt: number;
}) {
  return [
    RUNNER_TIMEOUT_CONTINUATION_REASON,
    input.issueId,
    input.sourceRunId,
    String(input.nextAttempt),
  ].join(":");
}

export async function findExistingRunnerTimeoutContinuationWake(
  db: Db,
  input: { companyId: string; idempotencyKey: string },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, IDEMPOTENT_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/** The instruction that keeps the continuation inside its own receipt boundary. */
export function buildRunnerTimeoutContinuationInstruction(input: {
  sourceRunId: string;
  sessionId: string | null;
  requests: number;
}) {
  return [
    `Your previous run \`${input.sourceRunId}\` hit its execution timeout after ${input.requests} request(s) through the run proxy.`,
    input.sessionId
      ? `Resume the SAME session from its last checkpoint (\`${input.sessionId}\`); do not start the task over.`
      : "Resume from your last checkpoint; do not start the task over.",
    "Do not repeat external actions that already completed: their receipts are recorded natively and replaying them is a duplicate effect.",
    "The run timeout is unchanged; finish or record a durable next step within it, and report what remains if it does not fit.",
  ].join(" ");
}

export function decideRunnerTimeoutContinuation(input: {
  run: RunnerTimeoutContinuationRun;
  issue: IssueRow | null;
  agent: AgentRow | null;
  evidence: RunnerTimeoutEvidence | null;
  /** Persisted continuation counter for this run, read by the caller. */
  continuationAttempt: number;
  budgetBlocked: boolean;
  idempotentWakeExists: boolean;
  maxAttempts?: number;
}): RunnerTimeoutContinuationDecision {
  const { run, issue, agent, evidence } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_RUNNER_TIMEOUT_CONTINUATIONS;

  if (run.status !== "timed_out") return { kind: "skip", reason: "source run did not time out" };
  if (run.errorCode && run.errorCode !== "timeout") {
    return { kind: "skip", reason: `source run error code ${run.errorCode} is not a timeout` };
  }
  if (!evidence) return { kind: "skip", reason: "no contained-run timeout evidence was persisted" };
  if (!evidence.modelStarted) return { kind: "skip", reason: "the timed-out run never reached the model" };
  if (!evidence.resumable) return { kind: "skip", reason: "the timed-out run reported no resumable session" };
  const requests = evidence.progress?.requests ?? 0;
  if (requests < 1) return { kind: "skip", reason: "the timed-out run produced no progress to resume from" };
  if (!issue) return { kind: "skip", reason: "issue not found" };
  if (!agent) return { kind: "skip", reason: "agent not found" };
  if (issue.companyId !== run.companyId || agent.companyId !== run.companyId) {
    return { kind: "skip", reason: "company scope mismatch" };
  }
  if (issue.assigneeAgentId !== run.agentId) {
    return { kind: "skip", reason: "issue is no longer assigned to the source run agent" };
  }
  if (CONTINUABLE_ISSUE_STATUSES[issue.status] !== true) {
    return { kind: "skip", reason: `issue status ${issue.status} is not continuable` };
  }
  if (issue.executionState) return { kind: "skip", reason: "issue has execution policy state" };
  if (CONTINUABLE_AGENT_STATUSES[agent.status] !== true) {
    return { kind: "skip", reason: `agent status ${agent.status} is not invokable` };
  }
  if (input.budgetBlocked) return { kind: "skip", reason: "budget hard stop blocks continuation" };

  const currentAttempt = readContinuationAttempt(input.continuationAttempt);
  if (currentAttempt >= maxAttempts) {
    return {
      kind: "exhausted",
      attempt: currentAttempt,
      maxAttempts,
      comment: [
        "Bounded timeout continuation exhausted",
        "",
        `- Source run: \`${run.id}\` (timed out after ${requests} request(s))`,
        `- Attempts used: ${currentAttempt}/${maxAttempts}`,
        "- Next action: inspect the run's checkpoint evidence and either split the work or request an explicit decision; the timeout is not raised automatically.",
      ].join("\n"),
    };
  }

  const nextAttempt = currentAttempt + 1;
  const idempotencyKey = buildRunnerTimeoutContinuationIdempotencyKey({
    issueId: issue.id,
    sourceRunId: run.id,
    nextAttempt,
  });
  if (input.idempotentWakeExists) {
    return { kind: "duplicate", attempt: currentAttempt, nextAttempt, idempotencyKey };
  }
  const instruction = buildRunnerTimeoutContinuationInstruction({
    sourceRunId: run.id,
    sessionId: evidence.sessionId,
    requests,
  });
  return {
    kind: "enqueue",
    nextAttempt,
    maxAttempts,
    idempotencyKey,
    resumeSessionId: evidence.sessionId,
    instruction,
    extraContext: {
      runnerTimeoutContinuation: true,
      runnerTimeoutContinuationAttempt: nextAttempt,
      runnerTimeoutContinuationMaxAttempts: maxAttempts,
      runnerTimeoutSourceRunId: run.id,
      resumeFromCheckpoint: true,
      ...(evidence.sessionId ? { resumeSessionId: evidence.sessionId } : {}),
      instruction,
    },
  };
}
