import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { CreateIssueThreadInteraction } from "@paperclipai/shared";
import {
  agentWakeupRequests,
  agents,
  approvals,
  completionContracts,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
  workspaceOperations,
} from "@paperclipai/db";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeStatusDecision,
  type NativeStatusEffect,
} from "./status-arbiter.js";
import { nativeSha256 } from "./canonical.js";
import { issueService } from "../issues.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { buildIssueBlockersResolvedWakeIdempotencyKey } from "../issue-dependency-wakeups.js";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { emitAgentTaskRun } from "../agent-task-run-telemetry.js";

export class NativeStatusRaceError extends Error {
  readonly code = "native_status_race" as const;
  constructor() {
    super("native_status_race");
    this.name = "NativeStatusRaceError";
  }
}

/** Reconciliation delivery resumes ledger work only; it never re-arbitrates. */
export async function dispatchPendingNativeStatusEffects(input: {
  db: Db;
  companyId: string;
  issueId: string;
  decisionId: string;
  runId: string;
}) {
  return input.db.transaction(async (tx) => {
    const coordinator = await tx.select({
      decisionId: nativeRunFinalizations.decisionId,
    }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.issueId, input.issueId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!coordinator || coordinator.decisionId !== input.decisionId) {
      throw new Error("native_pending_effect_decision_binding_mismatch");
    }
    const pending = await tx.select({
      id: statusDecisionEffects.id,
      effectKind: statusDecisionEffects.effectKind,
      targetType: statusDecisionEffects.targetType,
      targetId: statusDecisionEffects.targetId,
    })
      .from(statusDecisionEffects).where(and(
        eq(statusDecisionEffects.companyId, input.companyId),
        eq(statusDecisionEffects.issueId, input.issueId),
        eq(statusDecisionEffects.decisionId, input.decisionId),
        inArray(statusDecisionEffects.deliveryState, ["pending", "failed"]),
    )).for("update");
    if (pending.length === 0) return [];
    for (const effect of pending) {
      await assertPendingEffectTarget(tx as unknown as Db, {
        companyId: input.companyId,
        issueId: input.issueId,
        effectKind: effect.effectKind,
        targetType: effect.targetType,
        targetId: effect.targetId,
      });
    }
    await tx.update(statusDecisionEffects).set({
      deliveryState: "delivered",
      attemptCount: sql`${statusDecisionEffects.attemptCount} + 1`,
      deliveredAt: new Date(),
      nextAttemptAt: null,
      lastError: null,
      updatedAt: new Date(),
    }).where(inArray(statusDecisionEffects.id, pending.map((row) => row.id)));
    await updateRunEffectState({
      tx: tx as unknown as Db,
      companyId: input.companyId,
      runId: input.runId,
      key: "nativeDispatchedEffectIds",
      value: pending.map((row) => row.id),
    });
    return pending.map((row) => row.id);
  });
}

export type NativeStatusCommitFailpoint =
  | "governance_materialization"
  | "interaction_materialization"
  | "continuation_materialization"
  | "blocker_materialization"
  | "recovery_materialization"
  | "status_projection";

