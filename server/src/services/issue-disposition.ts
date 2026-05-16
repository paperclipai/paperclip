import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issueApprovals,
  approvals,
  issues,
  issueThreadInteractions,
  heartbeatRuns,
} from "@paperclipai/db";
import type {
  IssueCommentAuthorType,
  IssueCommentMetadata,
  IssueCommentMetadataDispositionRow,
  IssueCommentPresentation,
  IssueDispositionTransitionIntention,
  IssueExecutionPolicy,
  IssueFinalDisposition,
} from "@paperclipai/shared";
import {
  evaluateDispositionTransition,
  issueCommentMetadataSchema,
  issueCommentPresentationSchema,
  parseIssueDispositionIdempotencyKey,
} from "@paperclipai/shared";
import { conflict, unprocessable, notFound } from "../errors.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

export interface DispositionWriterActor {
  actorType: "agent" | "user" | "system";
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
}

export interface ApplyCommentDispositionInput {
  issueId: string;
  body: string;
  authorType: IssueCommentAuthorType;
  presentation?: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata;
  actor: DispositionWriterActor;
  createdAt?: Date | null;
  /**
   * Optional bag of extra activity detail fields to merge into the
   * transactional `issue.disposition_applied` evidence record (e.g.
   * issue identifier/title for downstream observability). Must not
   * include raw transcripts or secrets.
   */
  evidenceDetailExtras?: Record<string, unknown> | null;
}

export interface AppliedCommentDispositionResult {
  comment: typeof issueComments.$inferSelect;
  applied: boolean;
  noop: boolean;
  dispositionValue: IssueFinalDisposition;
  intention: IssueDispositionTransitionIntention | null;
  sourceRunId: string | null;
  idempotencyKey: string;
  evidence: {
    sourceRunId: string | null;
    sourceCommentId: string;
    actor: DispositionWriterActor;
    parentBlockerIntention: IssueDispositionTransitionIntention["parentBlockerIntention"] | null;
    parentBlockerCleared: boolean;
    parentBlockerReplacementDeferred: boolean;
    previousStatus: string;
    nextStatus: string;
  };
}

export const DISPOSITION_ERROR_CODES = {
  IDEMPOTENCY_CONFLICT: "disposition_idempotency_conflict",
  IDEMPOTENCY_KEY_REQUIRED: "disposition_idempotency_key_required",
  IDEMPOTENCY_KEY_INVALID: "disposition_idempotency_key_invalid",
  IDEMPOTENCY_KEY_ISSUE_MISMATCH: "disposition_idempotency_key_issue_mismatch",
  SOURCE_RUN_REQUIRED: "disposition_source_run_required",
  SOURCE_RUN_NOT_FOUND: "disposition_source_run_not_found",
  SOURCE_RUN_FOREIGN_COMPANY: "disposition_source_run_foreign_company",
  INVALID_TRANSITION: "invalid_disposition_transition",
  WORKER_SELF_ATTEST: "disposition_worker_self_attest",
  MULTIPLE_DISPOSITION_ROWS: "disposition_multiple_rows",
} as const;
export type DispositionErrorCode = (typeof DISPOSITION_ERROR_CODES)[keyof typeof DISPOSITION_ERROR_CODES];

function isDispositionRow(row: { type: string }): row is IssueCommentMetadataDispositionRow {
  return row.type === "disposition";
}

/**
 * Stable signed 32-bit hash of an input string. Used as one half of a
 * Postgres advisory-lock key pair so concurrent writes targeting the same
 * (issueId, idempotencyKey) tuple serialize at the database layer.
 */
function hashToInt32(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  // Read first 4 bytes as a signed int32.
  return digest.readInt32BE(0);
}

export function extractDispositionRowFromMetadata(
  metadata: IssueCommentMetadata | null | undefined,
): { row: IssueCommentMetadataDispositionRow; sectionIndex: number; rowIndex: number } | null {
  if (!metadata) return null;
  for (const [sectionIndex, section] of metadata.sections.entries()) {
    for (const [rowIndex, row] of section.rows.entries()) {
      if (isDispositionRow(row)) {
        return { row, sectionIndex, rowIndex };
      }
    }
  }
  return null;
}

