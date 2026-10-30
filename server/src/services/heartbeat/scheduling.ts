import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { notifyIssueReviewState } from "../issue-review-state-notifications.js";
import { insertIssueComment } from "../issue-comment-writes.js";
import {
  issues,
  issueComments,
  heartbeatRuns,
  nativeRunFinalizations,
  companies,
  agentTaskSessions,
  agentWakeupRequests,
  agentSessionGoalActions,
  agents,
  activityLog,
} from "@paperclipai/db";
import {
  type IssueExecutionMonitorPolicy,
  type IssueExecutionMonitorClearReason,
  type IssueExecutionMonitorRecoveryPolicy,
  PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
  EXECUTION_RECONCILIATION_CAUSES,
  isUuidLike,
} from "@paperclipai/shared";
import {
  and,
  eq,
  notInArray,
  desc,
  sql,
  isNull,
  inArray,
  or,
  lt,
  lte,
  asc,
  getTableColumns,
  gte,
} from "drizzle-orm";
import { RECOVERY_ORIGIN_KINDS } from "../recovery/index.js";
import { visibleIssueCondition } from "../issue-visibility.js";
import { REVIEW_PATH_RECOVERY_INSTRUCTION } from "../recovery/review-path-recovery.js";
import { withRecoveryContext } from "../recovery/status-only-context.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import {
  normalizeIssueExecutionPolicy,
  buildIssueMonitorClearedPatch,
  parseIssueExecutionState,
  buildIssueMonitorTriggeredPatch,
} from "../issue-execution-policy.js";
import { conflict, HttpError, notFound } from "../../errors.js";
import { EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON } from "./run-state.js";
import { parseObject } from "../../adapters/utils.js";
import {
  legacyExecutionNeedsReconciliationWithEvidence,
  terminalizeLegacyExecution,
} from "../legacy-execution-recovery.js";
import { logger } from "../../middleware/logger.js";
import { failRunnerGoalAction } from "../runner-goals.js";
import { evaluateAgentInvokability } from "../agent-invokability.js";
import { supportsUnscopedTimerHeartbeat } from "../heartbeat-policy.js";
import type { Db } from "@paperclipai/db";
import type { issueService } from "../issues.js";
import type { createHeartbeatQueue } from "./queue.js";
import type { createHeartbeatRetries, HeartbeatRetryDependencies } from "./retries.js";
import type { createHeartbeatRunPreparation } from "./run-preparation.js";
import type { NativeSessionGoalControl } from "../../vendor/paperclip-runner/index.js";

type HeartbeatQueue = ReturnType<typeof createHeartbeatQueue>;
type RunPreparation = ReturnType<typeof createHeartbeatRunPreparation>;

