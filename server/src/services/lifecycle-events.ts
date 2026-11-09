import { sql } from "drizzle-orm";
import { registerPostCommitHook, type Db, type heartbeatRuns, type issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { DbTransaction, HeartbeatRunStatusTransition } from "./heartbeat-run-lifecycle.js";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const TERMINAL_TASK_STATUSES = new Set(["done", "cancelled"]);

interface RunLifecycleEvent {
  eventType: "run_transition";
  eventId: string;
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  fromStatus: string;
  toStatus: string;
  terminal: boolean;
  cancellation: RunCancellation | null;
  transitionedAtEpochUs: string;
}

interface RunCancellation {
  code: string | null;
  reason: string | null;
  requestedBy: { type: string; id: string } | null;
}

interface TaskLifecycleEvent {
  eventType: "task_transition";
  eventId: string;
  issueId: string;
  identifier: string | null;
  companyId: string;
  projectId: string | null;
  fromStatus: string;
  toStatus: string;
  terminal: boolean;
  assignee: { type: "agent" | "user"; id: string } | null;
  actingRunId: string | null;
  transitionedAtEpochUs: string;
}

function logAfterCommit(tx: object, event: RunLifecycleEvent | TaskLifecycleEvent, message: string) {
  registerPostCommitHook(tx, () => {
    logger.info({ lifecycleEvent: event }, message);
  });
}

export function logRunTransitionAfterCommit(
  tx: DbTransaction,
  run: typeof heartbeatRuns.$inferSelect,
  transition: HeartbeatRunStatusTransition,
) {
  const issueId = run.nativeIssueId
    ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
  logAfterCommit(tx, {
    eventType: "run_transition",
    eventId: transition.eventId,
    runId: run.id,
    companyId: run.companyId,
    agentId: run.agentId,
    issueId,
    fromStatus: transition.fromStatus,
    toStatus: transition.toStatus,
    terminal: TERMINAL_RUN_STATUSES.has(transition.toStatus),
    cancellation: transition.toStatus === "cancelled" ? runCancellation(run) : null,
    transitionedAtEpochUs: transition.transitionedAtEpochUs,
  }, "heartbeat run status changed");
}

function runCancellation(run: typeof heartbeatRuns.$inferSelect): RunCancellation {
  const result = run.resultJson ?? {};
  const requester = (type: unknown, id: unknown) =>
    typeof type === "string" && typeof id === "string" && id ? { type, id } : null;
  return {
    code: run.errorCode,
    reason: run.error,
    requestedBy: requester(result.cancelledByActorType, result.cancelledByUserId)
      ?? requester(result.interruptedByActorType, result.interruptedByActorId),
  };
}

export async function logTaskTransitionAfterCommit(
  tx: Db | DbTransaction,
  before: typeof issues.$inferSelect,
  after: typeof issues.$inferSelect,
  actingRunId: string | null,
) {
  const [{ epochUs }] = await tx.execute<{ epochUs: string }>(
    sql`select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as "epochUs"`,
  );
  logAfterCommit(tx, {
    eventType: "task_transition",
    eventId: `task:${after.id}:${epochUs}:${after.status}`,
    issueId: after.id,
    identifier: after.identifier,
    companyId: after.companyId,
    projectId: after.projectId,
    fromStatus: before.status,
    toStatus: after.status,
    terminal: TERMINAL_TASK_STATUSES.has(after.status),
    assignee: after.assigneeAgentId
      ? { type: "agent", id: after.assigneeAgentId }
      : after.assigneeUserId
        ? { type: "user", id: after.assigneeUserId }
        : null,
    actingRunId,
    transitionedAtEpochUs: epochUs,
  }, "task status changed");
}
