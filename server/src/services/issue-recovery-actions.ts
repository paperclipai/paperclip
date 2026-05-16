import { and, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type {
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const satisfies readonly IssueRecoveryActionStatus[];
const ACTIVE_EXECUTION_PATH_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;
const PENDING_INTERACTION_STATUSES = ["pending"] as const;
const PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const MISSING_DISPOSITION_KIND = "missing_disposition" as const satisfies IssueRecoveryActionKind;
const MAX_UPSERT_RETRIES = 3;

type IssueRecoveryActionRow = typeof issueRecoveryActions.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;
type SourceIssueRow = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "identifier"
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "executionState"
  | "monitorNextCheckAt"
>;

type MissingDispositionResolutionReason =
  | "source_closed_done"
  | "source_closed_cancelled"
  | "queued_continuation_owner"
  | "review_human_owner"
  | "review_execution_participant"
  | "blocked_human_owner"
  | "blocked_first_class_blocker"
  | "scheduled_monitor"
  | "pending_issue_thread_interaction"
  | "pending_approval"
  | "live_execution_path";

type MissingDispositionResolution = {
  outcome: IssueRecoveryActionOutcome;
  reason: MissingDispositionResolutionReason;
  note: string;
};

export type UpsertIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId?: string | null;
  kind: IssueRecoveryActionKind;
  ownerType?: IssueRecoveryActionOwnerType;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  previousOwnerAgentId?: string | null;
  returnOwnerAgentId?: string | null;
  cause: string;
  fingerprint: string;
  evidence?: Record<string, unknown>;
  nextAction: string;
  wakePolicy?: Record<string, unknown> | null;
  monitorPolicy?: Record<string, unknown> | null;
  maxAttempts?: number | null;
  timeoutAt?: Date | null;
  lastAttemptAt?: Date | null;
};

export type ResolveIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
  status: Extract<IssueRecoveryActionStatus, "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
  resolutionNote?: string | null;
};

