import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type {
  IssueExecutionHealthApprovalEvidence,
  IssueExecutionHealthBlockerEvidence,
  IssueExecutionHealthEvidence,
  IssueExecutionHealthInteractionEvidence,
  IssueExecutionHealthQueuedWakeEvidence,
  IssueExecutionHealthReasonCode,
  IssueExecutionHealthRecoveryEvidence,
  IssueExecutionHealthRunEvidence,
  IssueExecutionHealthState,
  IssueExecutionHealthSummary,
} from "@paperclipai/shared";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";

export const ISSUE_EXECUTION_HEALTH_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ISSUE_EXECUTION_HEALTH_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);
const ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;
const PENDING_INTERACTION_STATUSES = ["pending"] as const;
const PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);
const RECOVERY_ORIGIN_KIND_LIST = [
  RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
  RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation,
  RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
] as const;

export interface IssueExecutionHealthIssueInput {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionRunId: string | null;
  executionPolicy: Record<string, unknown> | null;
  executionState: Record<string, unknown> | null;
}

export interface IssueExecutionHealthRunInput {
  id: string;
  status: string;
  livenessState: string | null;
  livenessReason: string | null;
  lastOutputAt: Date | null;
  processStartedAt: Date | null;
  startedAt: Date | null;
  createdAt: Date | null;
  silenceSnoozedUntil: Date | null;
}

export interface IssueExecutionHealthQueuedWakeInput {
  id: string;
  reason: string | null;
  status: string;
}

export interface IssueExecutionHealthInteractionInput {
  id: string;
  kind: string;
  status: string;
}

export interface IssueExecutionHealthApprovalInput {
  id: string;
  status: string;
}

export interface IssueExecutionHealthRecoveryInput {
  id: string;
  identifier: string | null;
  originKind: string;
  status: string;
}

export interface IssueExecutionHealthBlockerInput {
  id: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeAgentStatus: string | null;
  assigneeUserId: string | null;
}

export interface IssueExecutionHealthClassifyInput {
  issue: IssueExecutionHealthIssueInput;
  activeRun: IssueExecutionHealthRunInput | null;
  queuedWakes: IssueExecutionHealthQueuedWakeInput[];
  pendingInteractions: IssueExecutionHealthInteractionInput[];
  pendingApprovals: IssueExecutionHealthApprovalInput[];
  openRecoveryIssues: IssueExecutionHealthRecoveryInput[];
  blockers: IssueExecutionHealthBlockerInput[];
  assigneeAgentStatus: string | null;
  now?: Date;
}

function silenceStartedAt(run: IssueExecutionHealthRunInput) {
  return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
}

function classifySilenceLevel(run: IssueExecutionHealthRunInput, now: Date): IssueExecutionHealthRunEvidence["silenceLevel"] {
  if (run.status !== "running") return "not_applicable";
  if (run.silenceSnoozedUntil && run.silenceSnoozedUntil.getTime() > now.getTime()) return "snoozed";
  const startedAt = silenceStartedAt(run);
  if (!startedAt) return "ok";
  const ageMs = Math.max(0, now.getTime() - startedAt.getTime());
  if (ageMs >= ISSUE_EXECUTION_HEALTH_CRITICAL_THRESHOLD_MS) return "critical";
  if (ageMs >= ISSUE_EXECUTION_HEALTH_SUSPICION_THRESHOLD_MS) return "suspicious";
  return "ok";
}

function summarizeRun(run: IssueExecutionHealthRunInput, now: Date): IssueExecutionHealthRunEvidence {
  return {
    runId: run.id,
    status: run.status,
    livenessState: run.livenessState,
    livenessReason: run.livenessReason,
    silenceLevel: classifySilenceLevel(run, now),
  };
}

function summarizeWake(wake: IssueExecutionHealthQueuedWakeInput): IssueExecutionHealthQueuedWakeEvidence {
  return { wakeupRequestId: wake.id, reason: wake.reason, status: wake.status };
}

function summarizeInteraction(interaction: IssueExecutionHealthInteractionInput): IssueExecutionHealthInteractionEvidence {
  return { interactionId: interaction.id, kind: interaction.kind, status: interaction.status };
}

