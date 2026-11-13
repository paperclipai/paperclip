import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, statusDecisions, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { releaseAncestorWorkspaceBinding } from "../execution-workspaces.js";
import { issueService } from "../issues.js";
import { REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE } from "../remote-workspace-writer-hold.js";
import { notifyStatusCardIssueChange } from "../status-card-notifications.js";

export const LEGACY_WORKSPACE_REHOME_SCHEMA = "paperclip.legacy-workspace-rehome.v1";
export const LEGACY_WORKSPACE_REHOME_OUTCOME = "legacy_shared_workspace_rehomed";
const STRANDED_KIND = "stranded_assigned_issue";
const BOARD_ESCALATION_POLICY = "board_escalation_no_takeover_v1";
const PAGE_SIZE = 25;
const REHOME_WAKE_RETRY_BASE_MS = 5 * 60_000;
const REHOME_WAKE_RETRY_MAX_MS = 60 * 60_000;
// A block set by the stranded escalation lands right after its failed run.
const BLOCK_OWNERSHIP_SLACK_MS = 60_000;

export const LEGACY_WORKSPACE_REHOME_NOTE = "This task was set up in its parent's workspace by an earlier release, and that "
  + "workspace was held by another task's unsaved files, so the task could not start. Paperclip moved the task to its own "
  + "workspace from the project base and continues it there. No work was lost: nothing ran in the shared workspace.";

export type RehomeWakeup = (agentId: string, options: {
  source: "automation"; triggerDetail: "system"; reason: string; payload: Record<string, unknown>;
  requestedByActorType: "system"; requestedByActorId: string; contextSnapshot: Record<string, unknown>;
  issueStateGuard: { statuses: string[]; assigneeAgentId: string };
}) => Promise<unknown>;

/**
 * A subtask that an older release bound to its parent's (or another
 * relative's) execution workspace could not start while another task held
 * that workspace. Its run failed setup before any provider work, and
 * stranded-work recovery handed the blocked task to the board. That failure
 * belongs to the legacy binding, which the next admission would release anyway
 * (#19860). This pass does the release now, in one transaction: the task gets
 * its own workspace from the project base, the board escalation resolves with
 * a named outcome, the task returns to `todo`, and a pending wake is recorded.
 * After commit the assignee is woken once, like a board restore; a wake lost
 * to a crash stays pending and the next pass delivers it. The parent and the shared
 * workspace are never changed. Bounded and idempotent: a resolved escalation
 * is never revisited, and a failed guard leaves the task as it is. Returns the
 * IDs of the tasks that were moved and when the next owed wake is due.
 */
export async function rehomeStrandedLegacyWorkspaceTasks(db: Db, wake: RehomeWakeup | null,
  scope: { companyId?: string; issueId?: string } = {}) {
  const rehomed: string[] = [];
  // Page by action id, so escalations the guards reject never hide later eligible ones.
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
      let moved: Awaited<ReturnType<typeof rehomeOne>>;
      try {
        moved = await db.transaction(tx => rehomeOne(tx as unknown as Db, candidate));
      } catch (error) {
        logger.warn({ err: error, issueId: candidate.issueId }, "Legacy shared-workspace task stays blocked until the next sweep");
        continue;
      }
      if (!moved) continue;
      rehomed.push(candidate.issueId);
      try { publishActivity(moved.activity.publication); } catch { logger.warn({ issueId: candidate.issueId }, "Recovery activity delivery deferred"); }
    }
    if (candidates.length < PAGE_SIZE) break;
    cursor = candidates.at(-1)!.actionId;
  }
  // The move records its wake as pending in the same transaction. Deliver every
  // due pending wake, including one that a crash after an earlier commit left behind.
  const nextWakeRetryAt = wake ? await deliverPendingRecoveryWakes(db, wake, scope, REHOME_WAKE) : null;
  return { rehomed, nextWakeRetryAt };
}

/** Which recovery pass owes a wake: the evidence key it records it under, and how the woken run starts. */
export type PendingRecoveryWake = { key: string; actorId: string; forceFreshSession: boolean };
// A session saved in the shared workspace never resumes in the new one.
const REHOME_WAKE: PendingRecoveryWake = { key: "legacyWorkspaceRehome", actorId: "legacy-workspace-rehome", forceFreshSession: true };

