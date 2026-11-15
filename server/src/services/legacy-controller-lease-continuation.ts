import path from "node:path";
import { unprocessable } from "../errors.js";
import { and, eq, sql } from "drizzle-orm";
import {
  agentTaskSessions,
  heartbeatRuns,
  agents,
  issues,
  executionWorkspaces,
  issueRecoveryActions,
} from "@paperclipai/db";
import { recordedLocalExecutionStopped } from "./native-local-process-stop.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import {
  getExecutionBlocker,
  hasPendingRunCleanup,
} from "./execution-blocker.js";
import { persistActivity } from "./activity-log.js";
import { notifyIssueGraphRecovery } from "./issue-recovery-notifications.js";
import type { Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import {
  readRunCancellation,
  readControllerLeaseLoss,
  readControllerLeaseLossCause,
} from "./run-cancellation.js";
type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof import("@paperclipai/db").agents.$inferSelect;
export { CONTROLLER_LEASE_RETRY_REASON as LEASE_RESUME_REASON } from "./execution-recovery-attempt.js";
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function isRecoverableControllerLeaseCancellation(
  run: Run | null | undefined,
) {
  const c = readRunCancellation(run?.resultJson ?? null),
    l = readControllerLeaseLoss(run?.resultJson?.controllerLeaseLoss);
  return (
    run?.runtimeMode === "legacy" &&
    run.status === "cancelled" &&
    run.errorCode === "cancelled" &&
    !!run.finishedAt &&
    c?.source === "controller_lease" &&
    c.expected === false &&
    c.initiator?.type === "system" &&
    !!l &&
    !!c &&
    readControllerLeaseLossCause(c) === l.cause &&
    !hasRequiredWorkspaceRecovery(run.resultJson) &&
    !run.resultJson?.workspaceRestoreFailure
  );
}
export async function readControllerLeaseSession(db: Db, run: Run) {
  if (
    !isRecoverableControllerLeaseCancellation(run) ||
    run.scopeKind !== "issue" ||
    !uuid(run.issueId) ||
    run.contextSnapshot?.issueId !== run.issueId
  )
    return null;
  const adapter = parseObject(
    run.runnerProfileJson?.adapterDispatch,
  ).adapterType;
  if (
    typeof adapter !== "string" ||
    !["codex_local", "cursor"].includes(adapter)
  )
    return null;
  const [s] = await db
    .select()
    .from(agentTaskSessions)
    .where(
      and(
        eq(agentTaskSessions.companyId, run.companyId),
        eq(agentTaskSessions.agentId, run.agentId),
        eq(agentTaskSessions.adapterType, adapter),
        eq(agentTaskSessions.taskKey, run.issueId),
        eq(agentTaskSessions.lastRunId, run.id),
      ),
    )
    .limit(1);
  const p = s?.sessionParamsJson,
    wid = run.contextSnapshot.executionWorkspaceId;
  if (
    !p ||
    !uuid(p.sessionId) ||
    s.sessionDisplayId !== p.sessionId ||
    run.sessionIdAfter !== p.sessionId ||
    !uuid(wid) ||
    typeof p.cwd !== "string" ||
    !path.isAbsolute(p.cwd) ||
    !p.__paperclipConfigFingerprint
  )
    return null;
  const [w] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, run.companyId),
        eq(executionWorkspaces.id, wid),
      ),
    )
    .limit(1);
  if (!w || w.cwd !== p.cwd || w.status !== "active" || w.closedAt) return null;
  return {
    sessionId: p.sessionId,
    params: p,
    taskKey: run.issueId,
    workspaceId: wid,
    adapterType: adapter,
  };
}
export async function prepareControllerLeaseRecovery(
  db: Db,
  source: Run,
  agent: Agent,
  now = new Date(),
) {
  const issueId = source.issueId;
  if (!issueId) return null;
  const refused = new Error("lease_recovery_not_admissible");
  try {
    return await db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(issues)
        .where(
          and(eq(issues.companyId, source.companyId), eq(issues.id, issueId)),
        )
        .for("update");
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, source.companyId),
            eq(heartbeatRuns.id, source.id),
          ),
        )
        .for("update");
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.companyId, source.companyId),
            eq(agents.id, source.agentId),
          ),
        )
        .for("share");
      if (
        !currentAgent ||
        ["paused", "terminated", "pending_approval"].includes(
          currentAgent.status,
        ) ||
        ["paused", "pausing", "terminated"].includes(
          currentAgent.lifecycleState,
        )
      )
        throw refused;
      const reader = tx as unknown as Db;
      const checkpoint = run && (await readControllerLeaseSession(reader, run));
      if (
        !task ||
        task.hiddenAt !== null ||
        !run ||
        !run.finishedAt ||
        !checkpoint ||
        agent.status === "paused" ||
        agent.status === "terminated" ||
        agent.companyId !== run.companyId ||
        agent.id !== run.agentId ||
        currentAgent.adapterType !== checkpoint.adapterType ||
        task.assigneeAgentId !== run.agentId ||
        task.assigneeUserId ||
        !["blocked", "in_progress", "in_review"].includes(task.status) ||
        task.executionWorkspaceId !== checkpoint.workspaceId ||
        (task.executionRunId && task.executionRunId !== run.id) ||
        task.unblockDescriptor ||
        !(await recordedLocalExecutionStopped(reader, run)) ||
        (await hasPendingRunCleanup(reader, run.companyId, run.id))
      )
        throw refused;
      const stage = parseObject(run.contextSnapshot?.executionStage),
        state = parseObject(task.executionState);
      const reviewing =
        state?.status === "pending" &&
        parseObject(state.currentParticipant).type === "agent" &&
        parseObject(state.currentParticipant).agentId === run.agentId;
      const addressingChanges =
        state?.status === "changes_requested" &&
        parseObject(state.returnAssignee).type === "agent" &&
        parseObject(state.returnAssignee).agentId === run.agentId;
      const sameRound =
        Object.keys(stage).length > 0 &&
        stage.stageId === state?.currentStageId &&
        stage.stageType === state.currentStageType &&
        (stage.lastDecisionId ?? null) === (state.lastDecisionId ?? null) &&
        (stage.changesRequestedCount ?? 0) ===
          (state.changesRequestedCount ?? 0);
      const validRole =
        stage?.wakeRole === "executor"
          ? addressingChanges
          : (!stage?.wakeRole ||
              stage.wakeRole === "reviewer" ||
              stage.wakeRole === "approver") &&
            reviewing;
      if (
        Object.keys(stage).length
          ? !sameRound || !validRole
          : reviewing || addressingChanges
      )
        throw refused;
      const [unsafe] = await tx.execute(sql`select 1 where
    exists(select 1 from heartbeat_runs n where n.company_id=${run.companyId} and n.id<>${run.id}
      and (n.issue_id=${task.id} or n.native_issue_id=${task.id} or n.context_snapshot->>'issueId'=${task.id})
      and (n.created_at>(select source.created_at from heartbeat_runs source where source.id=${run.id} and source.company_id=${run.companyId}) or n.retry_of_run_id=${run.id} or n.status in ('queued','running','scheduled_retry')))
    or exists(select 1 from issue_thread_interactions q where q.company_id=${run.companyId} and q.issue_id=${task.id} and q.status='pending')
    or exists(select 1 from issue_approvals ia join approvals a on a.id=ia.approval_id and a.company_id=ia.company_id
      where ia.company_id=${run.companyId} and ia.issue_id=${task.id} and a.status in ('pending','revision_requested'))
    or exists(select 1 from activity_log a where a.company_id=${run.companyId} and a.entity_id=${task.id} and a.created_at>${run.finishedAt.toISOString()}::timestamptz
      and a.actor_type in ('user','agent') and (a.action='issue.updated' or a.action like '%stop%' or a.action like '%cancel%'))
    or exists(select 1 from issue_comments boundary where boundary.id=${task.conversationBoundaryCommentId} and boundary.company_id=${run.companyId} and boundary.created_at>${run.createdAt.toISOString()}::timestamptz)
    or exists(select 1 from activity_log manual where manual.company_id=${run.companyId} and manual.entity_id=${task.id}
      and manual.created_at>${(run.startedAt ?? run.createdAt).toISOString()}::timestamptz and manual.actor_type in ('user','agent')
      and manual.details->>'status' in ('blocked','cancelled','done'))
    or exists(select 1 from issue_comments c where c.company_id=${run.companyId} and c.issue_id=${task.id} and c.author_type='user'
      and c.deleted_at is null and c.created_at>${run.finishedAt.toISOString()}::timestamptz)`);
      if (unsafe) throw refused;
      if (task.status === "blocked") {
        const [systemHold] =
          await tx.execute(sql`select 1 from issue_recovery_actions a where a.company_id=${run.companyId} and a.source_issue_id=${task.id}
     and a.cause='legacy_execution_requires_reconciliation' and a.evidence->>'runId'=${run.id}
     and a.evidence->'automaticRecovery'->>'policy'='preserve_without_replay_v1' and a.evidence->'automaticRecovery'->>'replay'='blocked' limit 1`);
        if (!systemHold) throw refused;
      }

      const savedReceipt = parseObject(run.resultJson?.controllerLeaseRecovery);
      const receipt = Object.keys(savedReceipt).length
        ? savedReceipt
        : {
            schema: "paperclip.controller-lease-recovery.v1",
            runId: run.id,
            sessionId: checkpoint.sessionId,
            workspaceId: checkpoint.workspaceId,
            cwd: checkpoint.params.cwd,
            stageId: stage?.stageId ?? null,
            recordedAt: now.toISOString(),
            previousStatus: task.status,
            previousExecutionRunId: task.executionRunId,
            previousResultPolicy:
              run.resultJson?.conversationContinuation ?? null,
          };
      await notifyIssueGraphRecovery(tx, {
        companyId: run.companyId,
        issueId: task.id,
      });
      const resultJson: Record<string, unknown> = {
        ...run.resultJson,
        conversationContinuation: "continue_conversation_v1",
        controllerLeaseRecovery: receipt,
      };
      await tx
        .update(heartbeatRuns)
        .set({ resultJson, updatedAt: now })
        .where(eq(heartbeatRuns.id, run.id));
      if (await getExecutionBlocker(reader, run.companyId, task.id))
        throw refused;
      await tx
        .update(issues)
        .set({
          status: reviewing ? "in_review" : "in_progress",
          executionRunId: run.id,
          executionLockedAt: now,
          statusVersion: sql`${issues.statusVersion}+1`,
          updatedAt: now,
        })
        .where(eq(issues.id, task.id));
      if (!run.resultJson?.controllerLeaseRecovery)
        await persistActivity(tx as unknown as Db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "controller_lease_recovery",
          action: "issue.controller_lease_recovery_prepared",
          entityType: "issue",
          entityId: task.id,
          details: {
            sourceRunId: run.id,
            sessionId: checkpoint.sessionId,
            workspaceId: checkpoint.workspaceId,
            stageId: receipt.stageId,
            previousStatus: task.status,
            status: reviewing ? "in_review" : "in_progress",
          },
        });
      return {
        ...run,
        resultJson,
        contextSnapshot: { ...run.contextSnapshot, forceFreshSession: false },
      };
    });
  } catch (e) {
    if (e === refused) return null;
    throw e;
  }
}
export async function rollbackControllerLeasePreparation(db: Db, run: Run) {
  const issueId = run.issueId;
  if (!issueId) return;
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)))
      .for("update");
    const [current] = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id))
      .for("update");
    const r = parseObject(current?.resultJson?.controllerLeaseRecovery);
    if (!current || !r.sessionId || !task || task.executionRunId !== run.id)
      return;
    const [child] = await tx.execute(
      sql`select 1 from heartbeat_runs where company_id=${run.companyId} and retry_of_run_id=${run.id} limit 1`,
    );
    if (child) return;
    await notifyIssueGraphRecovery(tx, {
      companyId: run.companyId,
      issueId: task.id,
    });
    const resultJson: Record<string, unknown> = { ...current.resultJson };
    delete resultJson.controllerLeaseRecovery;
    if (r.previousResultPolicy === null)
      delete resultJson.conversationContinuation;
    else resultJson.conversationContinuation = r.previousResultPolicy;
    await tx
      .update(heartbeatRuns)
      .set({ resultJson })
      .where(eq(heartbeatRuns.id, run.id));
    const expectedStatus =
      run.contextSnapshot?.executionStage &&
      parseObject(run.contextSnapshot.executionStage).wakeRole !== "executor"
        ? "in_review"
        : "in_progress";
    const unchanged =
      task.status === expectedStatus &&
      task.assigneeAgentId === run.agentId &&
      task.executionWorkspaceId === r.workspaceId;
    await tx
      .update(issues)
      .set({
        ...(unchanged
          ? {
              status:
                typeof r.previousStatus === "string"
                  ? r.previousStatus
                  : task.status,
            }
          : {}),
        executionRunId:
          typeof r.previousExecutionRunId === "string"
            ? r.previousExecutionRunId
            : null,
        executionLockedAt: null,
        statusVersion: sql`${issues.statusVersion}+1`,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, task.id));
  });
}
export async function exhaustControllerLeaseRecovery(
  db: Db,
  run: Run,
  now = new Date(),
) {
  const issueId = run.issueId;
  if (!issueId) return;
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)))
      .for("update");
    const [current] = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id))
      .for("update");
    if (
      !task ||
      task.executionRunId !== run.id ||
      !current?.resultJson?.controllerLeaseRecovery
    )
      return;
    const [child] = await tx.execute(
      sql`select 1 from heartbeat_runs where company_id=${run.companyId} and retry_of_run_id=${run.id} limit 1`,
    );
    if (child) return;
    await notifyIssueGraphRecovery(tx, {
      companyId: run.companyId,
      issueId: task.id,
    });
    const resultJson: Record<string, unknown> = {
      ...current.resultJson,
      controllerLeaseRecovery: {
        ...parseObject(current.resultJson.controllerLeaseRecovery),
        exhaustedAt: now.toISOString(),
      },
    };
    delete resultJson.conversationContinuation;
    await tx
      .update(heartbeatRuns)
      .set({ resultJson })
      .where(eq(heartbeatRuns.id, run.id));
    await tx
      .update(issues)
      .set({
        status: "blocked",
        executionRunId: null,
        executionLockedAt: null,
        statusVersion: sql`${issues.statusVersion}+1`,
        updatedAt: now,
      })
      .where(eq(issues.id, task.id));
    await tx.insert(issueRecoveryActions).values({
      companyId: run.companyId,
      sourceIssueId: task.id,
      kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: "controller-lease-exhausted:" + run.id,
      status: "escalated",
      ownerType: "board",
      nextAction:
        "Controller lease recovery failed three times. Inspect controller/database availability before continuing the retained session.",
      evidence: {
        runId: run.id,
        automaticRecovery: {
          policy: "controller_lease_resume_v1",
          replay: "blocked",
        },
        controllerLeaseRecovery: resultJson.controllerLeaseRecovery,
      },
    });
    await persistActivity(tx as unknown as Db, {
      companyId: run.companyId,
      actorType: "system",
      actorId: "controller_lease_recovery",
      action: "issue.controller_lease_recovery_exhausted",
      entityType: "issue",
      entityId: task.id,
      details: { sourceRunId: run.id, attempts: 3, status: "blocked" },
    });
  });
}

export function assertControllerLeaseSession(input: {
  context: Record<string, unknown>;
  sessionId: string | null;
  sessionSourceRunId: string | null;
  workspaceId: string | null;
  cwd: string | null;
  reset: boolean;
}) {
  if (input.context.requireExistingSession !== true) return;
  const retained = parseObject(input.context.controllerLeaseResume);
  if (
    input.reset ||
    input.sessionId !== retained.sessionId ||
    !input.sessionId ||
    input.sessionSourceRunId !== retained.sourceRunId ||
    input.workspaceId !== retained.workspaceId ||
    input.cwd !== retained.cwd
  ) {
    throw unprocessable(
      "resume_session_unavailable: the retained conversation or its configuration changed; repair it before continuing.",
      { code: "resume_session_unavailable" },
    );
  }
}