function summarizeApproval(approval: IssueExecutionHealthApprovalInput): IssueExecutionHealthApprovalEvidence {
  return { approvalId: approval.id, status: approval.status };
}

function summarizeRecovery(recovery: IssueExecutionHealthRecoveryInput): IssueExecutionHealthRecoveryEvidence {
  return {
    recoveryIssueId: recovery.id,
    recoveryIssueIdentifier: recovery.identifier,
    originKind: recovery.originKind,
  };
}

function summarizeBlocker(blocker: IssueExecutionHealthBlockerInput): IssueExecutionHealthBlockerEvidence {
  return {
    blockerIssueId: blocker.id,
    blockerIssueIdentifier: blocker.identifier,
    blockerStatus: blocker.status,
  };
}

function readPrincipalAgentId(executionState: Record<string, unknown> | null): string | null {
  if (!executionState) return null;
  const participant = executionState.currentParticipant;
  if (!participant || typeof participant !== "object") return null;
  const value = participant as Record<string, unknown>;
  if (value.type !== "agent") return null;
  return typeof value.agentId === "string" && value.agentId.length > 0 ? value.agentId : null;
}

function readPrincipalUserId(executionState: Record<string, unknown> | null): string | null {
  if (!executionState) return null;
  const participant = executionState.currentParticipant;
  if (!participant || typeof participant !== "object") return null;
  const value = participant as Record<string, unknown>;
  if (value.type !== "user") return null;
  return typeof value.userId === "string" && value.userId.length > 0 ? value.userId : null;
}

function buildSummary(input: {
  state: IssueExecutionHealthState;
  reasonCode: IssueExecutionHealthReasonCode;
  reason: string;
  nextActionOwner: IssueExecutionHealthSummary["nextActionOwner"];
  evidence: IssueExecutionHealthEvidence;
  now: Date;
}): IssueExecutionHealthSummary {
  return {
    state: input.state,
    reasonCode: input.reasonCode,
    reason: input.reason,
    nextActionOwner: input.nextActionOwner,
    evidence: input.evidence,
    evaluatedAt: input.now.toISOString(),
  };
}