const wakeField = (key: string, field: string) => sql`(${issueRecoveryActions.evidence} #>> array[${key}::text, ${field}::text])`;
const wakeRetryAt = (key: string) => sql`coalesce(${wakeField(key, "wakeRetryAt")}::bigint, 0)`;

/**
 * Delivers the due wakes a stranded-escalation settlement recorded as pending
 * under `kind.key`; returns when the earliest one still pending is due (epoch
 * ms), or null.
 */
export async function deliverPendingRecoveryWakes(db: Db, wake: RehomeWakeup, scope: { companyId?: string; issueId?: string },
  kind: PendingRecoveryWake) {
  const pendingIn = and(
    scope.companyId ? eq(issueRecoveryActions.companyId, scope.companyId) : undefined,
    scope.issueId ? eq(issueRecoveryActions.sourceIssueId, scope.issueId) : undefined,
    eq(issueRecoveryActions.kind, STRANDED_KIND), eq(issueRecoveryActions.status, "resolved"),
    sql`${wakeField(kind.key, "wake")} = 'pending'`);
  const pending = await db.select({ actionId: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId,
    issueId: issueRecoveryActions.sourceIssueId, agentId: issues.assigneeAgentId,
    wakeFailures: sql<number>`coalesce(${wakeField(kind.key, "wakeFailures")}::int, 0)`,
  }).from(issueRecoveryActions)
    .innerJoin(issues, and(eq(issues.companyId, issueRecoveryActions.companyId), eq(issues.id, issueRecoveryActions.sourceIssueId)))
    // A wake that was refused waits for its retry time, so it cannot hold up the others.
    .where(and(pendingIn, sql`${wakeRetryAt(kind.key)} <= ${Date.now()}::bigint`))
    .orderBy(wakeRetryAt(kind.key), issueRecoveryActions.id).limit(PAGE_SIZE);
  for (const row of pending) {
    // A task that changed since the settlement no longer owes this wake.
    const [task] = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, row.companyId), eq(issues.id, row.issueId)));
    const owed = task?.status === "todo" && Boolean(task.assigneeAgentId) && task.assigneeAgentId === row.agentId;
    // The wake's identity is its recovery action: a run already created for it
    // (a crash after the wake committed, before this record changed) is the
    // delivery, so the continuation never runs twice.
    const [delivered] = owed ? await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, row.companyId), sql`${agentWakeupRequests.payload}->>'issueId' = ${row.issueId}`,
      sql`${agentWakeupRequests.payload}->>'recoveryActionId' = ${row.actionId}`, isNotNull(agentWakeupRequests.runId))).limit(1) : [];
    let accepted = !owed || Boolean(delivered);
    try {
      // Only a created run settles the wake; a refusal (for example a paused
      // company or disabled on-demand wakes) returns null and is retried.
      if (!accepted) accepted = Boolean(await wake(row.agentId!, {
        source: "automation", triggerDetail: "system", reason: "issue_recovery_action_restored",
        payload: { issueId: row.issueId, recoveryActionId: row.actionId, mutation: "recovery_action_resolution" },
        requestedByActorType: "system", requestedByActorId: kind.actorId,
        contextSnapshot: { issueId: row.issueId, taskId: row.issueId, wakeReason: "issue_recovery_action_restored",
          source: "issue.recovery_action_resolution", recoveryActionId: row.actionId,
          ...(kind.forceFreshSession ? { forceFreshSession: true } : {}) },
        issueStateGuard: { statuses: ["todo"], assigneeAgentId: row.agentId! },
      }));
    } catch (error) {
      logger.warn({ err: error, issueId: row.issueId }, "Recovery wake failed; it stays pending");
    }
    const owner = and(eq(issueRecoveryActions.companyId, row.companyId), eq(issueRecoveryActions.id, row.actionId),
      sql`${wakeField(kind.key, "wake")} = 'pending'`);
    if (accepted) {
      await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
        array[${kind.key}::text, 'wake'], ${JSON.stringify(owed ? "delivered" : "not_owed")}::jsonb)` }).where(owner);
      continue;
    }
    // Back off, up to an hour, so a wake that keeps being refused yields to the others.
    const failures = row.wakeFailures + 1;
    const retryAt = Date.now() + Math.min(REHOME_WAKE_RETRY_MAX_MS, REHOME_WAKE_RETRY_BASE_MS * 2 ** (failures - 1));
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(jsonb_set(${issueRecoveryActions.evidence},
      array[${kind.key}::text, 'wakeFailures'], ${JSON.stringify(failures)}::jsonb),
      array[${kind.key}::text, 'wakeRetryAt'], ${JSON.stringify(retryAt)}::jsonb)` }).where(owner);
  }
  const [next] = await db.select({ at: sql<string>`min(${wakeRetryAt(kind.key)})` }).from(issueRecoveryActions).where(pendingIn);
  return next?.at === null || next?.at === undefined ? null : Math.max(Number(next.at), Date.now());
}

