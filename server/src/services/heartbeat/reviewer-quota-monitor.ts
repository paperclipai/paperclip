import { legacyExecutionNeedsReconciliationWithEvidence } from "../legacy-execution-recovery.js";
import { parseObject } from "../../adapters/utils.js";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME, isUuidLike } from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { issueExecutionGeneration, parseIssueExecutionState } from "../issue-execution-policy.js";
import { logActivity } from "../activity-log.js";
import { boundRunIssueId } from "../run-task-binding.js";

type Task = typeof issues.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
const ACTION = "issue.review_quota_monitor_installed";
const OWNER = "review_quota_monitor";

export class ReviewQuotaMonitorHeld extends HttpError {
  constructor(message: string) { super(409, message); }
}

async function assertQuotaSourceEligibility(tx: Db, source: Run) {
  const recovery = parseObject(source.resultJson?.executionRecovery);
  if (source.runtimeMode === "native" || !["failed", "timed_out", "interrupted", "cancelled"].includes(source.status) ||
      source.errorCode !== "provider_quota" || recovery.kind !== "bootstrap" || recovery.providerWorkStarted !== false ||
      await legacyExecutionNeedsReconciliationWithEvidence(tx, source))
    throw new ReviewQuotaMonitorHeld("The quota source is no longer eligible for automatic retry");
}

function monitor(task: Task) {
  return parseObject(task.executionPolicy?.monitor);
}

function restoreMonitor(value: unknown, previous: unknown) {
  const restored = { ...(value as Record<string, unknown> ?? {}) };
  const old = previous as Record<string, unknown> | null;
  if (old && Object.hasOwn(old, "monitor")) restored.monitor = old.monitor;
  else delete restored.monitor;
  return previous === null && Object.keys(restored).length === 0 ? null : restored;
}

export async function recordReviewQuotaMonitorInstallation(tx: Db, before: Task, installed: Task) {
  const next = monitor(installed);
  if (next?.serviceName !== PROVIDER_QUOTA_MONITOR_SERVICE_NAME ||
      (isDeepStrictEqual(monitor(before), next) && before.monitorNextCheckAt?.getTime() === installed.monitorNextCheckAt?.getTime())) return;
  const state = parseIssueExecutionState(before.executionState);
  if (before.status !== "in_review" || state?.status !== "pending" || state.currentParticipant?.type !== "agent") return;
  const [source] = typeof next.externalRef === "string" && isUuidLike(next.externalRef) ? await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, next.externalRef), eq(heartbeatRuns.companyId, before.companyId))).for("no key update") : [];
  if (!source || before.id !== installed.id || before.companyId !== installed.companyId ||
      !["failed", "timed_out", "interrupted", "cancelled"].includes(source.status) ||
      boundRunIssueId(source) !== before.id || source.agentId !== state.currentParticipant.agentId)
    throw new ReviewQuotaMonitorHeld("The quota monitor source does not belong to this review");
  if (!installed.monitorNextCheckAt || typeof next.nextCheckAt !== "string" ||
      new Date(next.nextCheckAt).getTime() !== installed.monitorNextCheckAt.getTime())
    throw new ReviewQuotaMonitorHeld("The quota monitor schedule does not match its policy");
  await assertQuotaSourceEligibility(tx, source);
  const sourceGeneration = source.contextSnapshot?.reviewerAssignmentGeneration;
  if (typeof sourceGeneration !== "string") throw new ReviewQuotaMonitorHeld("The review quota source has no generation proof");
  const restored = { ...installed, executionPolicy: restoreMonitor(installed.executionPolicy, before.executionPolicy),
    executionState: restoreMonitor(installed.executionState, before.executionState) };
  if (sourceGeneration !== issueExecutionGeneration(before) ||
      issueExecutionGeneration(restored) !== issueExecutionGeneration(before))
    throw new ReviewQuotaMonitorHeld("The review submission changed before quota monitor installation");
  await logActivity(tx, { companyId: before.companyId, actorType: "system", actorId: OWNER,
    action: ACTION, entityType: "issue", entityId: before.id, runId: source.id,
    details: { version: 1, sourceRunId: source.id, sourceGeneration,
      installedGeneration: issueExecutionGeneration(installed), nextCheckAt: installed.monitorNextCheckAt?.toISOString() } });
}

export async function assertReviewQuotaMonitorInstallation(tx: Db, task: Task, source: Run) {
  await assertQuotaSourceEligibility(tx, source);
  const [proof] = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, task.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, task.id),
    eq(activityLog.action, ACTION), eq(activityLog.actorType, "system"), eq(activityLog.actorId, OWNER),
    eq(activityLog.runId, source.id), sql`${activityLog.details}->>'sourceRunId' = ${source.id}`,
    sql`${activityLog.details}->>'installedGeneration' = ${issueExecutionGeneration(task)}`,
    sql`${activityLog.details}->>'nextCheckAt' = ${task.monitorNextCheckAt?.toISOString() ?? ""}`,
  )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
  if (!proof || proof.details?.version !== 1 || source.companyId !== task.companyId || boundRunIssueId(source) !== task.id ||
      source.contextSnapshot?.reviewerAssignmentGeneration !== proof.details.sourceGeneration)
    throw new ReviewQuotaMonitorHeld("The quota monitor has no matching source submission proof");
}