export function classifyIssueExecutionHealth(input: IssueExecutionHealthClassifyInput): IssueExecutionHealthSummary {
  const now = input.now ?? new Date();
  const { issue } = input;

  if (TERMINAL_ISSUE_STATUSES.has(issue.status)) {
    return buildSummary({
      state: "no_action_path",
      reasonCode: "issue_terminal",
      reason: `Issue is ${issue.status}; no further action expected.`,
      nextActionOwner: "none",
      evidence: {},
      now,
    });
  }

  // Active execution run takes precedence (silent or not).
  if (input.activeRun) {
    const runEvidence = summarizeRun(input.activeRun, now);
    if (runEvidence.silenceLevel === "critical") {
      return buildSummary({
        state: "watchdog_review",
        reasonCode: "silent_active_run_under_watchdog",
        reason: `Active run ${input.activeRun.id} has been silent past the critical threshold.`,
        nextActionOwner: "system",
        evidence: { activeRun: runEvidence },
        now,
      });
    }
    return buildSummary({
      state: "live_run",
      reasonCode: "active_execution_run",
      reason: `Active heartbeat run ${input.activeRun.id} is ${input.activeRun.status}.`,
      nextActionOwner: "assignee_agent",
      evidence: { activeRun: runEvidence },
      now,
    });
  }

  // Open recovery issues handle their own next action through a follow-up agent.
  if (input.openRecoveryIssues.length > 0) {
    const recovery = input.openRecoveryIssues[0]!;
    return buildSummary({
      state: "recovering",
      reasonCode: "open_recovery_issue",
      reason: `Open recovery issue ${recovery.identifier ?? recovery.id} (${recovery.originKind}) owns the next action.`,
      nextActionOwner: "recovery_owner",
      evidence: { recoveryIssue: summarizeRecovery(recovery) },
      now,
    });
  }

  // Pending issue thread interaction blocks the assignee until resolved.
  if (input.pendingInteractions.length > 0) {
    const interaction = input.pendingInteractions[0]!;
    return buildSummary({
      state: "awaiting_interaction",
      reasonCode: "pending_issue_thread_interaction",
      reason: `Issue is awaiting a ${interaction.kind} interaction response.`,
      nextActionOwner: "assignee_user",
      evidence: { pendingInteraction: summarizeInteraction(interaction) },
      now,
    });
  }

  // Pending linked approval blocks the assignee until resolved.
  if (input.pendingApprovals.length > 0) {
    const approval = input.pendingApprovals[0]!;
    return buildSummary({
      state: "awaiting_approval",
      reasonCode: "pending_linked_approval",
      reason: `Linked approval ${approval.id} is ${approval.status}.`,
      nextActionOwner: "system",
      evidence: { pendingApproval: summarizeApproval(approval) },
      now,
    });
  }

  // Execution-policy review participants own the next action while in_review.
  if (issue.status === "in_review") {
    const participantAgentId = readPrincipalAgentId(issue.executionState);
    const participantUserId = readPrincipalUserId(issue.executionState);
    if (participantAgentId) {
      return buildSummary({
        state: "awaiting_review_participant",
        reasonCode: "execution_policy_participant_owns_next_action",
        reason: `Execution-policy review participant agent ${participantAgentId} owns the next action.`,
        nextActionOwner: "review_participant",
        evidence: {},
        now,
      });
    }
    if (participantUserId) {
      return buildSummary({
        state: "awaiting_user",
        reasonCode: "human_assignee_owns_next_action",
        reason: `Execution-policy review participant user ${participantUserId} owns the next action.`,
        nextActionOwner: "review_participant",
        evidence: {},
        now,
      });
    }
    if (issue.assigneeUserId) {
      return buildSummary({
        state: "awaiting_user",
        reasonCode: "human_assignee_owns_next_action",
        reason: `Issue is in review with human assignee ${issue.assigneeUserId}.`,
        nextActionOwner: "assignee_user",
        evidence: {},
        now,
      });
    }
    return buildSummary({
      state: "invalid_state",
      reasonCode: "in_review_without_action_path",
      reason: "Issue is in review but no participant, user assignee, interaction, approval, or recovery issue owns the next action.",
      nextActionOwner: "none",
      evidence: {},
      now,
    });
  }

  // Human-assigned non-review work waits on the human user.
  if (issue.assigneeUserId) {
    return buildSummary({
      state: "awaiting_user",
      reasonCode: "human_assignee_owns_next_action",
      reason: `Issue is assigned to human user ${issue.assigneeUserId}.`,
      nextActionOwner: "assignee_user",
      evidence: {},
      now,
    });
  }

  // Blocked issues classify by blocker chain validity.
  if (issue.status === "blocked") {
    const unresolvedBlockers = input.blockers.filter(
      (blocker) => !TERMINAL_ISSUE_STATUSES.has(blocker.status) || blocker.status === "cancelled",
    );
    if (unresolvedBlockers.length === 0) {
      return buildSummary({
        state: "invalid_state",
        reasonCode: "blocked_by_unassigned_issue",
        reason: "Issue is blocked but has no unresolved blockers; the blocker chain is invalid.",
        nextActionOwner: "none",
        evidence: {},
        now,
      });
    }
    const cancelledBlocker = unresolvedBlockers.find((blocker) => blocker.status === "cancelled");
    if (cancelledBlocker) {
      return buildSummary({
        state: "invalid_state",
        reasonCode: "blocked_by_cancelled_issue",
        reason: `Issue is blocked by cancelled issue ${cancelledBlocker.identifier ?? cancelledBlocker.id}.`,
        nextActionOwner: "none",
        evidence: { blocker: summarizeBlocker(cancelledBlocker) },
        now,
      });
    }
    const orphanBlocker = unresolvedBlockers.find(
      (blocker) => !blocker.assigneeAgentId && !blocker.assigneeUserId,
    );
    if (orphanBlocker) {
      return buildSummary({
        state: "invalid_state",
        reasonCode: "blocked_by_unassigned_issue",
        reason: `Issue is blocked by unassigned issue ${orphanBlocker.identifier ?? orphanBlocker.id}.`,
        nextActionOwner: "none",
        evidence: { blocker: summarizeBlocker(orphanBlocker) },
        now,
      });
    }
    const uninvokableBlocker = unresolvedBlockers.find(
      (blocker) =>
        blocker.assigneeAgentId &&
        !blocker.assigneeUserId &&
        !INVOKABLE_AGENT_STATUSES.has(blocker.assigneeAgentStatus ?? ""),
    );
    if (uninvokableBlocker) {
      return buildSummary({
        state: "invalid_state",
        reasonCode: "agent_uninvokable",
        reason: `Issue is blocked by ${uninvokableBlocker.identifier ?? uninvokableBlocker.id} whose assignee agent is ${uninvokableBlocker.assigneeAgentStatus ?? "missing"}.`,
        nextActionOwner: "none",
        evidence: { blocker: summarizeBlocker(uninvokableBlocker) },
        now,
      });
    }
    const leadBlocker = unresolvedBlockers[0]!;
    return buildSummary({
      state: "blocked_waiting",
      reasonCode: "unresolved_blocker_chain_covered",
      reason: `Issue is blocked by ${leadBlocker.identifier ?? leadBlocker.id}; blocker chain is covered.`,
      nextActionOwner: "blocker_owner",
      evidence: { blocker: summarizeBlocker(leadBlocker) },
      now,
    });
  }

  // Queued wake counts as a planned execution path.
  if (input.queuedWakes.length > 0) {
    const wake = input.queuedWakes[0]!;
    return buildSummary({
      state: "queued_wake",
      reasonCode: "queued_assignment_or_continuation",
      reason: `Queued wake ${wake.id} (${wake.reason ?? "no reason"}) is awaiting dispatch.`,
      nextActionOwner: "assignee_agent",
      evidence: { queuedWake: summarizeWake(wake) },
      now,
    });
  }

  // Assigned-agent issues without an active run, queued wake, recovery, or other path.
  if (issue.assigneeAgentId) {
    if (input.assigneeAgentStatus && !INVOKABLE_AGENT_STATUSES.has(input.assigneeAgentStatus)) {
      return buildSummary({
        state: "invalid_state",
        reasonCode: "agent_uninvokable",
        reason: `Assigned agent ${issue.assigneeAgentId} is ${input.assigneeAgentStatus} and cannot be invoked.`,
        nextActionOwner: "none",
        evidence: {},
        now,
      });
    }
    if (issue.status === "todo") {
      return buildSummary({
        state: "no_action_path",
        reasonCode: "assigned_todo_without_dispatch_path",
        reason: "Issue is todo with an agent assignee but no active run, queued wake, or recovery issue owning dispatch.",
        nextActionOwner: "none",
        evidence: {},
        now,
      });
    }
    if (issue.status === "in_progress") {
      return buildSummary({
        state: "no_action_path",
        reasonCode: "assigned_in_progress_without_execution_path",
        reason: "Issue is in_progress with an agent assignee but no active run, queued wake, or recovery issue owning execution.",
        nextActionOwner: "none",
        evidence: {},
        now,
      });
    }
    return buildSummary({
      state: "no_action_path",
      reasonCode: "assigned_in_progress_without_execution_path",
      reason: `Issue status ${issue.status} has an agent assignee but no active execution path.`,
      nextActionOwner: "none",
      evidence: {},
      now,
    });
  }

  // No assignee at all.
  return buildSummary({
    state: "invalid_state",
    reasonCode: "blocked_by_unassigned_issue",
    reason: "Issue is unassigned and has no waiting path.",
    nextActionOwner: "none",
    evidence: {},
    now,
  });
}