export interface HeartbeatSchedulingDependencies
  extends Pick<HeartbeatRetryDependencies, "getRun" | "getAgent" | "getWorktreeExecutionCutoff">,
    Pick<HeartbeatQueue, "enqueueWakeup" | "parseHeartbeatPolicy" | "nextTimerHeartbeatAt" | "claimDueTimerHeartbeat">,
    Pick<RunPreparation, "toAgentOrgRow" | "groupAgentOrgRowsByCompany"> {
  issuesSvc: Pick<ReturnType<typeof issueService>, "listReviewAttention" | "create">;
  scheduleBoundedRetryForRun: ReturnType<typeof createHeartbeatRetries>["scheduleBoundedRetryForRun"];
  getSchedulingSuppression: (fresh?: boolean) => Promise<{ suppressed: boolean }>;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseNativeSessionGoalControl(
  value: unknown,
): NativeSessionGoalControl | null {
  const candidate = parseObject(value);
  const requestId = readNonEmptyString(candidate.requestId);
  const action = readNonEmptyString(candidate.action);
  if (
    !requestId ||
    !action ||
    !["create", "edit", "replace", "pause", "resume", "clear"].includes(action)
  )
    return null;
  const objective = readNonEmptyString(candidate.objective);
  const tokenBudget =
    candidate.tokenBudget === null
      ? null
      : typeof candidate.tokenBudget === "number" &&
          Number.isSafeInteger(candidate.tokenBudget) &&
          candidate.tokenBudget > 0
        ? candidate.tokenBudget
        : undefined;
  return {
    requestId,
    action: action as NativeSessionGoalControl["action"],
    ...(objective ? { objective } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}

export function formatIssueIdentifierLink(
  identifier: string | null,
  fallback: string,
) {
  if (!identifier) return fallback;
  const prefix = identifier.split("-")[0];
  if (!prefix || !/^[A-Z][A-Z0-9]*-\d+$/.test(identifier)) return identifier;
  return `[${identifier}](/${prefix}/issues/${identifier})`;
}

const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON =
  "execution_review_participant_recovery";

// Construction only binds dependencies. Scheduler calls retain the existing queue admission gates.
export function createHeartbeatScheduling(
  db: Db,
  dependencies: HeartbeatSchedulingDependencies,
) {
  const {
    issuesSvc,
    enqueueWakeup,
    getRun,
    getAgent,
    scheduleBoundedRetryForRun,
    getSchedulingSuppression,
    getWorktreeExecutionCutoff,
    toAgentOrgRow,
    groupAgentOrgRowsByCompany,
    parseHeartbeatPolicy,
    nextTimerHeartbeatAt,
    claimDueTimerHeartbeat,
  } = dependencies;

  const issueMonitorDispatchColumns = {
    id: issues.id,
    companyId: issues.companyId,
    projectId: issues.projectId,
    goalId: issues.goalId,
    identifier: issues.identifier,
    title: issues.title,
    status: issues.status,
    priority: issues.priority,
    assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId,
    billingCode: issues.billingCode,
    executionPolicy: issues.executionPolicy,
    executionState: issues.executionState,
    monitorNextCheckAt: issues.monitorNextCheckAt,
    monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
    monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
    monitorAttemptCount: issues.monitorAttemptCount,
    monitorNotes: issues.monitorNotes,
    monitorScheduledBy: issues.monitorScheduledBy,
  };

  interface IssueMonitorDispatchRow {
    id: string;
    companyId: string;
    projectId: string | null;
    goalId: string | null;
    identifier: string | null;
    title: string;
    status: string;
    priority: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    billingCode: string | null;
    executionPolicy: Record<string, unknown> | null;
    executionState: Record<string, unknown> | null;
    monitorNextCheckAt: Date | null;
    monitorWakeRequestedAt: Date | null;
    monitorLastTriggeredAt: Date | null;
    monitorAttemptCount: number | null;
    monitorNotes: string | null;
    monitorScheduledBy: string | null;
  }

  function parseMonitorDate(value: string | null | undefined) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function issueMonitorLimitClearReason(input: {
    monitor: IssueExecutionMonitorPolicy | null;
    nextAttemptCount: number;
    now: Date;
  }): IssueExecutionMonitorClearReason | null {
    const timeoutAt = parseMonitorDate(input.monitor?.timeoutAt ?? null);
    if (timeoutAt && input.now.getTime() >= timeoutAt.getTime()) {
      return "timeout_exceeded";
    }
    const maxAttempts = input.monitor?.maxAttempts ?? null;
    if (maxAttempts !== null && input.nextAttemptCount > maxAttempts) {
      return "max_attempts_exhausted";
    }
    return null;
  }

  function monitorRecoveryPolicy(
    monitor: IssueExecutionMonitorPolicy | null,
  ): IssueExecutionMonitorRecoveryPolicy {
    return monitor?.recoveryPolicy ?? "wake_owner";
  }

  function monitorRecoveryDetails(input: {
    claimed: IssueMonitorDispatchRow;
    scheduledAtIso: string;
    nextAttemptCount: number;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    monitor: IssueExecutionMonitorPolicy | null;
    source: "manual" | "scheduled";
  }) {
    return {
      identifier: input.claimed.identifier,
      nextCheckAt: input.scheduledAtIso,
      attemptedAttemptCount: input.nextAttemptCount,
      notes: input.claimed.monitorNotes ?? null,
      serviceName: input.monitor?.serviceName ?? null,
      timeoutAt: input.monitor?.timeoutAt ?? null,
      maxAttempts: input.monitor?.maxAttempts ?? null,
      clearReason: input.clearReason,
      recoveryPolicy: input.recoveryPolicy,
      source: input.source,
    };
  }


  function monitorRecoveryComment(input: {
    issue: IssueMonitorDispatchRow;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    nextAttemptCount: number;
  }) {
    const label = formatIssueIdentifierLink(
      input.issue.identifier,
      input.issue.id,
    );
    const reason =
      input.clearReason === "timeout_exceeded"
        ? "its timeout was reached"
        : "its maximum attempt count was reached";
    return [
      `Paperclip cleared the scheduled external-service monitor for ${label} because ${reason}.`,
      "",
      `- Attempt count: ${input.nextAttemptCount}`,
      `- Recovery policy: ${input.recoveryPolicy}`,
      "",
      "Next action: inspect the external service state, record the result on this issue, and restore an explicit execution or waiting path if more work remains.",
    ].join("\n");
  }

  async function findOpenIssueMonitorRecoveryIssue(
    claimed: IssueMonitorDispatchRow,
  ) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, claimed.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.strandedIssueRecovery),
          eq(issues.originId, claimed.id),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function performIssueMonitorRecovery(input: {
    claimed: IssueMonitorDispatchRow;
    scheduledAtIso: string;
    nextAttemptCount: number;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    monitor: IssueExecutionMonitorPolicy | null;
    actorType: "user" | "agent" | "system";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    activitySource: "manual" | "scheduled";
  }) {
    const reviewPathLost =
      input.claimed.status === "in_review" &&
      (await issuesSvc
        .listReviewAttention(input.claimed.companyId, [input.claimed])
        .then(
          (attention) => attention.get(input.claimed.id)?.state === "stalled",
        ));
    const reviewPathContext = reviewPathLost
      ? {
          reviewPathLost: true,
          reviewPathConsumedRef: `monitor:${input.claimed.id}:${input.clearReason}:${input.scheduledAtIso}`,
          reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
        }
      : null;
    const details = monitorRecoveryDetails({
      claimed: input.claimed,
      scheduledAtIso: input.scheduledAtIso,
      nextAttemptCount: input.nextAttemptCount,
      clearReason: input.clearReason,
      recoveryPolicy: input.recoveryPolicy,
      monitor: input.monitor,
      source: input.activitySource,
    });

    if (input.recoveryPolicy === "create_recovery_issue") {
      let recoveryIssue = await findOpenIssueMonitorRecoveryIssue(
        input.claimed,
      );
      if (!recoveryIssue) {
        recoveryIssue = await issuesSvc.create(input.claimed.companyId, {
          title: `Recover external-service monitor for ${input.claimed.identifier ?? input.claimed.title}`,
          description: monitorRecoveryComment({
            issue: input.claimed,
            clearReason: input.clearReason,
            recoveryPolicy: input.recoveryPolicy,
            nextAttemptCount: input.nextAttemptCount,
          }),
          status: "todo",
          priority: "high",
          parentId: input.claimed.id,
          projectId: input.claimed.projectId,
          goalId: input.claimed.goalId,
          assigneeAgentId: input.claimed.assigneeAgentId,
          originKind: RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
          originId: input.claimed.id,
          originFingerprint: `issue_monitor:${input.clearReason}`,
          billingCode: input.claimed.billingCode,
        });
      }

      if (recoveryIssue.assigneeAgentId) {
        await enqueueWakeup(recoveryIssue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_monitor_recovery_issue",
          idempotencyKey: `issue-monitor-recovery-issue:${input.claimed.id}:${input.clearReason}:${input.scheduledAtIso}`,
          payload: withRecoveryContext(
            { issueId: recoveryIssue.id, sourceIssueId: input.claimed.id },
            "status_only",
          ),
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          contextSnapshot: withRecoveryContext(
            {
              issueId: recoveryIssue.id,
              sourceIssueId: input.claimed.id,
              source: "issue.monitor.recovery_issue",
              wakeReason: "issue_monitor_recovery_issue",
            },
            "status_only",
          ),
        });
      }

      await logActivity(db, {
        companyId: input.claimed.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: "issue.monitor_recovery_issue_created",
        entityType: "issue",
        entityId: input.claimed.id,
        details: {
          ...details,
          recoveryIssueId: recoveryIssue.id,
          recoveryIdentifier: recoveryIssue.identifier,
        },
      });
      return;
    }

    const recoveryKey = `issue-monitor-recovery:${input.claimed.id}:${input.scheduledAtIso}`;


    const acceptedRecoveryKeys = [
      recoveryKey,
      `issue-monitor-recovery:${input.claimed.id}:max_attempts_exhausted:${input.scheduledAtIso}`,
      `issue-monitor-recovery:${input.claimed.id}:timeout_exceeded:${input.scheduledAtIso}`,
    ];



    const [accepted] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, agentWakeupRequests.runId),
        eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
        eq(heartbeatRuns.agentId, agentWakeupRequests.agentId),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId',
          ${heartbeatRuns.nativeIssueId}::text) = ${input.claimed.id}`))
      .where(and(eq(agentWakeupRequests.companyId, input.claimed.companyId),
        eq(agentWakeupRequests.agentId, input.claimed.assigneeAgentId!),
        inArray(agentWakeupRequests.idempotencyKey, acceptedRecoveryKeys),
        inArray(agentWakeupRequests.reason, ["issue_monitor_recovery", "issue_execution_same_name"]),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${input.claimed.id}`,
        sql`${agentWakeupRequests.status} <> 'skipped'`)).limit(1);
    const wake = accepted ?? await enqueueWakeup(input.claimed.assigneeAgentId!, {
      issueStateGuard: { statuses: [input.claimed.status], assigneeAgentId: input.claimed.assigneeAgentId!,
        monitorNextCheckAt: input.scheduledAtIso,
        monitorWakeRequestedAt: input.claimed.monitorWakeRequestedAt!.toISOString() },
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_recovery",
      idempotencyKey: recoveryKey,
      payload: withRecoveryContext(
        {
          issueId: input.claimed.id,
          monitorAttemptCount: input.nextAttemptCount,
          monitorNotes: input.claimed.monitorNotes ?? null,
          clearReason: input.clearReason,
          serviceName: input.monitor?.serviceName ?? null,
          timeoutAt: input.monitor?.timeoutAt ?? null,
          maxAttempts: input.monitor?.maxAttempts ?? null,
          ...(reviewPathContext ?? {}),
        },
        "status_only",
      ),
      requestedByActorType: input.actorType,
      requestedByActorId: input.actorId,
      contextSnapshot: withRecoveryContext(
        {
          issueId: input.claimed.id,
          source: "issue.monitor.recovery",
          wakeReason: "issue_monitor_recovery",
          monitorAttemptCount: input.nextAttemptCount,
          monitorNotes: input.claimed.monitorNotes ?? null,
          clearReason: input.clearReason,
          serviceName: input.monitor?.serviceName ?? null,
          timeoutAt: input.monitor?.timeoutAt ?? null,
          maxAttempts: input.monitor?.maxAttempts ?? null,
          ...(reviewPathContext ?? {}),
        },
        "status_only",
      ),
    });

    if (!wake) return false;

    await logActivity(db, {
      companyId: input.claimed.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.monitor_recovery_wake_queued",
      entityType: "issue",
      entityId: input.claimed.id,
      details,
    });
    return true;
  }

  async function clearIssueMonitorAndRecover(input: {
    claimed: IssueMonitorDispatchRow;
    policy: ReturnType<typeof normalizeIssueExecutionPolicy>;
    scheduledAtIso: string;
    nextAttemptCount: number;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    monitor: IssueExecutionMonitorPolicy | null;
    now: Date;
    actorType: "user" | "agent" | "system";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    activitySource: "manual" | "scheduled";
  }) {
    const recover = () => performIssueMonitorRecovery(input);
    if (input.recoveryPolicy === "wake_owner") {
      try {
        if (!await recover()) {
          await releaseIssueMonitorWithDiagnostic(input.claimed, input, {
            action: "issue.monitor_deferred", reason: "monitor_recovery_deferred",
          });
          return { outcome: "skipped" as const, reason: "monitor_recovery_deferred" };
        }
      } catch (error) {
        await releaseIssueMonitorWithDiagnostic(input.claimed, input, {
          action: "issue.monitor_dispatch_failed", reason: "monitor_recovery_failed",
        });
        throw error;
      }
    }




    const publications: ActivityPublication[] = [];
    const cleared = await db.transaction(async tx => {
      await notifyIssueReviewState(tx, { companyId: input.claimed.companyId, issueId: input.claimed.id });
      const rows = await tx.update(issues).set({
        ...monitorOnlyDispatchPatch(buildIssueMonitorClearedPatch({
          issue: input.claimed, policy: input.policy, clearReason: input.clearReason, clearedAt: input.now,
        })),
        updatedAt: input.now,
      }).where(issueMonitorClaimCondition(input.claimed)).returning({ id: issues.id });
      if (rows.length && input.recoveryPolicy === "escalate_to_board") {
        await insertIssueComment(tx, {
          companyId: input.claimed.companyId,
          issueId: input.claimed.id,
          body: monitorRecoveryComment({
            issue: input.claimed,
            clearReason: input.clearReason,
            recoveryPolicy: input.recoveryPolicy,
            nextAttemptCount: input.nextAttemptCount,
          }),
        });

        await logActivity(tx as unknown as Db, {
          companyId: input.claimed.companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          agentId: input.agentId,
          runId: input.runId,
          action: "issue.monitor_escalated_to_board",
          entityType: "issue",
          entityId: input.claimed.id,
          details: monitorRecoveryDetails({ ...input, source: input.activitySource }),
        }, publications);
      }

      return rows;
    });
    for (const publication of publications) publishActivity(publication);
    if (cleared.length === 0) return { outcome: "skipped" as const, reason: "monitor_replaced" };

    await logActivity(db, {
      companyId: input.claimed.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.monitor_exhausted",
      entityType: "issue",
      entityId: input.claimed.id,
      details: monitorRecoveryDetails({
        claimed: input.claimed,
        scheduledAtIso: input.scheduledAtIso,
        nextAttemptCount: input.nextAttemptCount,
        clearReason: input.clearReason,
        recoveryPolicy: input.recoveryPolicy,
        monitor: input.monitor,
        source: input.activitySource,
      }),
    });

    if (input.recoveryPolicy === "create_recovery_issue") await recover();

    return { outcome: "skipped" as const, reason: input.clearReason };
  }

  function monitorOnlyDispatchPatch<T extends ReturnType<typeof buildIssueMonitorClearedPatch>>(patch: T) {
    // Admission and consumption are separate transactions. Preserve any review
    // policy/state changes made between them; only the monitor belongs to us.
    return {
      ...patch,
      executionPolicy: sql`nullif(${issues.executionPolicy} - 'monitor', '{}'::jsonb)`,
      executionState: sql`jsonb_set(coalesce(${issues.executionState}, ${JSON.stringify(patch.executionState)}::jsonb),
        '{monitor}', ${JSON.stringify(patch.executionState?.monitor ?? null)}::jsonb)`,
    };
  }

  function issueMonitorClaimCondition(claimed: IssueMonitorDispatchRow) {
    return and(eq(issues.id, claimed.id), eq(issues.companyId, claimed.companyId),
      eq(issues.assigneeAgentId, claimed.assigneeAgentId!), isNull(issues.assigneeUserId),
      eq(issues.status, claimed.status), eq(issues.monitorNextCheckAt, claimed.monitorNextCheckAt!),
      eq(issues.monitorWakeRequestedAt, claimed.monitorWakeRequestedAt!));
  }

  async function releaseIssueMonitorWithDiagnostic(
    claimed: IssueMonitorDispatchRow,
    input: Pick<Parameters<typeof dispatchClaimedIssueMonitor>[1],
      "now" | "actorType" | "actorId" | "agentId" | "runId" | "activitySource">,
    diagnostic: { action: "issue.monitor_deferred" | "issue.monitor_dispatch_failed";
      reason: string; blockerCause?: string; httpStatus?: number },
  ) {
    const publications: ActivityPublication[] = [];
    try {
      await db.transaction(async (tx) => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
        const released = await tx.update(issues)
          .set({ monitorWakeRequestedAt: null, updatedAt: input.now })
          .where(issueMonitorClaimCondition(claimed)).returning({ id: issues.id });
        if (released.length === 0) return;
        // The issue lock serializes diagnostics from competing scheduler instances.
        // Bound recurring reads to this issue's recent indexed activity history.
        const [recent] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
          eq(activityLog.companyId, claimed.companyId), eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, claimed.id), eq(activityLog.action, diagnostic.action),
          gte(activityLog.createdAt, new Date(Date.now() - 5 * 60_000)),
          sql`${activityLog.details}->>'nextCheckAt' = ${claimed.monitorNextCheckAt!.toISOString()}`,
          sql`${activityLog.details}->>'reason' = ${diagnostic.reason}`,
          sql`coalesce(${activityLog.details}->>'blockerCause', '') = ${diagnostic.blockerCause ?? ""}`,
        )).limit(1);
        if (recent) return;
        await logActivity(tx as unknown as Db, {
          companyId: claimed.companyId, actorType: input.actorType, actorId: input.actorId,
          agentId: input.agentId, runId: input.runId, action: diagnostic.action,
          entityType: "issue", entityId: claimed.id,
          details: { nextCheckAt: claimed.monitorNextCheckAt!.toISOString(),
            checkedAt: input.now.toISOString(), attemptCount: claimed.monitorAttemptCount ?? 0,
            reason: diagnostic.reason, source: input.activitySource,
            ...(diagnostic.blockerCause ? { blockerCause: diagnostic.blockerCause } : {}),
            ...(diagnostic.httpStatus ? { httpStatus: diagnostic.httpStatus } : {}),
          },
        }, publications);
      });
      for (const publication of publications) publishActivity(publication);
    } catch (err) {
      // Diagnostics are optional. Release the original claim even if audit storage
      // failed, and never clobber a monitor that was replaced in the meantime.
      await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
        await tx.update(issues).set({ monitorWakeRequestedAt: null, updatedAt: input.now })
          .where(issueMonitorClaimCondition(claimed));
      });
      logger.warn({ err, issueId: claimed.id }, "issue monitor diagnostic could not be recorded");
    }
  }

  async function dispatchClaimedIssueMonitor(
    claimed: IssueMonitorDispatchRow,
    input: {
      now: Date;
      source: "automation" | "on_demand";
      triggerDetail: "manual" | "system";
      wakeReason: string;
      actorType: "user" | "agent" | "system";
      actorId: string;
      agentId: string | null;
      runId: string | null;
      clearOnClientError: boolean;
      activitySource: "manual" | "scheduled";
    },
  ) {
    if (!claimed.assigneeAgentId || !claimed.monitorNextCheckAt) {
      throw conflict("Issue monitor is not ready to dispatch");
    }

    const scheduledAtIso = claimed.monitorNextCheckAt.toISOString();
    const nextAttemptCount = (claimed.monitorAttemptCount ?? 0) + 1;
    const policy = normalizeIssueExecutionPolicy(
      claimed.executionPolicy ?? null,
    );
    const monitor = policy?.monitor ?? null;
    const clearReason = issueMonitorLimitClearReason({
      monitor,
      nextAttemptCount,
      now: input.now,
    });
    const recoveryPolicy = monitorRecoveryPolicy(monitor);
    const monitorMetadata = {
      serviceName: monitor?.serviceName ?? null,
      timeoutAt: monitor?.timeoutAt ?? null,
      maxAttempts: monitor?.maxAttempts ?? null,
      recoveryPolicy: monitor?.recoveryPolicy ?? null,
    };
    const executionState =
      claimed.status === "in_review"
        ? parseIssueExecutionState(claimed.executionState)
        : null;
    const currentParticipant =
      executionState?.status === "pending"
        ? executionState.currentParticipant
        : null;
    const reviewParticipantAgentId =
      currentParticipant?.type === "agent" ? currentParticipant.agentId : null;
    const isProviderQuotaReviewMonitor =
      monitor?.serviceName === PROVIDER_QUOTA_MONITOR_SERVICE_NAME &&
      Boolean(reviewParticipantAgentId);
    const targetAgentId = isProviderQuotaReviewMonitor
      ? reviewParticipantAgentId
      : claimed.assigneeAgentId;
    if (!targetAgentId) {
      throw conflict("Issue monitor has no agent target");
    }
    const wakeReason = isProviderQuotaReviewMonitor
      ? EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON
      : input.wakeReason;
    const reviewRecoveryContext = isProviderQuotaReviewMonitor
      ? {
          retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
          currentStageId: executionState?.currentStageId ?? null,
          currentStageType: executionState?.currentStageType ?? null,
          reviewRecoveryInstruction:
            "The previous reviewer run reached provider quota. Resume this execution-review stage now that the quota wait has elapsed.",
        }
      : {};

    if (clearReason) {
      return clearIssueMonitorAndRecover({
        claimed,
        policy,
        scheduledAtIso,
        nextAttemptCount,
        clearReason,
        recoveryPolicy,
        monitor,
        now: input.now,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        activitySource: input.activitySource,
      });
    }

    try {
      if (monitor?.serviceName === PROVIDER_QUOTA_MONITOR_SERVICE_NAME) {
        // Normalized monitor projections redact externalRef. Read the claimed
        // persisted policy only on this server-owned quota recovery path.
        const sourceRunId = readNonEmptyString(
          parseObject(parseObject(claimed.executionPolicy).monitor).externalRef,
        );
        const sourceRun =
          sourceRunId && isUuidLike(sourceRunId)
            ? await getRun(sourceRunId, { unsafeFullResultJson: true })
            : null;
        if (
          !sourceRun ||
          sourceRun.companyId !== claimed.companyId ||
          sourceRun.agentId !== targetAgentId ||
          sourceRun.contextSnapshot?.issueId !== claimed.id ||
          !["failed", "timed_out", "interrupted", "cancelled"].includes(
            sourceRun.status,
          )
        ) {
          throw conflict(
            "The quota recovery source changed; inspect the current task execution.",
          );
        }
        if (sourceRun.runtimeMode === "native") {
          throw conflict(
            "Native execution recovery owns this provider failure; a quota monitor cannot start a replacement.",
          );
        }
        if (await legacyExecutionNeedsReconciliationWithEvidence(db, sourceRun)) {
          await terminalizeLegacyExecution({
            db,
            run: sourceRun,
            status: sourceRun.status,
          });
        } else {
          const targetAgent = await getAgent(targetAgentId);
          if (!targetAgent)
            throw conflict("The quota recovery agent is unavailable.");
          const scheduled = await scheduleBoundedRetryForRun(
            sourceRun,
            targetAgent,
            {
              now: input.now,
              ...(isProviderQuotaReviewMonitor
                ? {
                    retryReason:
                      EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
                    wakeReason:
                      EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON,
                  }
                : {}),
            },
          );
          if (scheduled.outcome === "not_scheduled")
            throw conflict(scheduled.reason);
        }
      } else {
        let executionDeferredCause: string | null = null;
        const wake = await enqueueWakeup(targetAgentId, {
          issueStateGuard: { statuses: [claimed.status], assigneeAgentId: claimed.assigneeAgentId,
            monitorNextCheckAt: scheduledAtIso, monitorWakeRequestedAt: claimed.monitorWakeRequestedAt!.toISOString(),
            onExecutionDeferred: cause => { executionDeferredCause = cause; } },
          source: input.source,
          triggerDetail: input.triggerDetail,
          reason: wakeReason,
          idempotencyKey: `issue-monitor:${claimed.id}:${scheduledAtIso}`,
          payload: {
            issueId: claimed.id,
            nextCheckAt: scheduledAtIso,
            monitorAttemptCount: nextAttemptCount,
            monitorNotes: claimed.monitorNotes ?? null,
            ...monitorMetadata,
            ...reviewRecoveryContext,
            source: input.activitySource,
          },
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          contextSnapshot: {
            issueId: claimed.id,
            source: isProviderQuotaReviewMonitor
              ? "issue.execution_review_recovery"
              : "issue.monitor",
            wakeReason,
            nextCheckAt: scheduledAtIso,
            monitorAttemptCount: nextAttemptCount,
            monitorNotes: claimed.monitorNotes ?? null,
            ...monitorMetadata,
            ...reviewRecoveryContext,
            manualTrigger: input.activitySource === "manual",
          },
        });
        if (!wake) {
          const blockerCause = executionDeferredCause &&
            ([...EXECUTION_RECONCILIATION_CAUSES, "execution_owner_active"] as readonly string[]).includes(executionDeferredCause)
            ? executionDeferredCause : undefined;
          const reason = executionDeferredCause ? "execution_reconciliation_required" : "monitor_dispatch_deferred";
          await releaseIssueMonitorWithDiagnostic(claimed, input, {
            action: "issue.monitor_deferred", reason, ...(blockerCause ? { blockerCause } : {}),
          });
          return { outcome: "skipped" as const, reason };
        }
      }

      const consumed = await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
        return tx.update(issues)
        .set({
          ...monitorOnlyDispatchPatch(buildIssueMonitorTriggeredPatch({
            issue: claimed,
            policy,
            triggeredAt: input.now,
          })),
          updatedAt: new Date(),
        })
        .where(issueMonitorClaimCondition(claimed))
        .returning({ id: issues.id });
      });
      if (consumed.length === 0) return { outcome: "triggered" as const };

      await logActivity(db, {
        companyId: claimed.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: "issue.monitor_triggered",
        entityType: "issue",
        entityId: claimed.id,
        details: {
          identifier: claimed.identifier,
          nextCheckAt: scheduledAtIso,
          lastTriggeredAt: input.now.toISOString(),
          attemptCount: nextAttemptCount,
          notes: claimed.monitorNotes ?? null,
          ...monitorMetadata,
          source: input.activitySource,
        },
      });

      return { outcome: "triggered" as const };
    } catch (err) {
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
        if (input.clearOnClientError) {
          await db.transaction(async tx => {
            await notifyIssueReviewState(tx, { companyId: claimed.companyId, issueId: claimed.id });
            await tx
            .update(issues)
            .set({
              ...monitorOnlyDispatchPatch(buildIssueMonitorClearedPatch({
                issue: claimed,
                policy,
                clearReason: "dispatch_skipped",
                clearedAt: input.now,
              })),
              updatedAt: new Date(),
            })
            .where(issueMonitorClaimCondition(claimed));
          });

          await logActivity(db, {
            companyId: claimed.companyId,
            actorType: input.actorType,
            actorId: input.actorId,
            agentId: input.agentId,
            runId: input.runId,
            action: "issue.monitor_skipped",
            entityType: "issue",
            entityId: claimed.id,
            details: {
              identifier: claimed.identifier,
              nextCheckAt: scheduledAtIso,
              attemptCount: nextAttemptCount,
              notes: claimed.monitorNotes ?? null,
              reason: err.message,
              source: input.activitySource,
            },
          });

          return { outcome: "skipped" as const, reason: err.message };
        }
      }
      await releaseIssueMonitorWithDiagnostic(claimed, input, {
        action: "issue.monitor_dispatch_failed", reason: "monitor_dispatch_failed",
        ...(err instanceof HttpError ? { httpStatus: err.status } : {}),
      });
      throw err;
    }
  }

  function noActiveNativeMonitorRun() {
    return sql`not exists (select 1 from ${heartbeatRuns} monitor_run
      where monitor_run.company_id = ${issues.companyId}
        and monitor_run.native_issue_id = ${issues.id}
        and monitor_run.runtime_mode = 'native'
        and (monitor_run.status in ('queued', 'running', 'scheduled_retry')
          or exists (select 1 from ${nativeRunFinalizations} monitor_finalization
            where monitor_finalization.company_id = monitor_run.company_id
              and monitor_finalization.run_id = monitor_run.id
              and monitor_finalization.phase not in ('committed', 'terminal_failure'))))`;
  }

  async function triggerIssueMonitor(
    issueId: string,
    input?: {
      now?: Date;
      actorType?: "user" | "agent" | "system";
      actorId?: string | null;
      agentId?: string | null;
      runId?: string | null;
      wakeReason?: string;
    },
  ) {
    const now = input?.now ?? new Date();
    const actorType = input?.actorType ?? "system";
    const actorId =
      input?.actorId ?? (actorType === "system" ? "heartbeat_scheduler" : null);
    if (!actorId) {
      throw conflict("Issue monitor trigger requires an actor");
    }

    const issue = await db
      .select(issueMonitorDispatchColumns)
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!issue) {
      throw notFound("Issue not found");
    }
    if (!issue.monitorNextCheckAt) {
      throw conflict("Issue has no scheduled monitor");
    }
    if (!issue.assigneeAgentId || issue.assigneeUserId) {
      throw conflict("Issue monitor requires an agent assignee");
    }
    if (issue.status === "blocked" && actorType === "user" &&
      normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor?.serviceName === PROVIDER_QUOTA_MONITOR_SERVICE_NAME) {
      // Quota recovery schedules a bounded retry directly, rather than using
      // ordinary wake admission. It must not consume a blocked task's monitor.
      throw conflict("Resume this task before checking provider usage.", { code: "blocked_quota_monitor" });
    }
    // A human can request one check of a blocked task. Admission still owns
    // dependencies, recovery, pause and budget gates; automatic ticks stay idle.
    const allowedStatuses = actorType === "user"
      ? ["in_progress", "in_review", "blocked"]
      : ["in_progress", "in_review"];
    if (!allowedStatuses.includes(issue.status)) {
      throw conflict(
        "Issue monitor can only run while the issue is in progress or in review",
      );
    }

    const staleClaimThreshold = new Date(now.getTime() - 5 * 60 * 1000);
    const claimed = await db.transaction(async (tx) => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
      const [updated] = await tx
        .update(issues)
        .set({
          monitorWakeRequestedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, issueId),
            noActiveNativeMonitorRun(),
            sql`${issues.monitorNextCheckAt} is not null`,
            isNull(issues.assigneeUserId),
            sql`${issues.assigneeAgentId} is not null`,
            inArray(issues.status, allowedStatuses),
            or(
              isNull(issues.monitorWakeRequestedAt),
              lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
            ),
          ),
        )
        .returning();
      return (updated ?? null) as IssueMonitorDispatchRow | null;
    });

    if (!claimed) {
      throw conflict("Issue monitor check is already in progress or waiting for the previous run to settle");
    }

    return dispatchClaimedIssueMonitor(claimed, {
      now,
      source: "on_demand",
      triggerDetail: "manual",
      wakeReason: input?.wakeReason ?? "issue_monitor_due",
      actorType,
      actorId,
      agentId: input?.agentId ?? null,
      runId: input?.runId ?? null,
      clearOnClientError: false,
      activitySource: "manual",
    });
  }

  async function tickDueIssueMonitors(now: Date, canContinue: () => boolean) {
    const staleClaimThreshold = new Date(now.getTime() - 5 * 60 * 1000);
    const dueMonitors = await db
      .select(issueMonitorDispatchColumns)
      .from(issues)
      .innerJoin(companies, eq(companies.id, issues.companyId))
      .where(
        and(
          eq(companies.status, "active"),
          noActiveNativeMonitorRun(),
          sql`${issues.monitorNextCheckAt} is not null`,
          lte(issues.monitorNextCheckAt, now),
          isNull(issues.assigneeUserId),
          sql`${issues.assigneeAgentId} is not null`,
          inArray(issues.status, ["in_progress", "in_review"]),
          or(
            isNull(issues.monitorWakeRequestedAt),
            lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
          ),
        ),
      )
      .orderBy(asc(issues.monitorNextCheckAt), asc(issues.updatedAt))
      .limit(50);

    let triggered = 0;
    let skipped = 0;

    for (const due of dueMonitors) {
      if (!canContinue()) break;
      const claimed = await db.transaction(async (tx) => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
        const [updated] = await tx
          .update(issues)
          .set({
            monitorWakeRequestedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.id, due.id),
              noActiveNativeMonitorRun(),
              sql`${issues.monitorNextCheckAt} is not null`,
              lte(issues.monitorNextCheckAt, now),
              isNull(issues.assigneeUserId),
              sql`${issues.assigneeAgentId} is not null`,
              inArray(issues.status, ["in_progress", "in_review"]),
              or(
                isNull(issues.monitorWakeRequestedAt),
                lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
              ),
            ),
          )
          .returning();
        return (updated ?? null) as IssueMonitorDispatchRow | null;
      });

      if (!claimed) continue;
      if (!canContinue()) break;

      try {
        const result = await dispatchClaimedIssueMonitor(claimed, {
          now,
          source: "automation",
          triggerDetail: "system",
          wakeReason: "issue_monitor_due",
          actorType: "system",
          actorId: "heartbeat_scheduler",
          agentId: null,
          runId: null,
          clearOnClientError: true,
          activitySource: "scheduled",
        });
        if (result.outcome === "triggered") triggered += 1;
        if (result.outcome === "skipped") skipped += 1;
      } catch (err) {
        logger.error({ err, issueId: claimed.id }, "issue monitor tick failed");
      }
    }

    return {
      checked: dueMonitors.length,
      triggered,
      skipped,
    };
  }

  async function tickIssueMonitors(now = new Date(), canContinue: () => boolean = () => true) {
    if (!canContinue() || (await getSchedulingSuppression(true)).suppressed) {
      return { checked: 0, triggered: 0, skipped: 0 };
    }
    return tickDueIssueMonitors(now, canContinue);
  }

  async function nextIssueMonitorAt(): Promise<number | null> {
    if ((await getSchedulingSuppression(true)).suppressed) return null;
    const [row] = await db.select({ at: sql<string | null>`min(greatest(${issues.monitorNextCheckAt},
      ${issues.monitorWakeRequestedAt} + interval '5 minutes' + interval '1 millisecond'))` })
      .from(issues).innerJoin(companies, eq(companies.id, issues.companyId))
      .where(and(eq(companies.status, "active"), noActiveNativeMonitorRun(),
        sql`${issues.monitorNextCheckAt} is not null`, isNull(issues.assigneeUserId),
        sql`${issues.assigneeAgentId} is not null`, inArray(issues.status, ["in_progress", "in_review"])));


    return row?.at == null ? null : new Date(row.at).getTime();
  }

  async function recoverActiveSessionGoals() {
    if ((await getSchedulingSuppression()).suppressed) {
      return { scanned: 0, enqueued: 0 };
    }
    const sessions = await db
      .select({
        id: agentTaskSessions.id,
        companyId: agentTaskSessions.companyId,
        agentId: agentTaskSessions.agentId,
        issueId: agentTaskSessions.taskKey,
        revision: agentTaskSessions.goalRevision,
      })
      .from(agentTaskSessions)
      .innerJoin(
        issues,
        and(
          sql`${issues.id}::text = ${agentTaskSessions.taskKey}`,
          eq(issues.companyId, agentTaskSessions.companyId),
          eq(issues.assigneeAgentId, agentTaskSessions.agentId),
        ),
      )
      .where(
        and(
          eq(agentTaskSessions.goalDesiredState, "active"),
          eq(agentTaskSessions.goalStatus, "active"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    let enqueued = 0;
    for (const session of sessions) {
      const run = await enqueueWakeup(session.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "goal_control",
        payload: { issueId: session.issueId, intent: "goal_recovery" },
        idempotencyKey: `goal_recovery:${session.id}:${session.revision}`,
        requestedByActorType: "system",
        contextSnapshot: {
          issueId: session.issueId,
          taskKey: session.issueId,
          resumeSessionGoalHeartbeat: true,
          skipIssueComment: true,
        },
      });
      if (run) enqueued += 1;
    }
    return { scanned: sessions.length, enqueued };
  }

  async function recoverPendingSessionGoalActions() {
    if ((await getSchedulingSuppression()).suppressed) {
      return { scanned: 0, enqueued: 0, alreadyQueued: 0, invalid: 0 };
    }
    const pending = await db
      .select({
        id: agentSessionGoalActions.id,
        requestId: agentSessionGoalActions.requestId,
        payload: agentSessionGoalActions.payloadJson,
        companyId: agentTaskSessions.companyId,
        agentId: agentTaskSessions.agentId,
        adapterType: agentTaskSessions.adapterType,
        issueId: agentTaskSessions.taskKey,
      })
      .from(agentSessionGoalActions)
      .innerJoin(
        agentTaskSessions,
        eq(agentTaskSessions.id, agentSessionGoalActions.sessionId),
      )
      .innerJoin(
        issues,
        and(
          sql`${issues.id}::text = ${agentTaskSessions.taskKey}`,
          eq(issues.companyId, agentTaskSessions.companyId),
          eq(issues.assigneeAgentId, agentTaskSessions.agentId),
        ),
      )
      .where(
        inArray(agentSessionGoalActions.status, [
          "pending",
          "delivering",
          "delivered",
        ]),
      )
      .orderBy(asc(agentSessionGoalActions.createdAt));

    let enqueued = 0;
    let alreadyQueued = 0;
    let invalid = 0;
    for (const action of pending) {
      const control = parseNativeSessionGoalControl(action.payload);
      if (!control || control.requestId !== action.requestId) {
        invalid += 1;
        await failRunnerGoalAction(
          db,
          {
            companyId: action.companyId,
            issueId: action.issueId,
            agentId: action.agentId,
            adapterType: action.adapterType,
          },
          action.requestId,
          "session_goal_control_payload_invalid",
        ).catch(() => undefined);
        continue;
      }

      const inFlight = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, action.companyId),
            eq(heartbeatRuns.agentId, action.agentId),
            inArray(heartbeatRuns.status, [
              "queued",
              "scheduled_retry",
              "running",
            ]),
          ),
        )
        .then((runs) =>
          runs.some(
            (run) =>
              readNonEmptyString(
                parseObject(run.contextSnapshot).goalControlRequestId,
              ) === action.requestId,
          ),
        );
      if (inFlight) {
        alreadyQueued += 1;
        continue;
      }

      const run = await enqueueWakeup(action.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "goal_control",
        payload: {
          issueId: action.issueId,
          requestId: action.requestId,
          intent: "goal_control_recovery",
        },
        idempotencyKey: `goal_control_recovery:${action.id}`,
        requestedByActorType: "system",
        contextSnapshot: {
          issueId: action.issueId,
          taskKey: action.issueId,
          // Goal controls reconcile the provider session itself and remain
          // valid after issue terminalization (for example, clearing a
          // completed goal from its retained widget).
          resumeIntent: true,
          goalControlRequestId: action.requestId,
          runnerGoalControl: control,
          skipIssueComment: true,
        },
      });
      if (run) enqueued += 1;
    }
    return { scanned: pending.length, enqueued, alreadyQueued, invalid };
  }

  async function eligibleTimerAgents() {
    const cutoff = await getWorktreeExecutionCutoff();

    const allAgents = await db
      .select({ ...getTableColumns(agents) })
      .from(agents)
      .innerJoin(companies, eq(companies.id, agents.companyId))
      .where(eq(companies.status, "active"));
    const agentsByCompany = groupAgentOrgRowsByCompany(
      allAgents.map(toAgentOrgRow),
    );
    const eligible: Array<{ agent: typeof agents.$inferSelect; intervalSec: number }> = [];

    for (const agent of allAgents) {
      const invokability = evaluateAgentInvokability(
        toAgentOrgRow(agent),
        agentsByCompany.get(agent.companyId) ?? [],
      );
      if (!invokability.invokable) continue;
      if (!supportsUnscopedTimerHeartbeat(agent)) continue;
      const policy = parseHeartbeatPolicy(agent);
      if (!policy.enabled || policy.intervalSec <= 0) continue;

      if (cutoff) {
        const eligibleIssue = await db
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, agent.companyId),
              eq(issues.assigneeAgentId, agent.id),
              inArray(issues.status, ["todo", "in_progress"]),
              gte(issues.createdAt, cutoff),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!eligibleIssue) continue;
      }

      eligible.push({ agent, intervalSec: policy.intervalSec });
    }
    return eligible;
  }

  async function nextAgentTimerAt(now = new Date()): Promise<number | null> {
    if ((await getSchedulingSuppression(true)).suppressed) return null;
    let next: number | null = null;
    for (const { agent } of await eligibleTimerAgents()) {
      const deadline = await nextTimerHeartbeatAt(agent, now);
      if (deadline !== null) next = next === null ? deadline : Math.min(next, deadline);
    }
    return next;
  }

  async function tickAgentTimers(now = new Date(), canContinue: () => boolean = () => true) {
    if (!canContinue() || (await getSchedulingSuppression(true)).suppressed) return { checked: 0, enqueued: 0, skipped: 0 };
    let checked = 0, enqueued = 0, skipped = 0;
    for (const { agent, intervalSec } of await eligibleTimerAgents()) {
      if (!canContinue()) break;
      checked++;
      const deadline = await nextTimerHeartbeatAt(agent, now);
      if (deadline === null || deadline > now.getTime()) continue;
      if (!canContinue()) break;
      const timerClaim = await claimDueTimerHeartbeat(agent, now, intervalSec);
      if (!timerClaim) continue;
      const run = await enqueueWakeup(agent.id, {
        source: "timer", triggerDetail: "system", reason: "heartbeat_timer",
        requestedByActorType: "system", requestedByActorId: "heartbeat_scheduler",
        contextSnapshot: { source: "scheduler", reason: "interval_elapsed", now: now.toISOString(),
          timerClaimWasFirstHeartbeat: timerClaim.wasFirstHeartbeat },
      });
      if (run) enqueued++; else skipped++;
    }
    return { checked, enqueued, skipped };
  }


  async function tickTimers(now = new Date()) {
    const timers = await tickAgentTimers(now);
    const monitors = await tickIssueMonitors(now);
    return { checked: timers.checked + monitors.checked,
      enqueued: timers.enqueued + monitors.triggered, skipped: timers.skipped + monitors.skipped };
  }

  return {
    triggerIssueMonitor,
    tickTimers,
    tickAgentTimers,
    nextAgentTimerAt,
    tickIssueMonitors,
    nextIssueMonitorAt,
    recoverActiveSessionGoals,
    recoverPendingSessionGoalActions,
  };
}