async function rehomeOne(tx: Db, input: { actionId: string; companyId: string; issueId: string }) {
  // Lock order: task, then recovery action (the binding release locks the task again).
  const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
  const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.id, input.actionId))).for("update");
  if (!issue || !action || issue.status !== "blocked" || issue.hiddenAt || issue.assigneeUserId || !issue.assigneeAgentId
    || !issue.executionWorkspaceId || action.sourceIssueId !== issue.id || action.kind !== STRANDED_KIND
    || !["active", "escalated"].includes(action.status) || action.evidence.routingPolicy !== BOARD_ESCALATION_POLICY) return null;
  const latestRunId = action.evidence.latestRunId;
  if (typeof latestRunId !== "string") return null;
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.id, latestRunId)));
  // Only a setup failure on a held workspace, before any provider work, by the current assignee.
  const recovery = (run?.resultJson?.executionRecovery ?? null) as { kind?: unknown; providerWorkStarted?: unknown } | null;
  if (!run || run.agentId !== issue.assigneeAgentId || run.status !== "failed" || run.errorCode !== "setup_failed"
    || run.error !== REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE || recovery?.kind !== "bootstrap" || recovery.providerWorkStarted !== false
    || (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== issue.id) return null;
  // The Blocked status belongs to this escalation: set after that run, and no blocker keeps it.
  const blockedAt = issue.blockedTransitionAt?.getTime();
  if (blockedAt === undefined || !run.finishedAt || blockedAt < run.finishedAt.getTime() - 1_000
    || blockedAt > action.updatedAt.getTime() + BLOCK_OWNERSHIP_SLACK_MS) return null;
  // A status decision after the block owns the status now; an earlier one does not matter.
  if (issue.lastStatusDecisionId) {
    const [decision] = await tx.select({ createdAt: statusDecisions.createdAt }).from(statusDecisions).where(and(
      eq(statusDecisions.companyId, input.companyId), eq(statusDecisions.id, issue.lastStatusDecisionId)));
    if (!decision || decision.createdAt.getTime() >= blockedAt) return null;
  }
  // The shared dependency rule: any blocker that still forbids work keeps the task blocked.
  const readiness = await issueService(tx).listDependencyReadiness(input.companyId, [issue.id], tx);
  if (readiness.get(issue.id)?.isDependencyReady !== true) return null;
  const previousExecutionWorkspaceId = issue.executionWorkspaceId;
  if (!await releaseAncestorWorkspaceBinding(tx as never, { companyId: input.companyId, issueId: issue.id })) return null;
  const now = new Date();
  await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now,
    ownerType: "system", ownerAgentId: null, ownerUserId: null, returnOwnerAgentId: issue.assigneeAgentId,
    resolutionNote: LEGACY_WORKSPACE_REHOME_OUTCOME, nextAction: LEGACY_WORKSPACE_REHOME_NOTE, wakePolicy: null, monitorPolicy: null,
    evidence: { ...action.evidence, legacyWorkspaceRehome: { schema: LEGACY_WORKSPACE_REHOME_SCHEMA, previousExecutionWorkspaceId,
      runId: run.id, recordedAt: now.toISOString(), wake: "pending" } },
  }).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, action.id)));
  await tx.update(issues).set({ status: "todo", unblockDescriptor: null, blockedTransitionAt: null,
    blockedOwnerNotifiedAt: null, updatedAt: now }).where(and(eq(issues.companyId, input.companyId), eq(issues.id, issue.id)));
  await notifyStatusCardIssueChange(tx, input.companyId);
  const activity = await persistActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "legacy-workspace-rehome",
    action: "issue.legacy_workspace_rehomed", entityType: "issue", entityId: issue.id, runId: run.id,
    details: { recoveryActionId: action.id, previousExecutionWorkspaceId, status: "todo", note: LEGACY_WORKSPACE_REHOME_NOTE,
      _previous: { status: "blocked" } } });
  return { activity, agentId: issue.assigneeAgentId };
}