export function issueExecutionHealthService(db: Db) {
  async function gatherActiveRun(issue: IssueExecutionHealthIssueInput): Promise<IssueExecutionHealthRunInput | null> {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
        livenessReason: heartbeatRuns.livenessReason,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        processStartedAt: heartbeatRuns.processStartedAt,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const snoozeRow = await db
      .select({ snoozedUntil: heartbeatRunWatchdogDecisions.snoozedUntil })
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, issue.companyId),
          eq(heartbeatRunWatchdogDecisions.runId, row.id),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
        ),
      )
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
      .limit(1);
    return {
      ...row,
      silenceSnoozedUntil: snoozeRow[0]?.snoozedUntil ?? null,
    };
  }

  async function gatherQueuedWakes(issue: IssueExecutionHealthIssueInput): Promise<IssueExecutionHealthQueuedWakeInput[]> {
    if (!issue.assigneeAgentId) return [];
    const rows = await db
      .select({
        id: agentWakeupRequests.id,
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, issue.companyId),
          eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
          inArray(agentWakeupRequests.status, [...ACTIVE_WAKE_STATUSES]),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(agentWakeupRequests.requestedAt));
    return rows;
  }

  async function gatherPendingInteractions(issue: IssueExecutionHealthIssueInput): Promise<IssueExecutionHealthInteractionInput[]> {
    const rows = await db
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          inArray(issueThreadInteractions.status, [...PENDING_INTERACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueThreadInteractions.createdAt));
    return rows;
  }

  async function gatherPendingApprovals(issue: IssueExecutionHealthIssueInput): Promise<IssueExecutionHealthApprovalInput[]> {
    const rows = await db
      .select({
        id: approvals.id,
        status: approvals.status,
      })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(issueApprovals.companyId, issue.companyId),
          eq(issueApprovals.issueId, issue.id),
          inArray(approvals.status, [...PENDING_APPROVAL_STATUSES]),
        ),
      );
    return rows;
  }

  async function gatherOpenRecoveryIssues(issue: IssueExecutionHealthIssueInput): Promise<IssueExecutionHealthRecoveryInput[]> {
    const blockerRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        originKind: issues.originKind,
        status: issues.status,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, issue.companyId),
          eq(issueRelations.relatedIssueId, issue.id),
          eq(issueRelations.type, "blocks"),
          inArray(issues.originKind, [...RECOVERY_ORIGIN_KIND_LIST]),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    if (blockerRows.length > 0) return blockerRows;

    if (!issue.executionRunId) return [];
    const staleRunRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        originKind: issues.originKind,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation),
          eq(issues.originId, issue.executionRunId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    return staleRunRows;
  }

  async function gatherBlockers(issue: IssueExecutionHealthIssueInput): Promise<IssueExecutionHealthBlockerInput[]> {
    if (issue.status !== "blocked") return [];
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        assigneeAgentStatus: agents.status,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
      .where(
        and(
          eq(issueRelations.companyId, issue.companyId),
          eq(issueRelations.relatedIssueId, issue.id),
          eq(issueRelations.type, "blocks"),
          isNull(issues.hiddenAt),
        ),
      );
    return rows;
  }

  async function gatherAssigneeAgentStatus(issue: IssueExecutionHealthIssueInput): Promise<string | null> {
    if (!issue.assigneeAgentId) return null;
    const row = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, issue.assigneeAgentId))
      .limit(1);
    return row[0]?.status ?? null;
  }

  async function summarize(issue: IssueExecutionHealthIssueInput, now: Date = new Date()): Promise<IssueExecutionHealthSummary> {
    const [activeRun, queuedWakes, pendingInteractions, pendingApprovals, openRecoveryIssues, blockers, assigneeAgentStatus] =
      await Promise.all([
        gatherActiveRun(issue),
        gatherQueuedWakes(issue),
        gatherPendingInteractions(issue),
        gatherPendingApprovals(issue),
        gatherOpenRecoveryIssues(issue),
        gatherBlockers(issue),
        gatherAssigneeAgentStatus(issue),
      ]);
    return classifyIssueExecutionHealth({
      issue,
      activeRun,
      queuedWakes,
      pendingInteractions,
      pendingApprovals,
      openRecoveryIssues,
      blockers,
      assigneeAgentStatus,
      now,
    });
  }

  return {
    summarize,
    classifyIssueExecutionHealth,
  };
}
