import { and, eq, inArray } from "drizzle-orm";
import { caseHandoffs, heartbeatRuns, type Db } from "@paperclipai/db";
import { forbidden } from "./errors.js";

/** Stop revokes write authority before waiting for the executor to settle.
 * A run that a fresh continuation replaced loses it too: its agent may still
 * be alive in an unreachable sandbox, and only the new run acts on the task. */
export function agentRunWritesRevoked(run: {
  status: string;
  resultJson?: Record<string, unknown> | null;
} | null | undefined): boolean {
  const cancellation = run?.resultJson?.executionCancellation;
  return run?.status === "cancelled" || agentRunSupersededByFreshContinuation(run) || Boolean(cancellation && typeof cancellation === "object"
    && "state" in cancellation && cancellation.state === "requested");
}

/** Recorded by the fresh-continuation fallback on the run it replaced. */
export const FRESH_CONTINUATION_SUPERSEDED_KEY = "freshContinuationSupersededAt";

export function agentRunSupersededByFreshContinuation(run: { resultJson?: Record<string, unknown> | null } | null | undefined) {
  return typeof run?.resultJson?.[FRESH_CONTINUATION_SUPERSEDED_KEY] === "string";
}

/** The caller must supply its write transaction, so Stop and commit serialize. */
export async function assertAgentRunWriteAllowed(tx: Db, companyId: string, actor: {
  agentId?: string | null;
  runId?: string | null;
  stopId?: string | null;
}) {
  if (!actor.agentId || !actor.runId) return;
  const [run] = await tx.select({ status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson,
    runtimeMode: heartbeatRuns.runtimeMode, companyId: heartbeatRuns.companyId,
    contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId)))
    .for("share");
  const stoppedForThisMutation = run?.status === "cancelled" && actor.stopId &&
    run.resultJson?.issueMutationStopId === actor.stopId;
  if (agentRunSupersededByFreshContinuation(run)) {
    throw forbidden("A newer run continues this task. End the turn.", { code: "agent_run_superseded" });
  }
  if (agentRunWritesRevoked(run) && !stoppedForThisMutation) {
    throw forbidden("This run was cancelled", { code: "agent_run_cancelled" });
  }
  const [handoff] = await tx.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(
    eq(caseHandoffs.companyId, companyId), eq(caseHandoffs.sourceRunId, actor.runId),
    inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch", "delivered"]),
  )).limit(1);
  if (handoff) throw forbidden("This run handed off its task. End the turn.", { code: "case_handoff_run_yielded", handoffId: handoff.id });
  return run;
}