export type NativeMaterializedStatusEffect = {
  effectKind: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertNeverEffect(effect: never): never {
  const kind = record(effect).kind;
  throw new Error(`native_status_effect_unimplemented:${String(kind ?? "unknown")}`);
}

async function assertPendingEffectTarget(tx: Db, input: {
  companyId: string;
  issueId: string;
  effectKind: string;
  targetType: string;
  targetId: string | null;
}) {
  if (!input.targetId) throw new Error(`native_pending_effect_target_missing:${input.effectKind}`);
  let found = false;
  if (input.targetType === "agent_wakeup_request") {
    found = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, input.targetId),
      eq(agentWakeupRequests.companyId, input.companyId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "agent") {
    found = await tx.select({ id: agents.id }).from(agents).where(and(
      eq(agents.id, input.targetId),
      eq(agents.companyId, input.companyId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "issue_thread_interaction" || input.targetType === "interaction") {
    found = await tx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, input.targetId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (["delegated_issue", "issue", "issue_checkout", "issue_unblock_descriptor"].includes(input.targetType)) {
    found = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, input.targetId),
      eq(issues.companyId, input.companyId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "issue_recovery_action") {
    found = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.id, input.targetId),
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.issueId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "heartbeat_run") {
    found = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.targetId),
      eq(heartbeatRuns.companyId, input.companyId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "workspace_operation") {
    found = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.id, input.targetId),
      eq(workspaceOperations.companyId, input.companyId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "completion_contract") {
    found = await tx.select({ id: completionContracts.id }).from(completionContracts).where(and(
      eq(completionContracts.id, input.targetId),
      eq(completionContracts.companyId, input.companyId),
      eq(completionContracts.issueId, input.issueId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "status_decision") {
    found = await tx.select({ id: statusDecisions.id }).from(statusDecisions).where(and(
      eq(statusDecisions.id, input.targetId),
      eq(statusDecisions.companyId, input.companyId),
      eq(statusDecisions.issueId, input.issueId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "status_decision_effect") {
    found = await tx.select({ id: statusDecisionEffects.id }).from(statusDecisionEffects).where(and(
      eq(statusDecisionEffects.id, input.targetId),
      eq(statusDecisionEffects.companyId, input.companyId),
      eq(statusDecisionEffects.issueId, input.issueId),
    )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "approval") {
    found = await tx.select({ id: approvals.id }).from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id)).where(and(
        eq(approvals.id, input.targetId),
        eq(approvals.companyId, input.companyId),
        eq(issueApprovals.issueId, input.issueId),
      )).limit(1).then((rows) => rows.length === 1);
  } else if (input.targetType === "execution_stage") {
    found = await tx.select({ executionState: issues.executionState }).from(issues).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
    )).limit(1).then((rows) => record(rows[0]?.executionState).status === "pending");
  } else {
    throw new Error(`native_pending_effect_target_unimplemented:${input.targetType}`);
  }
  if (!found) throw new Error(`native_pending_effect_target_missing:${input.effectKind}`);
}

async function updateRunEffectState(input: {
  tx: Db;
  companyId: string;
  runId: string;
  key: string;
  value: unknown;
  runnerProfile?: boolean;
}) {
  const run = await input.tx.select({
    id: heartbeatRuns.id,
    resultJson: heartbeatRuns.resultJson,
    runnerProfileJson: heartbeatRuns.runnerProfileJson,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId),
  )).for("update").limit(1).then((rows) => rows[0] ?? null);
  if (!run) throw new Error("native_status_run_missing");
  const target = input.runnerProfile ? record(run.runnerProfileJson) : record(run.resultJson);
  await input.tx.update(heartbeatRuns).set({
    ...(input.runnerProfile
      ? { runnerProfileJson: { ...target, [input.key]: input.value } }
      : { resultJson: { ...target, [input.key]: input.value } }),
    updatedAt: new Date(),
  }).where(eq(heartbeatRuns.id, input.runId));
  return run.id;
}

function failAt(actual: NativeStatusCommitFailpoint, requested?: NativeStatusCommitFailpoint) {
  if (actual === requested) throw new Error(`native_status_failpoint:${actual}`);
}

async function enqueueWake(input: {
  tx: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  reason: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  contextSnapshot?: Record<string, unknown>;
}) {
  const existing = await input.tx.select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
      inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed", "completed"]),
    )).limit(1).then((rows) => rows[0] ?? null);
  if (existing) return existing.id;
  const inserted = await input.tx.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    source: "automation",
    triggerDetail: "system",
    reason: input.reason,
    payload: {
      issueId: input.issueId,
      taskId: input.issueId,
      ...input.payload,
      _paperclipWakeContext: {
        issueId: input.issueId,
        taskId: input.issueId,
        ...(input.contextSnapshot ?? {}),
        wakeReason: input.reason,
        source: "native_status_decision",
      },
    },
    requestedByActorType: "system",
    requestedByActorId: "native-status-committer",
    idempotencyKey: input.idempotencyKey,
  }).returning({ id: agentWakeupRequests.id }).then((rows) => rows[0] ?? null);
  if (!inserted) throw new Error("native_status_wake_not_persisted");
  return inserted.id;
}

async function validateGovernanceGate(tx: Db, input: {
  companyId: string;
  issueId: string;
  gate: NonNullable<Extract<NativeStatusEffect, { kind: "create_interaction" }>["gate"]>;
  executionState: unknown;
}) {
  if (input.gate.kind === "execution_stage") {
    const state = input.executionState && typeof input.executionState === "object"
      ? input.executionState as Record<string, unknown>
      : {};
    if (state.status !== "pending") throw new Error("native_governance_gate_resolved");
    return input.gate.id;
  }
  if (input.gate.kind === "interaction") {
    const interaction = await tx.select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.id, input.gate.id),
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (!interaction) throw new Error("native_governance_gate_resolved");
    return interaction.id;
  }
  const approval = await tx.select({ id: approvals.id }).from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .where(and(
      eq(issueApprovals.companyId, input.companyId),
      eq(issueApprovals.issueId, input.issueId),
      eq(approvals.companyId, input.companyId),
      eq(approvals.id, input.gate.id),
      inArray(approvals.status, ["pending", "revision_requested"]),
    )).limit(1).then((rows) => rows[0] ?? null);
  if (!approval) throw new Error("native_governance_gate_resolved");
  return approval.id;
}

async function materializeDecisionEffect(input: {
  tx: Db;
  companyId: string;
  issue: typeof issues.$inferSelect;
  runId: string;
  decisionId: string;
  effect: NativeStatusEffect;
  failpoint?: NativeStatusCommitFailpoint;
  preMaterializedEffects?: ReadonlyMap<string, NativeMaterializedStatusEffect>;
  /** Terminal heartbeat_runs rows this effect wrote. The caller emits agent.task_run for each, after its transaction commits. */
  terminalRunsToEmit?: (typeof heartbeatRuns.$inferSelect)[];
}): Promise<NativeMaterializedStatusEffect> {
  const { effect } = input;
  if (effect.kind === "create_interaction") {
    failAt("governance_materialization", input.failpoint);
    if (effect.gate) {
      const targetId = await validateGovernanceGate(input.tx, {
        companyId: input.companyId,
        issueId: input.issue.id,
        gate: effect.gate,
        executionState: input.issue.executionState,
      });
      return { effectKind: effect.kind, targetType: effect.gate.kind, targetId, payload: { gate: effect.gate } };
    }
    const interaction = await issueThreadInteractionService(input.tx).create(
      input.issue,
      {
        kind: "ask_user_questions",
        idempotencyKey: `native-attention:${input.decisionId}`,
        sourceRunId: input.runId,
        title: "Native attention request",
        summary: "The native runner requires a board response.",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          questions: [{
            id: "response",
            prompt: effect.prompt ?? "Provide the required response.",
            selectionMode: "single",
            options: [{ id: "continue", label: "Continue" }],
          }],
        },
      },
      { systemId: "native-status-committer", runId: input.runId },
    );
    return {
      effectKind: effect.kind,
      targetType: "issue_thread_interaction",
      targetId: interaction.id,
      payload: { interactionId: interaction.id, interactionKind: interaction.kind },
    };
  }
  if (effect.kind === "bind_reviewer") {
    failAt("interaction_materialization", input.failpoint);
    const reviewInput: Extract<CreateIssueThreadInteraction, { kind: "request_confirmation" }> = {
      kind: "request_confirmation",
      idempotencyKey: `native-review:${input.decisionId}`,
      sourceRunId: input.runId,
      resolverPolicy: effect.ownerAgentId ? "anyone" : "human_only",
      addresseeAgentId: effect.ownerAgentId ?? null,
      addresseeUserId: effect.ownerUserId,
      title: "Native completion review",
      summary: "The native runner requires authoritative review before completion.",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: effect.prompt,
        detailsMarkdown: effect.detailsMarkdown ?? null,
        acceptLabel: "Approve completion",
        rejectLabel: "Continue work",
        allowDeclineReason: true,
        rejectRequiresReason: true,
        supersedeOnUserComment: false,
        target: {
          type: "custom",
          key: "native_completion_review",
          revisionId: input.decisionId,
          label: "Completion decision",
        },
      },
    };
    const interaction = await issueThreadInteractionService(input.tx).create(
      input.issue,
      reviewInput,
      { systemId: "native-status-committer", runId: input.runId },
    );
    return {
      effectKind: effect.kind,
      targetType: "issue_thread_interaction",
      targetId: interaction.id,
      payload: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        ownerUserId: effect.ownerUserId,
        ownerAgentId: effect.ownerAgentId ?? null,
      },
    };
  }
  if (effect.kind === "notify_owner") {
    const wakeId = await enqueueWake({
      tx: input.tx,
      companyId: input.companyId,
      issueId: input.issue.id,
      agentId: effect.agentId,
      reason: "issue_status_changed",
      idempotencyKey: `native-status:${input.decisionId}:notify-owner`,
      payload: { nativeDecisionId: input.decisionId, notificationReason: effect.reason },
    });
    return {
      effectKind: effect.kind,
      targetType: "agent_wakeup_request",
      targetId: wakeId,
      payload: { reason: effect.reason },
    };
  }
  if (effect.kind === "create_delegated_issue") {
    const delegated = await issueService(input.tx).create(input.companyId, {
      projectId: input.issue.projectId,
      projectWorkspaceId: input.issue.projectWorkspaceId,
      goalId: input.issue.goalId,
      parentId: input.issue.id,
      title: effect.summary,
      status: "todo",
      priority: input.issue.priority,
      assigneeAgentId: effect.agentId,
      createdByAgentId: input.issue.assigneeAgentId,
      workMode: "standard",
      idempotencyKey: `native-delegation:${input.decisionId}`,
      inheritExecutionWorkspaceFromIssueId: input.issue.id,
    });
    if (!delegated) throw new Error("native_delegated_issue_not_persisted");
    return {
      effectKind: effect.kind,
      targetType: "delegated_issue",
      targetId: delegated.id,
      payload: { summary: effect.summary, agentId: effect.agentId },
    };
  }
  if (effect.kind === "enqueue_continuation") {
    failAt("continuation_materialization", input.failpoint);
    const wakeId = await enqueueWake({
      tx: input.tx,
      companyId: input.companyId,
      issueId: input.issue.id,
      agentId: effect.agentId,
      reason: effect.continuationKind === "monitor" ? "monitor_due" : "issue_status_changed",
      idempotencyKey: `native-status:${input.decisionId}:continuation`,
      payload: {
        nativeDecisionId: input.decisionId,
        continuationKind: effect.continuationKind,
        continuationSummary: effect.summary,
        continuationIdempotencyKey: effect.idempotencyKey,
      },
    });
    return {
      effectKind: effect.kind,
      targetType: "agent_wakeup_request",
      targetId: wakeId,
      payload: { continuationKind: effect.continuationKind, summary: effect.summary },
    };
  }
  if (effect.kind === "bind_blocker") {
    failAt("blocker_materialization", input.failpoint);
    const [bound] = await input.tx.update(issues).set({
      unblockDescriptor: { owner: effect.owner, action: effect.action },
      updatedAt: new Date(),
    }).where(and(
      eq(issues.id, input.issue.id),
      eq(issues.companyId, input.companyId),
    )).returning({ id: issues.id });
    if (!bound) throw new Error("native_blocker_binding_not_persisted");
    let wakeId: string | null = null;
    if (effect.owner !== "board") {
      wakeId = await enqueueWake({
        tx: input.tx,
        companyId: input.companyId,
        issueId: input.issue.id,
        agentId: effect.owner.agentId,
        reason: "issue_status_changed",
        idempotencyKey: `native-status:${input.decisionId}:blocker-owner`,
        payload: { nativeDecisionId: input.decisionId, unblockAction: effect.action },
      });
    }
    return {
      effectKind: effect.kind,
      targetType: "issue_unblock_descriptor",
      targetId: bound.id,
      payload: { owner: effect.owner, action: effect.action, wakeId },
    };
  }
  if (effect.kind === "schedule_retry") {
    failAt("continuation_materialization", input.failpoint);
    const wakeId = await enqueueWake({
      tx: input.tx,
      companyId: input.companyId,
      issueId: input.issue.id,
      agentId: effect.agentId,
      reason: "issue_status_changed",
      idempotencyKey: `native-status:${input.decisionId}:retry`,
      payload: {
        nativeDecisionId: input.decisionId,
        retryCause: effect.cause,
        retrySummary: effect.summary,
      },
    });
    return {
      effectKind: effect.kind,
      targetType: "agent_wakeup_request",
      targetId: wakeId,
      payload: { cause: effect.cause, summary: effect.summary },
    };
  }
  if (effect.kind === "record_finalization_error") {
    failAt("recovery_materialization", input.failpoint);
    const recovery = await issueRecoveryActionService(input.tx).upsertSourceScoped({
      companyId: input.companyId,
      sourceIssueId: input.issue.id,
      kind: "active_run_watchdog",
      ownerType: "agent",
      ownerAgentId: effect.agentId,
      cause: effect.cause,
      fingerprint: nativeSha256({ runId: input.runId, decisionId: input.decisionId, cause: effect.cause }),
      evidence: { runId: input.runId, decisionId: input.decisionId },
      nextAction: effect.nextAction,
      wakePolicy: null,
      maxAttempts: 3,
    });
    return {
      effectKind: effect.kind,
      targetType: "issue_recovery_action",
      targetId: recovery.id,
      payload: { cause: effect.cause, nextAction: effect.nextAction },
    };
  }
  if (effect.kind === "release_run_resources") {
    failAt("recovery_materialization", input.failpoint);
    const [released] = await input.tx.update(heartbeatRuns).set({
      processPid: null,
      processGroupId: null,
      processStartedAt: null,
      nativePhase: "committed",
      nativePhaseUpdatedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
    )).returning({ id: heartbeatRuns.id });
    if (!released) throw new Error("native_run_resources_not_released");
    return {
      effectKind: effect.kind,
      targetType: "heartbeat_run",
      targetId: released.id,
      payload: { processReleased: true },
    };
  }
  if (effect.kind === "record_expiry") {
    failAt("recovery_materialization", input.failpoint);
    if (!input.issue.assigneeAgentId) throw new Error("native_recovery_owner_missing");
    const interaction = await input.tx.select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issue.id),
        inArray(issueThreadInteractions.status, ["pending", "expired"]),
      )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!interaction) throw new Error("native_attention_expiry_target_missing");
    await input.tx.update(issueThreadInteractions).set({
      status: "expired",
      resolvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(issueThreadInteractions.id, interaction.id));
    const cause = "attention_expired";
    const recovery = await issueRecoveryActionService(input.tx).upsertSourceScoped({
      companyId: input.companyId,
      sourceIssueId: input.issue.id,
      kind: "active_run_watchdog",
      ownerType: "agent",
      ownerAgentId: input.issue.assigneeAgentId,
      cause,
      fingerprint: nativeSha256({ runId: input.runId, decisionId: input.decisionId, cause }),
      evidence: { runId: input.runId, decisionId: input.decisionId },
      nextAction: "Review the expired attention route and choose a new authorized path.",
      wakePolicy: null,
      maxAttempts: 3,
    });
    return {
      effectKind: effect.kind,
      targetType: "issue_thread_interaction",
      targetId: interaction.id,
      payload: { cause, recoveryActionId: recovery.id },
    };
  }
  if (effect.kind === "schedule_reconciliation") {
    failAt("recovery_materialization", input.failpoint);
    if (!input.issue.assigneeAgentId) throw new Error("native_recovery_owner_missing");
    const cause = "native_reconciliation_required";
    const recovery = await issueRecoveryActionService(input.tx).upsertSourceScoped({
      companyId: input.companyId,
      sourceIssueId: input.issue.id,
      kind: "active_run_watchdog",
      ownerType: "agent",
      ownerAgentId: input.issue.assigneeAgentId,
      cause,
      fingerprint: nativeSha256({ runId: input.runId, decisionId: input.decisionId, cause }),
      evidence: { runId: input.runId, decisionId: input.decisionId },
      nextAction: "Reconcile the native decision against the latest issue status version.",
      wakePolicy: null,
      maxAttempts: 3,
    });
    return {
      effectKind: effect.kind,
      targetType: "issue_recovery_action",
      targetId: recovery.id,
      payload: { cause },
    };
  }
  if (effect.kind === "accept_replacement_turn") {
    const [run] = await input.tx.update(heartbeatRuns).set({
      status: "running",
      continuationAttempt: sql`${heartbeatRuns.continuationAttempt} + 1`,
      nextAction: "Accept a replacement native turn on the existing run.",
      updatedAt: new Date(),
    }).where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
    )).returning({ id: heartbeatRuns.id, continuationAttempt: heartbeatRuns.continuationAttempt });
    if (!run) throw new Error("native_replacement_turn_not_accepted");
    return {
      effectKind: effect.kind,
      targetType: "heartbeat_run",
      targetId: run.id,
      payload: { continuationAttempt: run.continuationAttempt },
    };
  }
  if (effect.kind === "cancel_continuations") {
    const wakeRows = await input.tx.select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        sql`coalesce(
          ${agentWakeupRequests.payload} ->> 'issueId',
          ${agentWakeupRequests.payload} ->> 'taskId',
          ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId',
          ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId'
        ) = ${input.issue.id}`,
      ));
    if (wakeRows.length > 0) {
      await input.tx.update(agentWakeupRequests).set({
        status: "cancelled",
        finishedAt: new Date(),
        error: "Cancelled by native issue cancellation",
        updatedAt: new Date(),
      }).where(inArray(agentWakeupRequests.id, wakeRows.map((row) => row.id)));
    }
    const interactionRows = await input.tx.select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issue.id),
        eq(issueThreadInteractions.status, "pending"),
      ));
    if (interactionRows.length > 0) {
      await input.tx.update(issueThreadInteractions).set({
        status: "cancelled",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }).where(inArray(issueThreadInteractions.id, interactionRows.map((row) => row.id)));
    }
    const [run] = await input.tx.update(heartbeatRuns).set({
      status: "cancelled",
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
    )).returning();
    if (!run) throw new Error("native_continuation_cancellation_run_missing");
    input.terminalRunsToEmit?.push(run);
    return {
      effectKind: effect.kind,
      targetType: "heartbeat_run",
      targetId: run.id,
      payload: {
        cancelledWakeIds: wakeRows.map((row) => row.id),
        cancelledInteractionIds: interactionRows.map((row) => row.id),
      },
    };
  }
  if (effect.kind === "append_superseding_assessment") {
    const lineage = await input.tx.select({
      currentAssessmentId: statusDecisions.assessmentId,
    }).from(statusDecisions).where(and(
      eq(statusDecisions.id, input.decisionId),
      eq(statusDecisions.companyId, input.companyId),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!lineage) throw new Error("native_superseded_assessment_missing");
    if (!input.issue.lastStatusDecisionId) {
      const assessment = await input.tx.select({
        id: workAssessments.id,
        supersedesAssessmentId: workAssessments.supersedesAssessmentId,
      }).from(workAssessments).where(and(
        eq(workAssessments.id, lineage.currentAssessmentId),
        eq(workAssessments.companyId, input.companyId),
        eq(workAssessments.issueId, input.issue.id),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (!assessment?.supersedesAssessmentId) {
        throw new Error("native_superseding_assessment_not_linked");
      }
      return {
        effectKind: effect.kind,
        targetType: "status_decision",
        targetId: input.decisionId,
        payload: {
          supersedesDecisionId: null,
          assessmentId: assessment.id,
          supersedesAssessmentId: assessment.supersedesAssessmentId,
        },
      };
    }
    const prior = await input.tx.select({
      assessmentId: statusDecisions.assessmentId,
    }).from(statusDecisions).where(and(
      eq(statusDecisions.id, input.issue.lastStatusDecisionId),
      eq(statusDecisions.companyId, input.companyId),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!prior) throw new Error("native_superseded_assessment_missing");
    const [assessment] = await input.tx.update(workAssessments).set({
      supersedesAssessmentId: prior.assessmentId,
    }).where(and(
      eq(workAssessments.id, lineage.currentAssessmentId),
      eq(workAssessments.companyId, input.companyId),
      eq(workAssessments.issueId, input.issue.id),
    )).returning({ id: workAssessments.id });
    if (!assessment) throw new Error("native_superseding_assessment_not_linked");
    const [decision] = await input.tx.update(statusDecisions).set({
      supersedesDecisionId: input.issue.lastStatusDecisionId,
    }).where(and(
      eq(statusDecisions.id, input.decisionId),
      eq(statusDecisions.companyId, input.companyId),
    )).returning({ id: statusDecisions.id });
    if (!decision) throw new Error("native_superseding_assessment_not_linked");
    return {
      effectKind: effect.kind,
      targetType: "status_decision",
      targetId: decision.id,
      payload: {
        supersedesDecisionId: input.issue.lastStatusDecisionId,
        assessmentId: assessment.id,
        supersedesAssessmentId: prior.assessmentId,
      },
    };
  }
  if (effect.kind === "dispatch_pending_effect") {
    const pending = await input.tx.select({ id: statusDecisionEffects.id })
      .from(statusDecisionEffects).where(and(
        eq(statusDecisionEffects.companyId, input.companyId),
        eq(statusDecisionEffects.issueId, input.issue.id),
        inArray(statusDecisionEffects.deliveryState, ["pending", "failed"]),
      )).for("update");
    if (pending.length === 0) throw new Error("native_pending_effect_missing");
    await input.tx.update(statusDecisionEffects).set({
      deliveryState: "delivered",
      attemptCount: sql`${statusDecisionEffects.attemptCount} + 1`,
      deliveredAt: new Date(),
      nextAttemptAt: null,
      lastError: null,
      updatedAt: new Date(),
    }).where(inArray(statusDecisionEffects.id, pending.map((row) => row.id)));
    await updateRunEffectState({
      tx: input.tx,
      companyId: input.companyId,
      runId: input.runId,
      key: "nativeDispatchedEffectIds",
      value: pending.map((row) => row.id),
    });
    return {
      effectKind: effect.kind,
      targetType: "heartbeat_run",
      targetId: input.runId,
      payload: { dispatchedEffectIds: pending.map((row) => row.id) },
    };
  }
  if (effect.kind === "increment_status_version") {
    const updated = await issueService(input.tx).update(input.issue.id, {
      statusVersion: Number(input.issue.statusVersion) + 1,
      actorAgentId: null,
      actorUserId: null,
    }, input.tx);
    if (!updated) throw new Error("native_status_version_not_incremented");
    return {
      effectKind: effect.kind,
      targetType: "issue",
      targetId: updated.id,
      payload: { statusVersion: updated.statusVersion },
    };
  }
  if (effect.kind === "record_shadow_decision") {
    const targetId = await updateRunEffectState({
      tx: input.tx,
      companyId: input.companyId,
      runId: input.runId,
      key: "nativeShadowDecision",
      value: { decisionId: input.decisionId, applicationState: "shadow" },
    });
    return {
      effectKind: effect.kind,
      targetType: "heartbeat_run",
      targetId,
      payload: { decisionId: input.decisionId, applicationState: "shadow" },
    };
  }
  if (effect.kind === "render_four_layers") {
    const targetId = await updateRunEffectState({
      tx: input.tx,
      companyId: input.companyId,
      runId: input.runId,
      key: "nativeOutcomeLayers",
      value: {
        runStatus: "persisted",
        issueStatus: input.issue.status,
        claim: "preserved",
        decisionId: input.decisionId,
      },
    });
    return {
      effectKind: effect.kind,
      targetType: "heartbeat_run",
      targetId,
      payload: { layerCount: 4 },
    };
  }
  if (effect.kind === "materialize_contract") {
    const contract = await input.tx.select({ id: completionContracts.id, canonicalSha256: completionContracts.canonicalSha256 })
      .from(completionContracts).where(and(
        eq(completionContracts.companyId, input.companyId),
        eq(completionContracts.issueId, input.issue.id),
      )).orderBy(desc(completionContracts.revision)).limit(1).then((rows) => rows[0] ?? null);
    if (!contract) throw new Error("native_completion_contract_missing");
    await input.tx.update(heartbeatRuns).set({
      completionContractId: contract.id,
      completionContractSha256: contract.canonicalSha256,
      updatedAt: new Date(),
    }).where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
    ));
    return {
      effectKind: effect.kind,
      targetType: "completion_contract",
      targetId: contract.id,
      payload: { canonicalSha256: contract.canonicalSha256 },
    };
  }
  if (effect.kind === "record_mode_labeled_divergence") {
    const targetId = await updateRunEffectState({
      tx: input.tx,
      companyId: input.companyId,
      runId: input.runId,
      key: "nativeLegacyDivergence",
      value: { mode: "native", decisionId: input.decisionId, classified: true },
    });
    return {
      effectKind: effect.kind,
      targetType: "heartbeat_run",
      targetId,
      payload: { mode: "native", classified: true },
    };
  }
  if (effect.kind === "record_mode_native") {
    const [run] = await input.tx.update(heartbeatRuns).set({
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
    )).returning({ id: heartbeatRuns.id });
    if (!run) throw new Error("native_runtime_mode_not_recorded");
    return { effectKind: effect.kind, targetType: "heartbeat_run", targetId: run.id, payload: { runtimeMode: "native" } };
  }
  if (effect.kind === "record_policy_version") {
    const targetId = await updateRunEffectState({
      tx: input.tx,
      companyId: input.companyId,
      runId: input.runId,
      key: "nativeStatusPolicyVersion",
      value: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      runnerProfile: true,
    });
    return {
      effectKind: effect.kind,
      targetType: "heartbeat_run",
      targetId,
      payload: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION },
    };
  }
  if (effect.kind === "finish_as_native") {
    const targetId = await updateRunEffectState({
      tx: input.tx,
      companyId: input.companyId,
      runId: input.runId,
      key: "nativeKillSwitchDisposition",
      value: "finish_as_native",
    });
    await input.tx.update(heartbeatRuns).set({ runtimeMode: "native", updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, input.runId));
    return { effectKind: effect.kind, targetType: "heartbeat_run", targetId, payload: { runtimeMode: "native" } };
  }
  if (effect.kind === "resume_workspace_operation") {
    const resumed = input.preMaterializedEffects?.get(effect.kind);
    if (!resumed || resumed.targetType !== "workspace_operation" || !resumed.targetId) {
      throw new Error("native_workspace_operation_not_executed");
    }
    const operation = await input.tx.select({ status: workspaceOperations.status }).from(workspaceOperations).where(and(
      eq(workspaceOperations.id, resumed.targetId),
      eq(workspaceOperations.companyId, input.companyId),
      eq(workspaceOperations.heartbeatRunId, input.runId),
      eq(workspaceOperations.issueId, input.issue.id),
      eq(workspaceOperations.phase, "workspace_finalize"),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (operation?.status !== "succeeded") throw new Error("native_workspace_operation_not_succeeded");
    return resumed;
  }
  if (effect.kind === "record_stale_response") {
    const interaction = await input.tx.select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issue.id),
        inArray(issueThreadInteractions.status, ["answered", "accepted", "rejected", "expired"]),
      )).orderBy(desc(issueThreadInteractions.updatedAt)).limit(1).then((rows) => rows[0] ?? null);
    if (!interaction) throw new Error("native_stale_response_missing");
    await input.tx.update(issueThreadInteractions).set({
      summary: "Response retained for audit after native supersession.",
      updatedAt: new Date(),
    }).where(eq(issueThreadInteractions.id, interaction.id));
    return { effectKind: effect.kind, targetType: "issue_thread_interaction", targetId: interaction.id, payload: { status: "superseded" } };
  }
  if (effect.kind === "link_canonical_request") {
    const interactions = await input.tx.select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issue.id),
      )).orderBy(asc(issueThreadInteractions.createdAt)).limit(2);
    if (interactions.length < 2) throw new Error("native_attention_canonical_pair_missing");
    const canonical = interactions[0]!;
    const duplicate = interactions[1]!;
    await input.tx.update(issueThreadInteractions).set({
      summary: `Canonical native attention request: ${canonical.id}`,
      updatedAt: new Date(),
    }).where(eq(issueThreadInteractions.id, duplicate.id));
    return {
      effectKind: effect.kind,
      targetType: "issue_thread_interaction",
      targetId: duplicate.id,
      payload: { canonicalRequestId: canonical.id },
    };
  }
  if (effect.kind === "release_checkout") {
    const [released] = await input.tx.update(issues).set({
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(issues.id, input.issue.id),
      eq(issues.companyId, input.companyId),
    )).returning({ id: issues.id });
    if (!released) throw new Error("native_checkout_not_released");
    return {
      effectKind: effect.kind,
      targetType: "issue_checkout",
      targetId: released.id,
      payload: { checkoutRunId: null, executionRunId: null },
    };
  }
  if (effect.kind === "record_recovery") {
    failAt("recovery_materialization", input.failpoint);
    const recovery = await issueRecoveryActionService(input.tx).upsertSourceScoped({
      companyId: input.companyId,
      sourceIssueId: input.issue.id,
      kind: "active_run_watchdog",
      ownerType: "agent",
      ownerAgentId: effect.agentId,
      cause: effect.cause,
      fingerprint: nativeSha256({ runId: input.runId, decisionId: input.decisionId, cause: effect.cause }),
      evidence: { runId: input.runId, decisionId: input.decisionId },
      nextAction: effect.nextAction,
      wakePolicy: { kind: "resume_native_run", runId: input.runId },
      maxAttempts: 3,
    });
    return {
      effectKind: effect.kind,
      targetType: "issue_recovery_action",
      targetId: recovery.id,
      payload: { cause: effect.cause, nextAction: effect.nextAction },
    };
  }
  return assertNeverEffect(effect);
}