export function countDispositionRows(metadata: IssueCommentMetadata | null | undefined): number {
  if (!metadata) return 0;
  let count = 0;
  for (const section of metadata.sections) {
    for (const row of section.rows) {
      if (isDispositionRow(row)) count += 1;
    }
  }
  return count;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function dispositionBodyEquivalent(
  a: { body: string; metadata: IssueCommentMetadata | null | undefined },
  b: { body: string; metadata: IssueCommentMetadata | null | undefined },
): boolean {
  if (a.body !== b.body) return false;
  const aNorm = a.metadata ?? null;
  const bNorm = b.metadata ?? null;
  return stableStringify(aNorm) === stableStringify(bNorm);
}

interface DerivedPreconditionFlags {
  hasReviewPath: boolean;
  hasQaPath: boolean;
  hasApprovalPath: boolean;
  hasParentBlocker: boolean;
  hasApprovedReviewDecisions: boolean;
  hasApprovedApprovalDecisions: boolean;
  hasFirstClassBlocker: boolean;
  hasPriorChangesRequestedDecision: boolean;
  hasCanonicalIssueRef: boolean;
  hasSuccessorRef: boolean;
  hasCauseClassification: boolean;
}

export interface DispositionDecisionRow {
  stageId: string;
  stageType: string;
  outcome: string;
  actorAgentId: string | null;
  actorUserId: string | null;
}

interface PreconditionDependencies {
  parentId: string | null;
  executionPolicy: IssueExecutionPolicy | null;
  decisionRows: DispositionDecisionRow[];
  hasParentBlockerRelation: boolean;
  hasFirstClassBlockerRelation: boolean;
  hasPendingApproval: boolean;
  hasPendingInteraction: boolean;
  hasHumanAssignee: boolean;
}

export function derivePreconditionFlags(
  row: IssueCommentMetadataDispositionRow,
  deps: PreconditionDependencies,
): DerivedPreconditionFlags {
  const reviewStages = deps.executionPolicy?.stages.filter((stage) => stage.type === "review") ?? [];
  const approvalStages = deps.executionPolicy?.stages.filter((stage) => stage.type === "approval") ?? [];

  // Multi-stage gate semantics: each required review/approval stage must have
  // its own approved decision keyed on stageId. A single approved decision
  // cannot satisfy multiple stages.
  const allReviewStagesApproved =
    reviewStages.length === 0
      ? true
      : reviewStages.every((stage) =>
        deps.decisionRows.some(
          (decision) =>
            decision.stageType === "review"
            && decision.stageId === stage.id
            && decision.outcome === "approved",
        ),
      );
  const allApprovalStagesApproved =
    approvalStages.length === 0
      ? true
      : approvalStages.every((stage) =>
        deps.decisionRows.some(
          (decision) =>
            decision.stageType === "approval"
            && decision.stageId === stage.id
            && decision.outcome === "approved",
        ),
      );

  const hasReviewPath =
    reviewStages.length > 0
    || deps.hasPendingInteraction
    || deps.hasHumanAssignee;
  const hasQaPath = hasReviewPath;
  const hasApprovalPath = approvalStages.length > 0 || deps.hasPendingApproval;

  const evidenceRefs = row.evidenceRefs ?? [];
  const hasCanonicalIssueRef = evidenceRefs.some((ref) => ref.kind === "issue");
  const hasSuccessorRef =
    evidenceRefs.some((ref) => ref.kind === "issue" || ref.kind === "document");
  const hasCauseClassification = Boolean(row.reason && row.reason.trim().length > 0);

  return {
    hasReviewPath,
    hasQaPath,
    hasApprovalPath,
    hasParentBlocker: deps.hasParentBlockerRelation,
    hasApprovedReviewDecisions: allReviewStagesApproved,
    hasApprovedApprovalDecisions: allApprovalStagesApproved,
    hasFirstClassBlocker: deps.hasFirstClassBlockerRelation,
    hasPriorChangesRequestedDecision: deps.decisionRows.some((d) => d.outcome === "changes_requested"),
    hasCanonicalIssueRef,
    hasSuccessorRef,
    hasCauseClassification,
  };
}

export interface WorkerSelfAttestInput {
  dispositionValue: IssueFinalDisposition;
  actor: DispositionWriterActor;
  issueAssigneeAgentId: string | null;
  issueAssigneeUserId: string | null;
  approvedDecisionActors: Array<{ actorAgentId: string | null; actorUserId: string | null; stageType: string }>;
  hasReviewStage: boolean;
  hasApprovalStage: boolean;
}

export function validateWorkerSelfAttest(input: WorkerSelfAttestInput): { ok: true } | { ok: false; missing: "distinct_reviewer" | "distinct_approval_owner"; message: string } {
  if (input.dispositionValue !== "done") return { ok: true };

  const actorIsAssigneeAgent =
    input.actor.actorType === "agent"
    && !!input.actor.agentId
    && input.actor.agentId === input.issueAssigneeAgentId;
  const actorIsAssigneeUser =
    input.actor.actorType === "user"
    && !!input.actor.userId
    && input.actor.userId === input.issueAssigneeUserId;

  if (!actorIsAssigneeAgent && !actorIsAssigneeUser) return { ok: true };

  if (input.hasReviewStage) {
    const distinctReviewer = input.approvedDecisionActors.some((decision) =>
      decision.stageType === "review"
      && (
        (decision.actorAgentId && decision.actorAgentId !== input.actor.agentId)
        || (decision.actorUserId && decision.actorUserId !== input.actor.userId)
      ),
    );
    if (!distinctReviewer) {
      return {
        ok: false,
        missing: "distinct_reviewer",
        message:
          "Disposition done requires an approved review decision from an actor distinct from the issue worker.",
      };
    }
  }

  if (input.hasApprovalStage) {
    const distinctApprover = input.approvedDecisionActors.some((decision) =>
      decision.stageType === "approval"
      && (
        (decision.actorAgentId && decision.actorAgentId !== input.actor.agentId)
        || (decision.actorUserId && decision.actorUserId !== input.actor.userId)
      ),
    );
    if (!distinctApprover) {
      return {
        ok: false,
        missing: "distinct_approval_owner",
        message:
          "Disposition done requires an approved approval decision from an actor distinct from the issue worker.",
      };
    }
  }

  return { ok: true };
}

export function issueDispositionService(db: Db) {
  return {
    extractDispositionRowFromMetadata,
    countDispositionRows,
    dispositionBodyEquivalent,
    validateWorkerSelfAttest,

    /**
     * Atomically write a comment that carries a disposition row and apply the
     * resulting issue status transition. Caller must have already authorized
     * the comment write (company access, mutation allowed, etc.).
     */
    applyCommentDisposition: async (
      input: ApplyCommentDispositionInput,
    ): Promise<AppliedCommentDispositionResult> => {
      const dispositionMatch = extractDispositionRowFromMetadata(input.metadata);
      if (!dispositionMatch) {
        throw unprocessable("applyCommentDisposition called without a disposition row in metadata");
      }
      if (countDispositionRows(input.metadata) > 1) {
        throw unprocessable("Comment metadata cannot include more than one disposition row", {
          code: DISPOSITION_ERROR_CODES.MULTIPLE_DISPOSITION_ROWS,
        });
      }

      const row = dispositionMatch.row;
      const idempotencyKey = row.idempotencyKey;
      if (!idempotencyKey) {
        throw unprocessable("Disposition row requires an idempotencyKey to be written by the backend writer", {
          code: DISPOSITION_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        });
      }
      const parsedKey = parseIssueDispositionIdempotencyKey(idempotencyKey);
      if (!parsedKey) {
        throw unprocessable("Disposition idempotency key is invalid", {
          code: DISPOSITION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
        });
      }
      if (parsedKey.issueId !== input.issueId) {
        throw unprocessable("Disposition idempotency key issueId must match target issue", {
          code: DISPOSITION_ERROR_CODES.IDEMPOTENCY_KEY_ISSUE_MISMATCH,
        });
      }
      if (parsedKey.dispositionValue !== row.value) {
        throw unprocessable("Disposition idempotency key value must match disposition value", {
          code: DISPOSITION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
        });
      }

      const sourceRunId = input.metadata.sourceRunId ?? row.finalDisposition?.sourceRunId ?? input.actor.runId ?? null;
      if (!sourceRunId) {
        throw unprocessable("Disposition writes require a sourceRunId on the carrying metadata", {
          code: DISPOSITION_ERROR_CODES.SOURCE_RUN_REQUIRED,
        });
      }
      if (parsedKey.sourceRunId !== sourceRunId) {
        throw unprocessable("Disposition idempotency key sourceRunId must match metadata.sourceRunId", {
          code: DISPOSITION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
        });
      }

      const presentation = issueCommentPresentationSchema.nullable().parse(input.presentation ?? null);
      const validatedMetadata = issueCommentMetadataSchema.parse(input.metadata);

      return db.transaction(async (tx) => {
        // Concurrency-safe idempotency: serialize concurrent attempts to write
        // the same (issueId, idempotencyKey) tuple via two int4 advisory locks
        // composed into pg_advisory_xact_lock(int4, int4). The lock is bound
        // to this transaction and released automatically on commit/rollback.
        const lockA = hashToInt32(input.issueId);
        const lockB = hashToInt32(idempotencyKey);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockA}, ${lockB})`);

        const issueRow = await tx
          .select()
          .from(issues)
          .where(eq(issues.id, input.issueId))
          .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);

        if (!issueRow) throw notFound("Issue not found");

        const sourceRun = await tx
          .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, sourceRunId))
          .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
        if (!sourceRun) {
          throw unprocessable("Disposition sourceRunId does not reference a known heartbeat run", {
            code: DISPOSITION_ERROR_CODES.SOURCE_RUN_NOT_FOUND,
          });
        }
        if (sourceRun.companyId !== issueRow.companyId) {
          throw unprocessable("Disposition sourceRunId belongs to a different company than the target issue", {
            code: DISPOSITION_ERROR_CODES.SOURCE_RUN_FOREIGN_COMPANY,
          });
        }

        const dispositionCandidateComments = await tx
          .select({
            id: issueComments.id,
            body: issueComments.body,
            metadata: issueComments.metadata,
            createdByRunId: issueComments.createdByRunId,
          })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.issueId, input.issueId),
              sql`jsonb_path_exists(${issueComments.metadata}, '$.sections[*].rows[*] ? (@.type == "disposition")')`,
            ),
          );

        const existingComments = dispositionCandidateComments.filter((candidate) => {
          const candidateMetadata = (candidate.metadata as IssueCommentMetadata | null) ?? null;
          if (!candidateMetadata) return false;
          for (const section of candidateMetadata.sections) {
            for (const candidateRow of section.rows) {
              if (
                candidateRow.type === "disposition"
                && candidateRow.idempotencyKey === idempotencyKey
              ) {
                return true;
              }
            }
          }
          return false;
        });

        for (const existing of existingComments) {
          if (
            dispositionBodyEquivalent(
              { body: input.body, metadata: validatedMetadata },
              { body: existing.body, metadata: (existing.metadata as IssueCommentMetadata | null) ?? null },
            )
          ) {
            return {
              comment: existing as typeof issueComments.$inferSelect,
              applied: false,
              noop: true,
              dispositionValue: row.value,
              intention: null,
              sourceRunId,
              idempotencyKey,
              evidence: {
                sourceRunId,
                sourceCommentId: existing.id,
                actor: input.actor,
                parentBlockerIntention: null,
                parentBlockerCleared: false,
                parentBlockerReplacementDeferred: false,
                previousStatus: issueRow.status,
                nextStatus: issueRow.status,
              },
            };
          }
          throw conflict(
            "A different comment already used this disposition idempotency key with different content",
            {
              code: DISPOSITION_ERROR_CODES.IDEMPOTENCY_CONFLICT,
              existingCommentId: existing.id,
            },
          );
        }

        const executionPolicy = normalizeIssueExecutionPolicy(issueRow.executionPolicy ?? null);
        const decisionRows: DispositionDecisionRow[] = await tx
          .select({
            stageId: issueExecutionDecisions.stageId,
            stageType: issueExecutionDecisions.stageType,
            outcome: issueExecutionDecisions.outcome,
            actorAgentId: issueExecutionDecisions.actorAgentId,
            actorUserId: issueExecutionDecisions.actorUserId,
          })
          .from(issueExecutionDecisions)
          .where(eq(issueExecutionDecisions.issueId, input.issueId));

        const blockerRelations = await tx
          .select({
            issueId: issueRelations.issueId,
            relatedIssueId: issueRelations.relatedIssueId,
          })
          .from(issueRelations)
          .where(
            and(
              eq(issueRelations.companyId, issueRow.companyId),
              eq(issueRelations.type, "blocks"),
            ),
          );

        const hasFirstClassBlockerRelation = blockerRelations.some((rel) => rel.relatedIssueId === input.issueId);
        const hasParentBlockerRelation = issueRow.parentId
          ? blockerRelations.some((rel) => rel.issueId === input.issueId && rel.relatedIssueId === issueRow.parentId)
          : false;

        const pendingApprovals = await tx
          .select({ id: approvals.id })
          .from(issueApprovals)
          .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
          .where(
            and(
              eq(issueApprovals.issueId, input.issueId),
              eq(approvals.status, "pending"),
            ),
          );
        const hasPendingApproval = pendingApprovals.length > 0;

        const pendingInteractions = await tx
          .select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.issueId, input.issueId),
              eq(issueThreadInteractions.status, "pending"),
            ),
          );
        const hasPendingInteraction = pendingInteractions.length > 0;

        const hasHumanAssignee = Boolean(issueRow.assigneeUserId);

        const flags = derivePreconditionFlags(row, {
          parentId: issueRow.parentId ?? null,
          executionPolicy,
          decisionRows,
          hasParentBlockerRelation,
          hasFirstClassBlockerRelation,
          hasPendingApproval,
          hasPendingInteraction,
          hasHumanAssignee,
        });

        const selfAttest = validateWorkerSelfAttest({
          dispositionValue: row.value,
          actor: input.actor,
          issueAssigneeAgentId: issueRow.assigneeAgentId ?? null,
          issueAssigneeUserId: issueRow.assigneeUserId ?? null,
          approvedDecisionActors: decisionRows
            .filter((d) => d.outcome === "approved")
            .map((d) => ({
              actorAgentId: d.actorAgentId,
              actorUserId: d.actorUserId,
              stageType: d.stageType,
            })),
          hasReviewStage: (executionPolicy?.stages.some((s) => s.type === "review")) ?? false,
          hasApprovalStage: (executionPolicy?.stages.some((s) => s.type === "approval")) ?? false,
        });
        if (!selfAttest.ok) {
          throw unprocessable(selfAttest.message, {
            code: DISPOSITION_ERROR_CODES.WORKER_SELF_ATTEST,
            missing: selfAttest.missing,
          });
        }

        const transition = evaluateDispositionTransition({
          actorType: input.actor.actorType,
          existingStatus: issueRow.status as Parameters<typeof evaluateDispositionTransition>[0]["existingStatus"],
          nextDisposition: row.value,
          hasReviewPath: flags.hasReviewPath,
          hasQaPath: flags.hasQaPath,
          hasApprovalPath: flags.hasApprovalPath,
          hasParentBlocker: flags.hasParentBlocker,
          hasApprovedReviewDecisions: flags.hasApprovedReviewDecisions,
          hasApprovedApprovalDecisions: flags.hasApprovedApprovalDecisions,
          hasFirstClassBlocker: flags.hasFirstClassBlocker,
          hasPriorChangesRequestedDecision: flags.hasPriorChangesRequestedDecision,
          hasCanonicalIssueRef: flags.hasCanonicalIssueRef,
          hasSuccessorRef: flags.hasSuccessorRef,
          hasCauseClassification: flags.hasCauseClassification,
        });
        if (!transition.ok) {
          throw unprocessable(transition.message, {
            code: DISPOSITION_ERROR_CODES.INVALID_TRANSITION,
            disposition: transition.disposition,
            validFromStatuses: transition.validFromStatuses,
            missing: transition.missing,
          });
        }

        const createdAt = input.createdAt ? new Date(input.createdAt) : null;
        const [insertedComment] = await tx
          .insert(issueComments)
          .values({
            companyId: issueRow.companyId,
            issueId: input.issueId,
            authorAgentId: input.actor.agentId ?? null,
            authorUserId: input.actor.userId ?? null,
            authorType: input.authorType,
            createdByRunId: input.actor.runId ?? null,
            body: input.body,
            presentation,
            metadata: validatedMetadata,
            ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
          })
          .returning();

        const intention = transition.intention;
        const previousStatus = issueRow.status;
        const nextStatus = intention.targetStatus;

        const patch: Partial<typeof issues.$inferInsert> = {
          status: nextStatus,
          updatedAt: new Date(),
        };
        if (nextStatus === "done" && previousStatus !== "done") {
          patch.completedAt = new Date();
        }
        if (nextStatus === "cancelled" && previousStatus !== "cancelled") {
          patch.cancelledAt = new Date();
        }
        if (nextStatus !== "in_progress") {
          patch.checkoutRunId = null;
          patch.executionRunId = null;
          patch.executionAgentNameKey = null;
          patch.executionLockedAt = null;
        }
        if (nextStatus !== "done") {
          patch.completedAt = null;
        }
        if (nextStatus !== "cancelled") {
          patch.cancelledAt = null;
        }

        if (previousStatus !== nextStatus) {
          await tx.update(issues).set(patch).where(eq(issues.id, input.issueId));
        } else {
          await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, input.issueId));
        }

        let parentBlockerCleared = false;
        let parentBlockerReplacementDeferred = false;
        if (intention.parentBlockerIntention === "remove_from_parent_blockers") {
          if (issueRow.parentId) {
            const deleted = await tx
              .delete(issueRelations)
              .where(
                and(
                  eq(issueRelations.companyId, issueRow.companyId),
                  eq(issueRelations.issueId, input.issueId),
                  eq(issueRelations.relatedIssueId, issueRow.parentId),
                  eq(issueRelations.type, "blocks"),
                ),
              )
              .returning({ id: issueRelations.id });
            parentBlockerCleared = deleted.length > 0;
          }
        } else if (
          intention.parentBlockerIntention === "replace_with_canonical_issue"
          || intention.parentBlockerIntention === "replace_with_successor"
        ) {
          // Replacement edges (canonical/successor) are out of scope for the
          // 3C-B writer slice; defer to a follow-up. Mark the intention so the
          // evidence chain makes the deferral explicit.
          parentBlockerReplacementDeferred = true;
        }

        const evidenceDetails: Record<string, unknown> = {
          ...(input.evidenceDetailExtras ?? {}),
          commentId: insertedComment.id,
          identifier: issueRow.identifier ?? null,
          disposition: {
            value: row.value,
            applied: true,
            noop: false,
            previousStatus,
            nextStatus,
            parentBlockerIntention: intention.parentBlockerIntention,
            parentBlockerCleared,
            parentBlockerReplacementDeferred,
            sourceRunId,
            sourceCommentId: insertedComment.id,
            idempotencyKey,
          },
        };

        // Transactional evidence row: commit/rollback together with the
        // comment/issue/relation mutations so the audit chain is atomic.
        await tx.insert(activityLog).values({
          companyId: issueRow.companyId,
          actorType: input.actor.actorType,
          actorId:
            input.actor.userId
              ?? input.actor.agentId
              ?? input.actor.runId
              ?? "system",
          action: "issue.disposition_applied",
          entityType: "issue",
          entityId: input.issueId,
          agentId: input.actor.agentId ?? null,
          runId: input.actor.runId ?? null,
          details: evidenceDetails,
        });

        return {
          comment: insertedComment as typeof issueComments.$inferSelect,
          applied: true,
          noop: false,
          dispositionValue: row.value,
          intention,
          sourceRunId,
          idempotencyKey,
          evidence: {
            sourceRunId,
            sourceCommentId: insertedComment.id,
            actor: input.actor,
            parentBlockerIntention: intention.parentBlockerIntention,
            parentBlockerCleared,
            parentBlockerReplacementDeferred,
            previousStatus,
            nextStatus,
          },
        };
      });
    },
  };
}

export type IssueDispositionService = ReturnType<typeof issueDispositionService>;
