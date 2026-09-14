import { and, asc, desc, eq, gt, gte, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { parseObject } from "../../../adapters/utils.js";
import { visibleIssueCondition } from "../../../services/issue-visibility.js";
import { logActivity } from "../../../services/activity-log.js";
import { appendHeartbeatRunEvent } from "../../../services/heartbeat-run-events.js";
import { emitAgentTaskRun } from "../../../services/agent-task-run-telemetry.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "../../../services/issues.js";
import { issueRecoveryActionService } from "../../../services/issue-recovery-actions.js";
import { RECOVERY_ORIGIN_KINDS } from "../../../services/recovery/origins.js";
import { isTerminalIssueStatus } from "../domain/policy.js";
import type { WatchdogRunReader, WatchdogWriter } from "../application/ports.js";
import type {
  EvaluationIssueSnapshot,
  FoldOutcome,
  FoldSourceResolvedRunInput,
  RecordDecisionInput,
  RunSnapshot,
  SourceIssueSnapshot,
  WatchdogDecisionRecord,
} from "../application/types.js";

const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
const RECOVERY_ORIGIN_KIND_VALUES = new Set<string>(Object.values(RECOVERY_ORIGIN_KINDS));

function isRecoveryOriginKind(originKind: string | null): boolean {
  return originKind !== null && RECOVERY_ORIGIN_KIND_VALUES.has(originKind);
}

function issueContextId(contextSnapshot: unknown): string | null {
  const context = parseObject(contextSnapshot);
  const issueId = context.issueId ?? context.taskId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

function toRunSnapshot(row: typeof heartbeatRuns.$inferSelect): RunSnapshot {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    status: row.status,
    lastOutputAt: row.lastOutputAt,
    lastOutputSeq: row.lastOutputSeq,
    lastOutputStream: row.lastOutputStream,
    processStartedAt: row.processStartedAt,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
    sourceIssueId: issueContextId(row.contextSnapshot),
    resultJson: row.resultJson,
    wakeupRequestId: row.wakeupRequestId,
    processPid: row.processPid,
    processGroupId: row.processGroupId,
  };
}

export function createPostgresWatchdogAdapter(db: Db): WatchdogRunReader & WatchdogWriter {
  const issuesSvc = issueService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);

  async function findCandidateSilentRuns(input: {
    companyId?: string;
    suspicionBefore: Date;
    issueCreatedAtGte?: Date | null;
  }): Promise<RunSnapshot[]> {
    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          input.companyId ? eq(heartbeatRuns.companyId, input.companyId) : undefined,
          eq(heartbeatRuns.status, "running"),
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.processStartedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${input.suspicionBefore.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(100);

    let candidates = rows.map(toRunSnapshot);

    if (input.issueCreatedAtGte) {
      const issueCreatedAtGte = input.issueCreatedAtGte;
      const issueIds = [...new Set(candidates.flatMap((run) => {
        return run.sourceIssueId ? [run.sourceIssueId] : [];
      }))];
      const eligibleIssueIds = new Set(
        issueIds.length > 0
          ? (await db.select({ id: issues.id }).from(issues).where(and(
              inArray(issues.id, issueIds),
              gte(issues.createdAt, issueCreatedAtGte),
            ))).map((issue) => issue.id)
          : [],
      );
      candidates = candidates.filter((run) => {
        return run.sourceIssueId !== null && eligibleIssueIds.has(run.sourceIssueId);
      });
    }

    return candidates;
  }

  async function findRunForCompany(companyId: string, runId: string): Promise<RunSnapshot | null> {
    const [row] = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
      .limit(1);
    return row ? toRunSnapshot(row) : null;
  }

  async function findLatestDecision(companyId: string, runId: string, now: Date) {
    const [quietUntilRows, dismissedRows] = await Promise.all([
      db
        .select({
          decision: heartbeatRunWatchdogDecisions.decision,
          snoozedUntil: heartbeatRunWatchdogDecisions.snoozedUntil,
        })
        .from(heartbeatRunWatchdogDecisions)
        .where(
          and(
            eq(heartbeatRunWatchdogDecisions.companyId, companyId),
            eq(heartbeatRunWatchdogDecisions.runId, runId),
            inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
            gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
          ),
        )
        .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
        .limit(1),
      db
        .select({ id: heartbeatRunWatchdogDecisions.id })
        .from(heartbeatRunWatchdogDecisions)
        .where(
          and(
            eq(heartbeatRunWatchdogDecisions.companyId, companyId),
            eq(heartbeatRunWatchdogDecisions.runId, runId),
            eq(heartbeatRunWatchdogDecisions.decision, "dismissed_false_positive"),
          ),
        )
        .limit(1),
    ]);
    const quietUntilRow = quietUntilRows[0];
    return {
      dismissedFalsePositive: dismissedRows.length > 0,
      quietUntilDecision: quietUntilRow && quietUntilRow.snoozedUntil
        ? { decision: quietUntilRow.decision as "snooze" | "continue", snoozedUntil: quietUntilRow.snoozedUntil }
        : null,
    };
  }

  function selectEvaluationIssueSnapshot() {
    return {
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      companyId: issues.companyId,
      originKind: issues.originKind,
      originId: issues.originId,
      hiddenAt: issues.hiddenAt,
    };
  }

  async function findOpenStaleRunEvaluation(companyId: string, runId: string): Promise<EvaluationIssueSnapshot | null> {
    const [row] = await db
      .select(selectEvaluationIssueSnapshot())
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function findEvaluationIssueById(companyId: string, issueId: string): Promise<EvaluationIssueSnapshot | null> {
    const [row] = await db
      .select(selectEvaluationIssueSnapshot())
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .limit(1);
    return row ?? null;
  }

  async function findLatestSameRunTerminalEvidence(companyId: string, input: {
    runId: string;
    sourceIssueId: string;
    sourceIssueStatus: string;
    evidenceAfter: Date | null;
  }) {
    if (!isTerminalIssueStatus(input.sourceIssueStatus)) return null;
    const activityPredicates = [
      eq(activityLog.companyId, companyId),
      eq(activityLog.runId, input.runId),
      eq(activityLog.action, "issue.updated"),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.sourceIssueId),
      sql`${activityLog.details} ->> 'status' = ${input.sourceIssueStatus}`,
    ];
    if (input.evidenceAfter) {
      activityPredicates.push(gte(activityLog.createdAt, input.evidenceAfter));
    }

    const activity = await db
      .select({ id: activityLog.id, createdAt: activityLog.createdAt, action: activityLog.action })
      .from(activityLog)
      .where(and(...activityPredicates))
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    return activity ? { kind: "activity" as const, id: activity.id, createdAt: activity.createdAt, action: activity.action } : null;
  }

  async function findSourceIssue(companyId: string, issueId: string): Promise<SourceIssueSnapshot | null> {
    const [row] = await db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status, originKind: issues.originKind })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), visibleIssueCondition()))
      .limit(1);
    return row ? { ...row, isRecoveryOriginKind: isRecoveryOriginKind(row.originKind) } : null;
  }

  async function findRunningAgent(companyId: string, agentId: string) {
    const [row] = await db
      .select({ id: agents.id, companyId: agents.companyId, adapterType: agents.adapterType })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .limit(1);
    return row ?? null;
  }

  async function recordDecision(companyId: string, input: RecordDecisionInput): Promise<WatchdogDecisionRecord> {
    const [row] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId,
        runId: input.runId,
        evaluationIssueId: input.evaluationIssueId,
        decision: input.decision,
        snoozedUntil: input.snoozedUntil,
        reason: input.reason,
        createdByAgentId: input.createdByAgentId,
        createdByUserId: input.createdByUserId,
        createdByRunId: input.createdByRunId,
      })
      .returning();

    await logActivity(db, {
      companyId,
      actorType: input.actor.type === "agent" ? "agent" : "user",
      actorId: input.actor.type === "agent"
        ? input.actor.agentId ?? "agent"
        : input.actor.type === "board"
          ? input.actor.userId ?? "board"
          : "unknown",
      agentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      runId: input.runId,
      action: input.decision === "snooze" ? "heartbeat.watchdog_snoozed" : "heartbeat.watchdog_decision_recorded",
      entityType: "heartbeat_run",
      entityId: input.runId,
      details: {
        source: "recovery.record_watchdog_decision",
        decision: input.decision,
        evaluationIssueId: input.evaluationIssueId,
        snoozedUntil: input.snoozedUntil?.toISOString() ?? null,
        reason: input.reason,
      },
    });

    return { ...row, decision: row.decision as WatchdogDecisionRecord["decision"] };
  }

  async function foldSourceResolvedRun(companyId: string, input: FoldSourceResolvedRunInput): Promise<FoldOutcome> {
    const finalRunStatus = input.sourceIssue.status === "cancelled" ? "cancelled" : "succeeded";
    const postCommitIssueActions: IssuePostCommitAction[] = [];
    const resultJson = {
      ...parseObject(input.run.resultJson),
      sourceResolvedWatchdogFold: {
        sourceIssueId: input.sourceIssue.id,
        sourceIssueIdentifier: input.sourceIssue.identifier,
        sourceIssueStatus: input.sourceIssue.status,
        sameRunEvidenceKind: input.evidence.kind,
        sameRunEvidenceId: input.evidence.id,
        sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
        silenceStartedAt: input.silenceStartedAt?.toISOString() ?? null,
        silenceAgeMs: input.silenceAgeMs,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        evaluationIssueIdentifier: input.existingEvaluation?.identifier ?? null,
        cleanup: input.cleanup,
      },
    };

    const transactionResult = await db.transaction(async (tx) => {
      const [updatedRun] = await tx
        .update(heartbeatRuns)
        .set({
          status: finalRunStatus,
          finishedAt: input.now,
          error: null,
          errorCode: null,
          resultJson,
          updatedAt: input.now,
        })
        .where(and(
          eq(heartbeatRuns.id, input.run.id),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "running"),
        ))
        .returning();
      if (!updatedRun) return null;

      if (input.run.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: finalRunStatus === "succeeded" ? "completed" : "cancelled",
            finishedAt: input.now,
            error: null,
            updatedAt: input.now,
          })
          .where(and(
            eq(agentWakeupRequests.id, input.run.wakeupRequestId),
            eq(agentWakeupRequests.companyId, companyId),
          ));
      }

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: input.now,
        })
        .where(and(
          eq(issues.id, input.sourceIssue.id),
          eq(issues.companyId, companyId),
          eq(issues.executionRunId, input.run.id),
        ));

      if (input.existingEvaluation && !isTerminalIssueStatus(input.existingEvaluation.status)) {
        const updatedEvaluation = await issuesSvc.update(
          input.existingEvaluation.id,
          { status: "done" },
          tx,
          undefined,
          postCommitIssueActions,
        );
        if (!updatedEvaluation) {
          throw new Error("Evaluation issue disappeared during source-resolved watchdog fold");
        }
        await issuesSvc.addComment(input.existingEvaluation.id, [
          "Source-resolved watchdog fold.",
          "",
          `- Source issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
          `- Run: \`${input.run.id}\``,
          `- Same-run evidence: \`${input.evidence.kind}:${input.evidence.id}\` at ${input.evidence.createdAt.toISOString()}`,
          "- Outcome: false positive; the source issue already reached a terminal disposition from this run.",
        ].join("\n"), { runId: input.run.id }, undefined, tx);
      }

      const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(
        companyId,
        input.sourceIssue.id,
        tx,
      );
      if (activeRecoveryAction?.kind === "active_run_watchdog") {
        await recoveryActionsSvc.resolveActiveForIssue({
          companyId,
          sourceIssueId: input.sourceIssue.id,
          actionId: activeRecoveryAction.id,
          status: "resolved",
          outcome: "false_positive",
          resolutionNote: "Source issue reached a terminal disposition through durable same-run activity; watchdog folded as source-resolved.",
        }, tx);
      }

      const [decision] = await tx
        .insert(heartbeatRunWatchdogDecisions)
        .values({
          companyId,
          runId: input.run.id,
          evaluationIssueId: input.existingEvaluation?.id ?? null,
          decision: "dismissed_false_positive",
          reason: "Source issue already reached a terminal disposition through durable same-run activity.",
          createdByRunId: input.run.id,
        })
        .returning();

      await appendHeartbeatRunEvent(tx as unknown as Db, {
        companyId,
        runId: input.run.id,
        agentId: input.run.agentId,
        eventType: "lifecycle",
        stream: "system",
        level: input.cleanup.outcome === "failed" ? "warn" : "info",
        message: "Source-resolved watchdog fold finalized stale active run",
        payload: resultJson.sourceResolvedWatchdogFold,
      });

      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: "system",
        actorId: "system",
        agentId: input.run.agentId,
        runId: input.run.id,
        action: "heartbeat.output_stale_source_resolved",
        entityType: "heartbeat_run",
        entityId: input.run.id,
        details: {
          source: "recovery.scan_silent_active_runs",
          sourceIssueId: input.sourceIssue.id,
          sourceIssueIdentifier: input.sourceIssue.identifier,
          sourceIssueStatus: input.sourceIssue.status,
          evaluationIssueId: input.existingEvaluation?.id ?? null,
          watchdogDecisionId: decision.id,
          sameRunEvidenceKind: input.evidence.kind,
          sameRunEvidenceId: input.evidence.id,
          sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
          cleanup: input.cleanup,
        },
      });

      const [runningCountRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, input.run.agentId),
          eq(heartbeatRuns.status, "running"),
        ));
      const runningCount = Number(runningCountRow?.count ?? 0);
      const nextAgentStatus = runningCount > 0 ? "running" : "idle";
      await tx
        .update(agents)
        .set({ status: nextAgentStatus, lastHeartbeatAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(agents.id, input.run.agentId),
          eq(agents.companyId, companyId),
          notInArray(agents.status, ["paused", "terminated"]),
        ));

      return updatedRun;
    });

    if (!transactionResult) return { kind: "stale" };
    const finalizedRun = transactionResult;

    await executeIssuePostCommitActions(db, postCommitIssueActions);

    // Telemetry is best-effort background work; it must not delay the
    // watchdog fold's caller, so fire it and do not await it.
    void emitAgentTaskRun(db, finalizedRun);

    return { kind: "folded", evaluationIssueId: input.existingEvaluation?.id ?? null };
  }

  return {
    findCandidateSilentRuns,
    findRunForCompany,
    findLatestDecision,
    findOpenStaleRunEvaluation,
    findEvaluationIssueById,
    findLatestSameRunTerminalEvidence,
    findSourceIssue,
    findRunningAgent,
    recordDecision,
    foldSourceResolvedRun,
  };
}