function toReadModel(row: IssueRecoveryActionRow): IssueRecoveryAction {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceIssueId: row.sourceIssueId,
    recoveryIssueId: row.recoveryIssueId,
    kind: row.kind as IssueRecoveryAction["kind"],
    status: row.status as IssueRecoveryAction["status"],
    ownerType: row.ownerType as IssueRecoveryAction["ownerType"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    previousOwnerAgentId: row.previousOwnerAgentId,
    returnOwnerAgentId: row.returnOwnerAgentId,
    cause: row.cause,
    fingerprint: row.fingerprint,
    evidence: row.evidence,
    nextAction: row.nextAction,
    wakePolicy: row.wakePolicy,
    monitorPolicy: row.monitorPolicy,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    timeoutAt: row.timeoutAt,
    lastAttemptAt: row.lastAttemptAt,
    outcome: row.outcome as IssueRecoveryAction["outcome"],
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function hasFutureDate(value: Date | null, now: Date) {
  return value instanceof Date && value.getTime() > now.getTime();
}

function hasExecutionParticipant(value: unknown) {
  const state = parseIssueExecutionState(value);
  if (!state || state.status !== "pending") return false;
  const participant = state.currentParticipant;
  if (!participant) return false;
  if (participant.type === "agent") return Boolean(participant.agentId);
  if (participant.type === "user") return Boolean(participant.userId);
  return false;
}

function missingDispositionResolutionNote(reason: MissingDispositionResolutionReason) {
  switch (reason) {
    case "source_closed_done":
      return "Auto-resolved missing-disposition recovery: source issue is done.";
    case "source_closed_cancelled":
      return "Auto-resolved missing-disposition recovery: source issue is cancelled.";
    case "queued_continuation_owner":
      return "Auto-resolved missing-disposition recovery: source issue is queued for an assigned continuation owner.";
    case "review_human_owner":
      return "Auto-resolved missing-disposition recovery: source issue is in review with a human owner.";
    case "review_execution_participant":
      return "Auto-resolved missing-disposition recovery: source issue is in review with an execution participant.";
    case "blocked_human_owner":
      return "Auto-resolved missing-disposition recovery: source issue is blocked with a human owner action.";
    case "blocked_first_class_blocker":
      return "Auto-resolved missing-disposition recovery: source issue is blocked by an unresolved first-class blocker.";
    case "scheduled_monitor":
      return "Auto-resolved missing-disposition recovery: source issue has a live scheduled monitor.";
    case "pending_issue_thread_interaction":
      return "Auto-resolved missing-disposition recovery: source issue has a pending issue-thread interaction.";
    case "pending_approval":
      return "Auto-resolved missing-disposition recovery: source issue has a pending approval.";
    case "live_execution_path":
      return "Auto-resolved missing-disposition recovery: source issue has a non-recovery live execution path.";
  }
}

function isUniqueRecoveryActionConflict(error: unknown) {
  const maybe = error as { code?: string; constraint?: string; message?: string } | null;
  return Boolean(
    maybe &&
      maybe.code === "23505" &&
      (
        maybe.constraint === "issue_recovery_actions_active_source_uq" ||
        maybe.constraint === "issue_recovery_actions_active_fingerprint_uq" ||
        typeof maybe.message === "string" && (
          maybe.message.includes("issue_recovery_actions_active_source_uq") ||
          maybe.message.includes("issue_recovery_actions_active_fingerprint_uq")
        )
      ),
  );
}

export function issueRecoveryActionService(db: Db) {
  const upsertQueues = new Map<string, Promise<void>>();

  async function runExclusiveUpsert<T>(
    input: UpsertIssueRecoveryActionInput,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.companyId}:${input.sourceIssueId}`;
    const previous = upsertQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    upsertQueues.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (upsertQueues.get(key) === next) {
        upsertQueues.delete(key);
      }
    }
  }

  async function getActiveForIssue(companyId: string, sourceIssueId: string): Promise<IssueRecoveryAction | null> {
    const row = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? toReadModel(row) : null;
  }

  async function listActiveForIssues(companyId: string, sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, IssueRecoveryAction>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, IssueRecoveryAction>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, toReadModel(row));
    }
    return result;
  }

  async function retryUpsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    retryCount: number,
    error?: unknown,
  ): Promise<IssueRecoveryAction> {
    if (retryCount >= MAX_UPSERT_RETRIES) {
      if (error) throw error;
      throw new Error(
        `Failed to upsert active recovery action for issue ${input.sourceIssueId} after ${MAX_UPSERT_RETRIES} retries`,
      );
    }
    return upsertSourceScopedUnlocked(input, retryCount + 1);
  }

  async function upsertSourceScopedUnlocked(
    input: UpsertIssueRecoveryActionInput,
    retryCount = 0,
  ): Promise<IssueRecoveryAction> {
    const existing = await getActiveForIssue(input.companyId, input.sourceIssueId);
    const now = new Date();
    const ownerType = input.ownerType ?? (input.ownerAgentId ? "agent" : "board");
    if (existing) {
      const [updated] = await db
        .update(issueRecoveryActions)
        .set({
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? existing.previousOwnerAgentId,
          returnOwnerAgentId: input.returnOwnerAgentId ?? existing.returnOwnerAgentId,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: input.evidence ?? existing.evidence,
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: existing.attemptCount + 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
          outcome: null,
          resolutionNote: null,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueRecoveryActions.id, existing.id),
            inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          ),
        )
        .returning();
      if (!updated) {
        return retryUpsertSourceScoped(input, retryCount);
      }
      return toReadModel(updated!);
    }

    try {
      const [created] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId: input.companyId,
          sourceIssueId: input.sourceIssueId,
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? null,
          returnOwnerAgentId: input.returnOwnerAgentId ?? null,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: input.evidence ?? {},
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
        })
        .returning();
      return toReadModel(created!);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, error);
    }
  }

  async function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
  ): Promise<IssueRecoveryAction> {
    return runExclusiveUpsert(input, () => upsertSourceScopedUnlocked(input));
  }

  async function resolveActiveForIssue(
    input: ResolveIssueRecoveryActionInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const predicates = [
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.actionId) {
      predicates.push(eq(issueRecoveryActions.id, input.actionId));
    }

    const [updated] = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: input.status,
        outcome: input.outcome,
        resolutionNote: input.resolutionNote ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(...predicates))
      .returning();

    return updated ? toReadModel(updated) : null;
  }

  async function hasUnresolvedFirstClassBlocker(
    dbOrTx: DbOrTransaction,
    sourceIssue: SourceIssueRow,
  ) {
    const rows = await dbOrTx
      .select({ id: issues.id })
      .from(issueRelations)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, issueRelations.companyId),
          eq(issues.id, issueRelations.issueId),
        ),
      )
      .where(
        and(
          eq(issueRelations.companyId, sourceIssue.companyId),
          eq(issueRelations.relatedIssueId, sourceIssue.id),
          eq(issueRelations.type, "blocks"),
          notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async function hasPendingInteraction(dbOrTx: DbOrTransaction, sourceIssue: SourceIssueRow) {
    const rows = await dbOrTx
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, sourceIssue.companyId),
          eq(issueThreadInteractions.issueId, sourceIssue.id),
          inArray(issueThreadInteractions.status, [...PENDING_INTERACTION_STATUSES]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async function hasPendingApproval(dbOrTx: DbOrTransaction, sourceIssue: SourceIssueRow) {
    const rows = await dbOrTx
      .select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(
        approvals,
        and(
          eq(approvals.companyId, issueApprovals.companyId),
          eq(approvals.id, issueApprovals.approvalId),
        ),
      )
      .where(
        and(
          eq(issueApprovals.companyId, sourceIssue.companyId),
          eq(issueApprovals.issueId, sourceIssue.id),
          inArray(approvals.status, [...PENDING_APPROVAL_STATUSES]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async function hasNonRecoveryLiveExecutionPath(
    dbOrTx: DbOrTransaction,
    action: IssueRecoveryActionRow,
    sourceIssue: SourceIssueRow,
  ) {
    const activeRuns = await dbOrTx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, sourceIssue.companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_EXECUTION_PATH_RUN_STATUSES]),
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${sourceIssue.id}`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${sourceIssue.id}`,
          ),
          sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId', '') <> ${action.id}`,
          sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'source', '') <> 'issue_recovery_action'`,
        ),
      )
      .limit(1);
    if (activeRuns.length > 0) return true;

    const queuedWakeups = await dbOrTx
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, sourceIssue.companyId),
          inArray(agentWakeupRequests.status, [...ACTIVE_WAKE_STATUSES]),
          or(
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${sourceIssue.id}`,
            sql`${agentWakeupRequests.payload} ->> 'taskId' = ${sourceIssue.id}`,
          ),
          sql`coalesce(${agentWakeupRequests.payload} ->> 'recoveryActionId', '') <> ${action.id}`,
          sql`coalesce(${agentWakeupRequests.reason}, '') <> 'source_scoped_recovery_action'`,
        ),
      )
      .limit(1);
    return queuedWakeups.length > 0;
  }

  async function missingDispositionResolutionForSource(
    dbOrTx: DbOrTransaction,
    action: IssueRecoveryActionRow,
    sourceIssue: SourceIssueRow,
    now = new Date(),
  ): Promise<MissingDispositionResolution | null> {
    const resolution = (
      outcome: IssueRecoveryActionOutcome,
      reason: MissingDispositionResolutionReason,
    ): MissingDispositionResolution => ({
      outcome,
      reason,
      note: missingDispositionResolutionNote(reason),
    });

    if (sourceIssue.status === "done") return resolution("restored", "source_closed_done");
    if (sourceIssue.status === "cancelled") return resolution("cancelled", "source_closed_cancelled");
    if (sourceIssue.status === "todo" && (sourceIssue.assigneeAgentId || sourceIssue.assigneeUserId)) {
      return resolution("delegated", "queued_continuation_owner");
    }

    if (hasFutureDate(sourceIssue.monitorNextCheckAt, now)) return resolution("restored", "scheduled_monitor");
    if (await hasPendingInteraction(dbOrTx, sourceIssue)) {
      return resolution("restored", "pending_issue_thread_interaction");
    }
    if (await hasPendingApproval(dbOrTx, sourceIssue)) return resolution("restored", "pending_approval");
    if (await hasNonRecoveryLiveExecutionPath(dbOrTx, action, sourceIssue)) {
      return resolution("restored", "live_execution_path");
    }

    if (sourceIssue.status === "in_review") {
      if (sourceIssue.assigneeUserId) return resolution("restored", "review_human_owner");
      if (hasExecutionParticipant(sourceIssue.executionState)) {
        return resolution("restored", "review_execution_participant");
      }
    }

    if (sourceIssue.status === "blocked") {
      if (sourceIssue.assigneeUserId) return resolution("blocked", "blocked_human_owner");
      if (await hasUnresolvedFirstClassBlocker(dbOrTx, sourceIssue)) {
        return resolution("blocked", "blocked_first_class_blocker");
      }
    }

    return null;
  }

  async function resolveActiveMissingDispositionIfSourceDisposed(
    input: {
      companyId: string;
      sourceIssueId: string;
      actionId?: string | null;
    },
    dbOrTx: DbOrTransaction = db,
  ): Promise<{
    recoveryAction: IssueRecoveryAction;
    sourceIssue: SourceIssueRow;
    reason: MissingDispositionResolutionReason;
  } | null> {
    const actionPredicates = [
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
      eq(issueRecoveryActions.kind, MISSING_DISPOSITION_KIND),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.actionId) {
      actionPredicates.push(eq(issueRecoveryActions.id, input.actionId));
    }

    const action = await dbOrTx
      .select()
      .from(issueRecoveryActions)
      .where(and(...actionPredicates))
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!action) return null;

    const sourceIssue = await dbOrTx
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
      })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.sourceIssueId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) return null;

    const disposition = await missingDispositionResolutionForSource(dbOrTx, action, sourceIssue);
    if (!disposition) return null;

    const recoveryAction = await resolveActiveForIssue(
      {
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        actionId: action.id,
        status: "resolved",
        outcome: disposition.outcome,
        resolutionNote: disposition.note,
      },
      dbOrTx,
    );
    if (!recoveryAction) return null;
    return { recoveryAction, sourceIssue, reason: disposition.reason };
  }

  async function resolveStaleMissingDispositionActions(input: {
    companyId?: string | null;
    limit?: number;
  } = {}) {
    const predicates = [
      eq(issueRecoveryActions.kind, MISSING_DISPOSITION_KIND),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.companyId) {
      predicates.push(eq(issueRecoveryActions.companyId, input.companyId));
    }

    const rows = await db
      .select({
        id: issueRecoveryActions.id,
        companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
      })
      .from(issueRecoveryActions)
      .where(and(...predicates))
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(input.limit ?? 100);

    const resolved: Array<{
      recoveryAction: IssueRecoveryAction;
      sourceIssue: SourceIssueRow;
      reason: MissingDispositionResolutionReason;
    }> = [];
    for (const row of rows) {
      const result = await resolveActiveMissingDispositionIfSourceDisposed({
        companyId: row.companyId,
        sourceIssueId: row.sourceIssueId,
        actionId: row.id,
      });
      if (result) resolved.push(result);
    }
    return resolved;
  }

  return {
    getActiveForIssue,
    listActiveForIssues,
    resolveActiveMissingDispositionIfSourceDisposed,
    resolveActiveForIssue,
    resolveStaleMissingDispositionActions,
    upsertSourceScoped,
  };
}
