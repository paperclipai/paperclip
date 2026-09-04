import { forbidden, notFound } from "../../../errors.js";
import type { WatchdogRunReader, WatchdogWriter } from "./ports.js";
import type { WatchdogDecisionActor, WatchdogDecisionRecord } from "./types.js";

const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = "stale_active_run_evaluation";

export type RecordWatchdogDecisionDeps = {
  reader: WatchdogRunReader;
  writer: WatchdogWriter;
  continueRearmMs: number;
};

export type RecordWatchdogDecisionUseCaseInput = {
  companyId: string;
  runId: string;
  actor: WatchdogDecisionActor;
  decision: "snooze" | "continue" | "dismissed_false_positive";
  evaluationIssueId?: string | null;
  reason?: string | null;
  snoozedUntil?: Date | null;
  createdByRunId?: string | null;
  now?: Date;
};

export function createRecordWatchdogDecision(deps: RecordWatchdogDecisionDeps) {
  return async function recordWatchdogDecision(
    input: RecordWatchdogDecisionUseCaseInput,
  ): Promise<WatchdogDecisionRecord> {
    const run = await deps.reader.findRunForCompany(input.companyId, input.runId);
    if (!run) throw notFound("Heartbeat run not found");

    const evaluationIssue = input.evaluationIssueId
      ? await deps.reader.findEvaluationIssueById(input.companyId, input.evaluationIssueId)
      : null;
    if (input.evaluationIssueId && !evaluationIssue) throw notFound("Evaluation issue not found");

    const boardActor = input.actor.type === "board";
    const assignedRecoveryOwner =
      input.actor.type === "agent" &&
      Boolean(input.actor.agentId) &&
      evaluationIssue !== null &&
      evaluationIssue.originKind === STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND &&
      evaluationIssue.originId === run.id &&
      evaluationIssue.hiddenAt === null &&
      !["done", "cancelled"].includes(evaluationIssue.status) &&
      evaluationIssue.assigneeAgentId === input.actor.agentId;
    if (!boardActor && !assignedRecoveryOwner) {
      throw forbidden("Only the board or the assigned recovery owner can record watchdog decisions");
    }

    if (evaluationIssue && (
      evaluationIssue.originKind !== STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND ||
      evaluationIssue.originId !== run.id
    )) {
      throw forbidden("Watchdog decision evaluation issue is not bound to the target run");
    }

    if (input.actor.type === "agent" && !evaluationIssue) {
      throw forbidden("Agent watchdog decisions require the target evaluation issue");
    }

    const createdByRunId = input.actor.type === "agent"
      ? input.actor.runId ?? input.createdByRunId ?? null
      : input.actor.type === "board"
        ? input.actor.runId ?? input.createdByRunId ?? null
        : null;
    if (createdByRunId) {
      const creatorRun = await deps.reader.findRunForCompany(input.companyId, createdByRunId);
      const sameAgent = input.actor.type !== "agent" || creatorRun?.agentId === input.actor.agentId;
      if (!creatorRun || !sameAgent) {
        throw forbidden("createdByRunId is not valid for this watchdog decision actor");
      }
    }

    const decisionNow = input.now ?? new Date();
    const effectiveSnoozedUntil = input.decision === "snooze"
      ? input.snoozedUntil ?? null
      : input.decision === "continue"
        ? input.snoozedUntil && input.snoozedUntil > decisionNow
          ? input.snoozedUntil
          : new Date(decisionNow.getTime() + deps.continueRearmMs)
        : null;

    return deps.writer.recordDecision(input.companyId, {
      runId: run.id,
      actor: input.actor,
      evaluationIssueId: input.evaluationIssueId ?? null,
      decision: input.decision,
      snoozedUntil: effectiveSnoozedUntil,
      reason: input.reason ?? null,
      createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
      createdByRunId,
    });
  };
}
