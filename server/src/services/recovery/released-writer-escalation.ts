import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, statusDecisions, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { issueService } from "../issues.js";
import { readRemoteWorkspaceWriterHold, REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE } from "../remote-workspace-writer-hold.js";
import { notifyStatusCardIssueChange } from "../status-card-notifications.js";
import { deliverPendingRecoveryWakes, type PendingRecoveryWake, type RehomeWakeup } from "./legacy-workspace-rehome.js";

export const RELEASED_WORKSPACE_WRITER_SCHEMA = "paperclip.released-workspace-writer.v1";
export const RELEASED_WORKSPACE_WRITER_OUTCOME = "workspace_writer_released_continued";
const STRANDED_KIND = "stranded_assigned_issue";
const BOARD_ESCALATION_POLICY = "board_escalation_no_takeover_v1";
const PAGE_SIZE = 25;
// A block set by the stranded escalation lands right after its failed run.
const BLOCK_OWNERSHIP_SLACK_MS = 60_000;
const WAKE: PendingRecoveryWake = { key: "releasedWorkspaceWriter", actorId: "released-workspace-writer", forceFreshSession: false };

export const RELEASED_WORKSPACE_WRITER_NOTE = "This task could not start while an earlier run still held its workspace. "
  + "That workspace is free again, so Paperclip continues the task.";

/**
 * A task whose runs failed setup because an ended run still held its remote
 * workspace, before any provider work, which stranded-work recovery then
 * blocked with a board-owned escalation. That failure belongs to the hold, not
 * to the task: once the hold settles (the held files were saved, or the task
 * continues from its last save), nothing a person could do remains. This pass
 * settles the escalation in one transaction: it resolves with a named outcome,
 * the task returns to `todo`, and a pending wake is recorded and delivered
 * after commit (a wake lost to a crash stays pending for the next pass). The
 * workspace itself is never changed here: the next run's admission takes it
 * through the normal writer rule. Bounded and idempotent: a resolved
 * escalation is never revisited, and a failed guard leaves the task as it is.
 */
export async function continueTasksAfterWorkspaceWriterReleased(db: Db, wake: RehomeWakeup | null,
  scope: { companyId?: string; issueId?: string } = {}) {
  const continued: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const candidates: Array<{ actionId: string; companyId: string; issueId: string }> = await db.select({
      actionId: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId, issueId: issueRecoveryActions.sourceIssueId,
    }).from(issueRecoveryActions)
      .innerJoin(issues, and(eq(issues.companyId, issueRecoveryActions.companyId), eq(issues.id, issueRecoveryActions.sourceIssueId)))
      .where(and(
        scope.companyId ? eq(issueRecoveryActions.companyId, scope.companyId) : undefined,
        scope.issueId ? eq(issueRecoveryActions.sourceIssueId, scope.issueId) : undefined,
        cursor ? gt(issueRecoveryActions.id, cursor) : undefined,
        eq(issueRecoveryActions.kind, STRANDED_KIND), inArray(issueRecoveryActions.status, ["active", "escalated"]),
        sql`${issueRecoveryActions.evidence}->>'routingPolicy' = ${BOARD_ESCALATION_POLICY}`,
        sql`${issueRecoveryActions.evidence}->>'latestRunErrorCode' = 'setup_failed'`,
        eq(issues.status, "blocked"), isNull(issues.hiddenAt), isNull(issues.assigneeUserId),
        sql`${issues.assigneeAgentId} is not null`, sql`${issues.executionWorkspaceId} is not null`,
      )).orderBy(asc(issueRecoveryActions.id)).limit(PAGE_SIZE);
    for (const candidate of candidates) {
      let settled: Awaited<ReturnType<typeof continueOne>>;
      try {
        settled = await db.transaction(tx => continueOne(tx as unknown as Db, candidate));
      } catch (error) {
        logger.warn({ err: error, issueId: candidate.issueId }, "Task held by an earlier writer stays blocked until the next sweep");
        continue;
      }
      if (!settled) continue;
      continued.push(candidate.issueId);
      try { publishActivity(settled.activity.publication); } catch { logger.warn({ issueId: candidate.issueId }, "Recovery activity delivery deferred"); }
    }
    if (candidates.length < PAGE_SIZE) break;
    cursor = candidates.at(-1)!.actionId;
  }
  const nextWakeRetryAt = wake ? await deliverPendingRecoveryWakes(db, wake, scope, WAKE) : null;
  return { continued, nextWakeRetryAt };
}

