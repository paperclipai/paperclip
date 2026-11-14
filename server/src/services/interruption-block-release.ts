import { and, desc, eq, sql, type SQLWrapper } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueRecoveryActions, issueRelations, issues, type Db } from "@paperclipai/db";
import { holdOwnsBlockedStatus } from "./recovery-hold-blocked-status.js";
import { persistActivity } from "./activity-log.js";

export const BLOCK_ATTRIBUTION_WINDOW_MS = 10_000;

type BlockEntry = { actorType: string; actorId: string; agentId: string | null; details: unknown };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function blockedStatusDetailsSql(details: SQLWrapper) {
  return sql`(${details}->>'status' = 'blocked' or ${details}->>'toStatus' = 'blocked'
    or ${details}->'changes'->'status'->>'to' = 'blocked')`;
}

export function attributeBlock(entry: BlockEntry | undefined,
  assigneeAgentId: string | null): "user" | "assignee" | "system" | "unknown" {
  if (!entry) return "unknown";
  const details = object(entry.details);
  if (entry.actorType === "user") return "user";
  if (entry.actorType === "agent") return entry.agentId && entry.agentId === assigneeAgentId ? "assignee" : "system";
  if (entry.actorId === "native-status-committer" && details.source === "native_status_decision"
    && details.reasonCode !== "durable_dependency_blocker_bound") return "assignee";
  return "system";
}

type SourceRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "finishedAt">;

export async function liftInterruptionBlock(db: Db, task: typeof issues.$inferSelect,
  actions: Array<typeof issueRecoveryActions.$inferSelect>, sources: SourceRun[], successorRunId: string) {
  if (task.status !== "blocked" || task.unblockDescriptor) return;
  const sourceFor = (action: typeof issueRecoveryActions.$inferSelect) =>
    sources.find(run => run.id === String(action.evidence.runId ?? action.evidence.sourceRunId));
  const blockedAt = task.blockedTransitionAt?.getTime();
  const receiptless = actions.every(action =>
    action.evidence.workspaceFinalizationBlock === undefined && action.evidence.nativeFailureBlock === undefined);
  const owned = actions.some(action => { const run = sourceFor(action); return run && holdOwnsBlockedStatus(action, task, run); })
    || (receiptless && task.lastStatusDecisionId === null && blockedAt !== undefined
      && sources.some(run => run.finishedAt !== null && blockedAt >= run.finishedAt.getTime() - 1_000));
  if (!owned) return;
  const [blockEntry] = blockedAt === undefined ? [] : await db.select({ actorType: activityLog.actorType,
    actorId: activityLog.actorId, agentId: activityLog.agentId, details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, task.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, task.id),
    sql`${activityLog.createdAt} between ${new Date(blockedAt - BLOCK_ATTRIBUTION_WINDOW_MS).toISOString()}::timestamptz
      and ${new Date(blockedAt + BLOCK_ATTRIBUTION_WINDOW_MS).toISOString()}::timestamptz`,
    blockedStatusDetailsSql(activityLog.details),
  )).orderBy(desc(activityLog.createdAt)).limit(1);
  if (attributeBlock(blockEntry, task.assigneeAgentId) === "user") return;
  const [openBlocker] = await db.select({ id: issueRelations.id }).from(issueRelations)
    .innerJoin(issues, and(eq(issues.id, issueRelations.issueId), eq(issues.companyId, issueRelations.companyId)))
    .where(and(eq(issueRelations.companyId, task.companyId), eq(issueRelations.relatedIssueId, task.id),
      eq(issueRelations.type, "blocks"), sql`${issues.status} not in ('done', 'cancelled')`)).limit(1);
  if (openBlocker) return;
  const lifted = await db.update(issues).set({ status: "todo", blockedTransitionAt: null, blockedOwnerNotifiedAt: null,
    updatedAt: new Date() }).where(and(eq(issues.companyId, task.companyId), eq(issues.id, task.id),
    eq(issues.status, "blocked"), eq(issues.statusVersion, task.statusVersion))).returning({ id: issues.id });
  if (!lifted.length) return;
  await persistActivity(db, { companyId: task.companyId, actorType: "system", actorId: "task-recovery",
    action: "issue.updated", entityType: "issue", entityId: task.id,
    details: { status: "todo", previousStatus: "blocked", reason: "continuation_queued", successorRunId,
      _previous: { status: "blocked" } } });
}