export async function commitNativeStatusDecision(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  assessmentId: string;
  priorStatus: string;
  priorStatusVersion: number;
  priorDecisionId: string | null;
  decision: NativeStatusDecision;
  failpoint?: NativeStatusCommitFailpoint;
  preMaterializedEffects?: NativeMaterializedStatusEffect[];
  supersedesCommittedDecisionId?: string;
}) {
  if (input.decision.reasonCode === null) {
    throw new Error("native_status_reason_code_required");
  }
  const reasonCode = input.decision.reasonCode;
  const publications: ActivityPublication[] = [];
  const terminalRunsToEmit: (typeof heartbeatRuns.$inferSelect)[] = [];
  const committed = await input.db.transaction(async (tx) => {
    const coordinator = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.issueId, input.issueId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!coordinator) throw new Error("native_finalization_coordinator_missing");
    const issue = await tx.select().from(issues).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!issue) throw new NativeStatusRaceError();
    if (coordinator.phase === "committed" && coordinator.decisionId) {
      if (input.supersedesCommittedDecisionId) {
        if (
          coordinator.decisionId !== input.supersedesCommittedDecisionId
          || coordinator.assessmentId === input.assessmentId
        ) {
          throw new NativeStatusRaceError();
        }
      } else {
        const existingDecision = await tx.select().from(statusDecisions).where(and(
          eq(statusDecisions.id, coordinator.decisionId),
          eq(statusDecisions.companyId, input.companyId),
          eq(statusDecisions.issueId, input.issueId),
        )).limit(1).then((rows) => rows[0] ?? null);
        if (!existingDecision) throw new Error("native_committed_decision_missing");
        return { decision: existingDecision, issue, replayed: true };
      }
    }
    if (
      issue.status !== input.priorStatus
      || Number(issue.statusVersion) !== input.priorStatusVersion
      || issue.lastStatusDecisionId !== input.priorDecisionId
    ) {
      throw new NativeStatusRaceError();
    }
    const decisionJson = {
      statusAction: input.decision.statusAction,
      toStatus: input.decision.toStatus,
      reasonCode,
      unblockDescriptor: input.decision.unblockDescriptor,
      effects: input.decision.effects,
      priorStatusVersion: input.priorStatusVersion,
      projectedStatusVersion: input.decision.statusAction === "preserve"
        ? input.priorStatusVersion
        : input.priorStatusVersion + 1,
    };
    const decisionDigest = nativeSha256({
      issueId: input.issueId,
      assessmentId: input.assessmentId,
      policyVersion: input.decision.policyVersion,
      fromStatus: issue.status,
      priorStatusVersion: input.priorStatusVersion,
      priorDecisionId: input.priorDecisionId,
      decision: decisionJson,
    });
    let decisionRow = await tx.select().from(statusDecisions).where(and(
      eq(statusDecisions.issueId, input.issueId),
      eq(statusDecisions.decisionDigest, decisionDigest),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (decisionRow?.applicationState === "applied" || decisionRow?.applicationState === "proposed") {
      return { decision: decisionRow, issue, replayed: true };
    }
    if (!decisionRow) {
      const latestDecisionVersion = await tx.select({
        decisionVersion: statusDecisions.decisionVersion,
      }).from(statusDecisions).where(and(
        eq(statusDecisions.companyId, input.companyId),
        eq(statusDecisions.issueId, input.issueId),
      )).orderBy(desc(statusDecisions.decisionVersion)).limit(1)
        .then((rows) => Number(rows[0]?.decisionVersion ?? 0));
      [decisionRow] = await tx.insert(statusDecisions).values({
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        assessmentId: input.assessmentId,
        decisionVersion: Math.max(input.priorStatusVersion, latestDecisionVersion) + 1,
        policyVersion: input.decision.policyVersion,
        fromStatus: issue.status,
        toStatus: input.decision.toStatus,
        reasonCode,
        decisionJson,
        decisionDigest,
        applicationState: "proposed",
      }).returning();
    }
    if (!decisionRow) throw new Error("native_status_decision_not_persisted");

    const materialized: NativeMaterializedStatusEffect[] = [];
    const preMaterializedEffects = new Map(
      (input.preMaterializedEffects ?? []).map((effect) => [effect.effectKind, effect]),
    );
    for (const effect of input.decision.effects) {
      materialized.push(await materializeDecisionEffect({
        tx: tx as unknown as Db,
        companyId: input.companyId,
        issue,
        runId: input.runId,
        decisionId: decisionRow.id,
        effect,
        failpoint: input.failpoint,
        preMaterializedEffects,
        terminalRunsToEmit,
      }));
    }

    let updated: typeof issues.$inferSelect;
    if (input.decision.statusAction === "preserve") {
      updated = await tx.select().from(issues).where(and(
        eq(issues.id, input.issueId),
        eq(issues.companyId, input.companyId),
      )).limit(1).then((rows) => rows[0] ?? null) as typeof issues.$inferSelect;
      if (!updated) throw new NativeStatusRaceError();
    } else {
      failAt("status_projection", input.failpoint);
      const projected = await issueService(tx as unknown as Db).update(input.issueId, {
        status: input.decision.toStatus,
        statusVersion: input.priorStatusVersion + 1,
        lastStatusDecisionId: decisionRow.id,
        unblockDescriptor: input.decision.unblockDescriptor,
        actorAgentId: null,
        actorUserId: null,
      }, tx, publications);
      if (!projected) throw new NativeStatusRaceError();
      updated = projected;
      materialized.unshift({
        effectKind: "issue_status_projection",
        targetType: "issue",
        targetId: input.issueId,
        payload: { fromStatus: issue.status, toStatus: input.decision.toStatus, reasonCode },
      });
    }

    if (input.decision.statusAction === "done" && issue.status !== "done") {
      const issueSvc = issueService(tx as unknown as Db);
      const dependents = await issueSvc.listWakeableBlockedDependents(input.issueId);
      const completedResultSummary = await tx
        .select({ resultJson: nativeRunResults.resultJson })
        .from(nativeRunResults)
        .where(and(
          eq(nativeRunResults.companyId, input.companyId),
          eq(nativeRunResults.runId, input.runId),
        ))
        .limit(1)
        .then((rows) => {
          const summary = record(record(rows[0]?.resultJson).result).summary;
          return typeof summary === "string" && summary.trim().length > 0 ? summary.trim() : null;
        });
      const parent = issue.parentId
        ? await issueSvc.getWakeableParentAfterChildCompletion(issue.parentId, {
            issueId: input.issueId,
            summary: completedResultSummary,
          })
        : null;
      const parentIsDependent = parent
        ? dependents.some((dependent) => dependent.id === parent.id)
        : false;
      for (const dependent of dependents) {
        const isCompletedChildParent = parent?.id === dependent.id;
        const idempotencyKey = isCompletedChildParent
          ? `issue_children_completed:${dependent.id}:${input.issueId}`
          : buildIssueBlockersResolvedWakeIdempotencyKey({
              dependentIssueId: dependent.id,
              resolvedBlockerIssueId: input.issueId,
            });
        const childCompletionContext = isCompletedChildParent && parent
          ? {
              completedChildIssueId: input.issueId,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            }
          : null;
        const wakeId = await enqueueWake({
          tx: tx as unknown as Db,
          companyId: input.companyId,
          issueId: dependent.id,
          agentId: dependent.assigneeAgentId,
          reason: isCompletedChildParent ? "issue_children_completed" : "issue_blockers_resolved",
          idempotencyKey,
          payload: {
            resolvedBlockerIssueId: input.issueId,
            blockerIssueIds: dependent.blockerIssueIds,
            ...(childCompletionContext ?? {}),
          },
          contextSnapshot: childCompletionContext ?? undefined,
        });
        materialized.push({
          effectKind: isCompletedChildParent ? "parent_dependency_wake" : "dependency_wake",
          targetType: "agent_wakeup_request",
          targetId: wakeId,
          payload: {
            dependentIssueId: dependent.id,
            resolvedBlockerIssueId: input.issueId,
            ...(childCompletionContext ?? {}),
          },
        });
      }
      if (parent && !parentIsDependent) {
          const wakeId = await enqueueWake({
            tx: tx as unknown as Db,
            companyId: input.companyId,
            issueId: parent.id,
            agentId: parent.assigneeAgentId,
            reason: "issue_children_completed",
            idempotencyKey: `issue_children_completed:${parent.id}:${input.issueId}`,
            payload: {
              completedChildIssueId: input.issueId,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
            contextSnapshot: {
              completedChildIssueId: input.issueId,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
          });
          materialized.push({
            effectKind: "parent_wake",
            targetType: "agent_wakeup_request",
            targetId: wakeId,
            payload: {
              parentIssueId: parent.id,
              completedChildIssueId: input.issueId,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
          });
      }
    }

    for (const [index, effect] of materialized.entries()) {
      await tx.insert(statusDecisionEffects).values({
        companyId: input.companyId,
        issueId: input.issueId,
        decisionId: decisionRow.id,
        ordinal: index + 1,
        effectKind: effect.effectKind,
        targetType: effect.targetType,
        targetId: effect.targetId,
        idempotencyKey: `native-status:${decisionRow.id}:${index + 1}`,
        payload: effect.payload,
        deliveryState: "delivered",
        attemptCount: 1,
        deliveredAt: new Date(),
      }).onConflictDoNothing();
    }
    const shadowOnly = input.decision.effects.some((effect) => effect.kind === "record_shadow_decision");
    const finalizationError = input.decision.effects.find((effect) => effect.kind === "record_finalization_error");
    const applicationState = shadowOnly ? "proposed" : "applied";
    await tx.update(statusDecisions).set({
      applicationState,
      appliedAt: shadowOnly ? null : new Date(),
    })
      .where(eq(statusDecisions.id, decisionRow.id));
    await tx.update(nativeRunFinalizations).set({
      phase: finalizationError ? "retryable_failure" : "committed",
      assessmentId: input.assessmentId,
      decisionId: decisionRow.id,
      leaseOwner: null,
      leaseExpiresAt: null,
      failureCode: finalizationError?.cause ?? null,
      failureDetail: finalizationError ? {
        originalFailureCode: finalizationError.cause,
        recoveryOwner: { kind: "agent", agentId: finalizationError.agentId },
        nextAction: finalizationError.nextAction,
      } : null,
      nextAttemptAt: finalizationError ? new Date(Date.now() + 30_000) : null,
      updatedAt: new Date(),
    }).where(eq(nativeRunFinalizations.runId, input.runId));
    const { publication } = await persistActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "native-status-committer",
      action: input.decision.statusAction === "preserve" ? "issue.status_decision_recorded" : "issue.updated",
      entityType: "issue",
      entityId: input.issueId,
      issueId: input.issueId,
      runId: input.runId,
      details: {
        source: "native_status_decision",
        assessmentId: input.assessmentId,
        decisionId: decisionRow.id,
        fromStatus: issue.status,
        toStatus: input.decision.toStatus,
        reasonCode,
        effectCount: materialized.length,
      },
    });
    publications.push(publication);
    return {
      decision: { ...decisionRow, applicationState },
      issue: updated,
      replayed: false,
    };
  });

  for (const publication of publications) publishActivity(publication);
  for (const terminalRun of terminalRunsToEmit) await emitAgentTaskRun(input.db, terminalRun);
  return committed;
}