async function continueOne(tx: Db, input: { actionId: string; companyId: string; issueId: string }) {
  // Lock order: task, then recovery action.
  const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
  const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.id, input.actionId))).for("update");
  if (!issue || !action || issue.status !== "blocked" || issue.hiddenAt || issue.assigneeUserId || !issue.assigneeAgentId
    || !issue.executionWorkspaceId || action.sourceIssueId !== issue.id || action.kind !== STRANDED_KIND
    || !["active", "escalated"].includes(action.status) || action.ownerType !== "board"
    || action.evidence.routingPolicy !== BOARD_ESCALATION_POLICY) return null;
  const latestRunId = action.evidence.latestRunId;
  if (typeof latestRunId !== "string") return null;
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.id, latestRunId)));
  // Only a setup failure on a held workspace, before any provider work, by the current assignee.
  const recovery = (run?.resultJson?.executionRecovery ?? null) as { kind?: unknown; providerWorkStarted?: unknown } | null;
  if (!run || run.agentId !== issue.assigneeAgentId || run.status !== "failed" || run.errorCode !== "setup_failed"
    || run.error !== REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE || recovery?.kind !== "bootstrap" || recovery.providerWorkStarted !== false
    || (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== issue.id) return null;
  // That failed run is still the task's latest: nothing newer has started or queued for it.
  const [newer] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), ne(heartbeatRuns.id, run.id), gt(heartbeatRuns.createdAt, run.createdAt),
    // Each binding has its own (company, task, created) index.
    or(eq(heartbeatRuns.issueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}::text`)))
    .limit(1);
  if (newer) return null;
  // The Blocked status belongs to this escalation: set after that run, and no blocker keeps it.
  const blockedAt = issue.blockedTransitionAt?.getTime();
  if (blockedAt === undefined || !run.finishedAt || blockedAt < run.finishedAt.getTime() - 1_000
    || blockedAt > action.updatedAt.getTime() + BLOCK_OWNERSHIP_SLACK_MS) return null;
  // A status decision after the block owns the status now, unless it only kept
  // the block it found (a late result never decides a status it did not set).
  if (issue.lastStatusDecisionId) {
    const [decision] = await tx.select({ createdAt: statusDecisions.createdAt, fromStatus: statusDecisions.fromStatus,
      toStatus: statusDecisions.toStatus }).from(statusDecisions).where(and(
      eq(statusDecisions.companyId, input.companyId), eq(statusDecisions.id, issue.lastStatusDecisionId)));
    if (!decision || decision.createdAt.getTime() >= blockedAt
      && !(decision.fromStatus === "blocked" && decision.toStatus === "blocked")) return null;
  }
  // The shared dependency rule: any blocker that still forbids work keeps the task blocked.
  const readiness = await issueService(tx).listDependencyReadiness(input.companyId, [issue.id], tx);
  if (readiness.get(issue.id)?.isDependencyReady !== true) return null;
  // The hold that refused the run has settled: workspace reservation would now
  // admit a new writer. A writer still saving or running keeps the task as it is.
  const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, issue.executionWorkspaceId)));
  const authority = workspace ? readRemoteWorkspaceAuthority(workspace.metadata) : null;
  if (!authority || (await readRemoteWorkspaceWriterHold(tx, { companyId: input.companyId, authority })).kind !== "free") return null;
  const now = new Date();
  await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now,
    ownerType: "system", ownerAgentId: null, ownerUserId: null, returnOwnerAgentId: issue.assigneeAgentId,
    resolutionNote: RELEASED_WORKSPACE_WRITER_OUTCOME, nextAction: RELEASED_WORKSPACE_WRITER_NOTE, wakePolicy: null, monitorPolicy: null,
    evidence: { ...action.evidence, [WAKE.key]: { schema: RELEASED_WORKSPACE_WRITER_SCHEMA, runId: run.id,
      workspaceEpoch: authority.epoch, recordedAt: now.toISOString(), wake: "pending" } },
  }).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, action.id)));
  await tx.update(issues).set({ status: "todo", unblockDescriptor: null, blockedTransitionAt: null,
    blockedOwnerNotifiedAt: null, updatedAt: now }).where(and(eq(issues.companyId, input.companyId), eq(issues.id, issue.id)));
  await notifyStatusCardIssueChange(tx, input.companyId);
  const activity = await persistActivity(tx, { companyId: input.companyId, actorType: "system", actorId: WAKE.actorId,
    action: "issue.workspace_writer_released_continued", entityType: "issue", entityId: issue.id, runId: run.id,
    details: { recoveryActionId: action.id, status: "todo", note: RELEASED_WORKSPACE_WRITER_NOTE, _previous: { status: "blocked" } } });
  return { activity };
}
