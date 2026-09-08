import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  deliveryAcceptances,
  deliverySubmissions,
  deliveryTracks,
  deliveryVerdicts,
  deliveryVerificationEvidence,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type {
  DeliveryAcceptanceRecord,
  DeliveryAction,
  DeliveryDenialCode,
  DeliveryEvidenceIngestInput,
  DeliveryEvidenceRecord,
  DeliveryAcceptInput,
  DeliveryEnrollInput,
  DeliveryPlanRevisionState,
  DeliveryStateSnapshot,
  DeliverySubmitInput,
  DeliverySubmissionRecord,
  DeliveryTrack,
  DeliveryVerdictInput,
  DeliveryVerdictRecord,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

/**
 * Delivery tracking: an opt-in, per-issue candidate/review/evidence record.
 *
 * Design rules this module holds to:
 * - An issue without an active track is untouched. There is no project-wide or
 *   instance-wide rule evaluation, and no new scheduler, queue, or reactivation
 *   path. Paperclip stays the only owner of issues, runs, and dispatch.
 * - Writer identity comes from native checkout state (`issues.checkout_run_id`
 *   / `issues.execution_run_id`) plus run liveness. This module never invents a
 *   second ownership mechanism.
 * - Acceptance is the only thing that can gate completion, it is board-only,
 *   and it is re-verified inside the transaction that writes the terminal
 *   status, so a plan edit or a newer candidate invalidates a stale acceptance.
 */

type DbOrTx = Pick<Db, "select">;

const TERMINAL_RUN_STATUSES: Record<string, true> = {
  succeeded: true,
  interrupted: true,
  failed: true,
  cancelled: true,
  timed_out: true,
};

export type DeliveryActor =
  | { type: "agent"; agentId: string; runId: string | null }
  | { type: "user"; userId: string; sessionId: string | null };

export function deliveryDenial(
  code: DeliveryDenialCode,
  message: string,
  status: 403 | 409 | 422 = 422,
  details?: Record<string, unknown>,
) {
  const payload = { code, ...(details ?? {}) };
  if (status === 403) return forbidden(message, payload);
  if (status === 409) return conflict(message, payload);
  return unprocessable(message, payload);
}

export function normalizeDeliveryRepositoryUrl(value: string) {
  return value.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

function serializeTrack(row: typeof deliveryTracks.$inferSelect): DeliveryTrack {
  return {
    id: row.id,
    issueId: row.issueId,
    projectId: row.projectId,
    repositoryUrl: row.repositoryUrl,
    requireReview: row.requireReview,
    requireVerifiedEvidence: row.requireVerifiedEvidence,
    pinPlanRevision: row.pinPlanRevision,
    reviewerAgentIds: Array.isArray(row.reviewerAgentIds) ? row.reviewerAgentIds : [],
    status: row.status === "closed" ? "closed" : "active",
    enrolledByAgentId: row.enrolledByAgentId,
    enrolledByUserId: row.enrolledByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeSubmission(row: typeof deliverySubmissions.$inferSelect): DeliverySubmissionRecord {
  return {
    id: row.id,
    issueId: row.issueId,
    planRevisionId: row.planRevisionId,
    candidate: {
      repositoryUrl: row.repositoryUrl,
      headSha: row.headSha,
      baseSha: row.baseSha,
    },
    submittedByAgentId: row.submittedByAgentId,
    submittedByUserId: row.submittedByUserId,
    submittedByRunId: row.submittedByRunId,
    evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds : [],
    supersededAt: row.supersededAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeVerdict(row: typeof deliveryVerdicts.$inferSelect): DeliveryVerdictRecord {
  return {
    id: row.id,
    issueId: row.issueId,
    submissionId: row.submissionId,
    planRevisionId: row.planRevisionId,
    candidateHeadSha: row.candidateHeadSha,
    verdict: row.verdict === "pass" ? "pass" : "changes_requested",
    findings: Array.isArray(row.findings) ? row.findings : [],
    reviewerAgentId: row.reviewerAgentId,
    reviewerRunId: row.reviewerRunId,
    evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds : [],
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeEvidence(row: typeof deliveryVerificationEvidence.$inferSelect): DeliveryEvidenceRecord {
  return {
    id: row.id,
    issueId: row.issueId,
    planRevisionId: row.planRevisionId,
    candidateHeadSha: row.candidateHeadSha,
    kind: row.kind as DeliveryEvidenceRecord["kind"],
    digest: row.digest,
    producerLabel: row.producerLabel,
    producedByUserId: row.producedByUserId,
    summary: row.summary ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeAcceptance(row: typeof deliveryAcceptances.$inferSelect): DeliveryAcceptanceRecord {
  return {
    id: row.id,
    issueId: row.issueId,
    submissionId: row.submissionId,
    verdictId: row.verdictId,
    planRevisionId: row.planRevisionId,
    candidateHeadSha: row.candidateHeadSha,
    evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds : [],
    acceptedByUserId: row.acceptedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Reads the `issue_document` target of a plan confirmation interaction. Kept
 * local so this module never imports the issue service (which imports this one).
 */
function readPlanConfirmationTarget(payload: unknown, issueId: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const target = (payload as Record<string, unknown>).target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const record = target as Record<string, unknown>;
  if (record.type !== "issue_document" || record.key !== "plan") return null;
  const revisionId = typeof record.revisionId === "string" ? record.revisionId : null;
  const targetIssueId = typeof record.issueId === "string" ? record.issueId : issueId;
  if (!revisionId || targetIssueId !== issueId) return null;
  const revisionNumber = typeof record.revisionNumber === "number" ? record.revisionNumber : null;
  return { revisionId, revisionNumber };
}

/**
 * Server-derived plan revision identity.
 *
 * The effective revision is the accepted revision only while it is still the
 * plan document's latest revision. Once the plan moves on, the accepted
 * revision is historical: `effectiveRevisionId` is null and callers that pin
 * the plan must stop until the new revision is accepted.
 */
export async function resolveEffectivePlanRevision(
  dbOrTx: DbOrTx,
  companyId: string,
  issueId: string,
): Promise<DeliveryPlanRevisionState> {
  const planDocument = await dbOrTx
    .select({
      documentId: issueDocuments.documentId,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(and(
      eq(issueDocuments.companyId, companyId),
      eq(issueDocuments.issueId, issueId),
      eq(issueDocuments.key, "plan"),
    ))
    .then((rows) => rows[0] ?? null);

  if (!planDocument) {
    return {
      planDocumentId: null,
      acceptedRevisionId: null,
      acceptedRevisionNumber: null,
      acceptedInteractionId: null,
      latestRevisionId: null,
      latestRevisionNumber: null,
      effectiveRevisionId: null,
      stale: true,
      staleReason: "no_plan_document",
    };
  }

  const acceptedInteractions = await dbOrTx
    .select({
      id: issueThreadInteractions.id,
      payload: issueThreadInteractions.payload,
    })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.kind, "request_confirmation"),
      eq(issueThreadInteractions.status, "accepted"),
    ))
    .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.createdAt));

  let acceptedRevisionId: string | null = null;
  let acceptedRevisionNumber: number | null = null;
  let acceptedInteractionId: string | null = null;
  for (const interaction of acceptedInteractions) {
    const target = readPlanConfirmationTarget(interaction.payload, issueId);
    if (!target) continue;
    acceptedRevisionId = target.revisionId;
    acceptedRevisionNumber = target.revisionNumber;
    acceptedInteractionId = interaction.id;
    break;
  }

  if (acceptedRevisionId && acceptedRevisionNumber === null) {
    acceptedRevisionNumber = await dbOrTx
      .select({ revisionNumber: documentRevisions.revisionNumber })
      .from(documentRevisions)
      .where(eq(documentRevisions.id, acceptedRevisionId))
      .then((rows) => rows[0]?.revisionNumber ?? null);
  }

  const base = {
    planDocumentId: planDocument.documentId,
    acceptedRevisionId,
    acceptedRevisionNumber,
    acceptedInteractionId,
    latestRevisionId: planDocument.latestRevisionId,
    latestRevisionNumber: planDocument.latestRevisionNumber,
  };

  if (!acceptedRevisionId) {
    return { ...base, effectiveRevisionId: null, stale: true, staleReason: "no_accepted_revision" };
  }
  if (planDocument.latestRevisionId && planDocument.latestRevisionId !== acceptedRevisionId) {
    return { ...base, effectiveRevisionId: null, stale: true, staleReason: "superseded_by_newer_revision" };
  }
  return { ...base, effectiveRevisionId: acceptedRevisionId, stale: false, staleReason: null };
}

async function requireIssue(dbOrTx: DbOrTx, issueId: string) {
  const issue = await dbOrTx
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

type IssueWriterState = {
  agentId: string | null;
  runId: string | null;
  runStatus: string | null;
};

async function resolveCurrentWriter(
  dbOrTx: DbOrTx,
  issue: { assigneeAgentId: string | null; checkoutRunId: string | null; executionRunId: string | null },
): Promise<IssueWriterState> {
  const runId = issue.checkoutRunId ?? issue.executionRunId;
  if (!runId) return { agentId: issue.assigneeAgentId, runId: null, runStatus: null };
  const run = await dbOrTx
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run || TERMINAL_RUN_STATUSES[run.status]) {
    // A dead run holds nothing: native checkout adoption already reclaims it.
    return { agentId: issue.assigneeAgentId, runId: null, runStatus: run?.status ?? null };
  }
  return { agentId: run.agentId ?? issue.assigneeAgentId, runId: run.id, runStatus: run.status };
}

/**
 * The write-side identity check for an agent-authored delivery operation: the
 * caller must be the issue's assignee and must be acting inside the run the
 * server currently considers this issue's writer.
 */
function assertAgentIsCurrentWriter(
  actor: DeliveryActor,
  issue: { assigneeAgentId: string | null },
  writer: IssueWriterState,
) {
  if (actor.type !== "agent") return;
  if (!actor.runId) {
    throw deliveryDenial("delivery_actor_run_required", "Agent delivery operations require an active run", 403);
  }
  if (issue.assigneeAgentId !== actor.agentId) {
    throw deliveryDenial(
      "delivery_writer_not_current",
      "Only the issue's current assignee can record a delivery candidate",
      403,
    );
  }
  if (!writer.runId || writer.runId !== actor.runId) {
    throw deliveryDenial(
      "delivery_actor_run_not_current",
      "This run does not hold the issue's current execution lock",
      409,
      { currentRunId: writer.runId },
    );
  }
}

async function resolvePinnedPlanRevision(
  dbOrTx: DbOrTx,
  track: DeliveryTrack,
  issue: { id: string; companyId: string },
  expected: string | null | undefined,
): Promise<string | null> {
  if (!track.pinPlanRevision) return null;
  const planRevision = await resolveEffectivePlanRevision(dbOrTx, issue.companyId, issue.id);
  if (!planRevision.effectiveRevisionId) {
    throw deliveryDenial("delivery_plan_revision_stale", "The issue has no current accepted plan revision", 409, {
      staleReason: planRevision.staleReason,
      acceptedRevisionId: planRevision.acceptedRevisionId,
      latestRevisionId: planRevision.latestRevisionId,
    });
  }
  if (!expected || expected !== planRevision.effectiveRevisionId) {
    throw deliveryDenial(
      "delivery_plan_revision_mismatch",
      "expectedPlanRevisionId is not the current accepted plan revision",
      409,
      { effectiveRevisionId: planRevision.effectiveRevisionId },
    );
  }
  return planRevision.effectiveRevisionId;
}

/**
 * Resolves caller-supplied evidence ids to trusted rows for exactly this issue
 * and candidate. Anything unresolved is rejected: a caller cannot pass its own
 * JSON, another issue's evidence, or evidence for another candidate.
 */
async function resolveTrustedEvidence(
  dbOrTx: DbOrTx,
  input: { companyId: string; issueId: string; candidateHeadSha: string; evidenceRefs: string[] },
) {
  if (input.evidenceRefs.length === 0) return [];
  const unique = [...new Set(input.evidenceRefs)];
  const rows = await dbOrTx
    .select()
    .from(deliveryVerificationEvidence)
    .where(and(
      eq(deliveryVerificationEvidence.companyId, input.companyId),
      eq(deliveryVerificationEvidence.issueId, input.issueId),
      eq(deliveryVerificationEvidence.candidateHeadSha, input.candidateHeadSha),
      inArray(deliveryVerificationEvidence.id, unique),
    ));
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((row) => row.id));
    throw deliveryDenial(
      "delivery_evidence_untrusted",
      "Every evidence reference must be registered verification evidence for this candidate",
      422,
      { unknownEvidenceRefs: unique.filter((ref) => !found.has(ref)) },
    );
  }
  return rows;
}

async function currentSubmissionRow(dbOrTx: DbOrTx, companyId: string, issueId: string) {
  return dbOrTx
    .select()
    .from(deliverySubmissions)
    .where(and(
      eq(deliverySubmissions.companyId, companyId),
      eq(deliverySubmissions.issueId, issueId),
      isNull(deliverySubmissions.supersededAt),
    ))
    .orderBy(desc(deliverySubmissions.createdAt))
    .then((rows) => rows[0] ?? null);
}

async function latestVerdictRow(dbOrTx: DbOrTx, companyId: string, submissionId: string) {
  return dbOrTx
    .select()
    .from(deliveryVerdicts)
    .where(and(
      eq(deliveryVerdicts.companyId, companyId),
      eq(deliveryVerdicts.submissionId, submissionId),
    ))
    .orderBy(desc(deliveryVerdicts.createdAt))
    .then((rows) => rows[0] ?? null);
}

async function activeTrackRow(dbOrTx: DbOrTx, companyId: string, issueId: string) {
  return dbOrTx
    .select()
    .from(deliveryTracks)
    .where(and(
      eq(deliveryTracks.companyId, companyId),
      eq(deliveryTracks.issueId, issueId),
      eq(deliveryTracks.status, "active"),
    ))
    .then((rows) => rows[0] ?? null);
}

/**
 * Completion guard for enrolled issues, executed inside the transaction that
 * writes the terminal status while the issue row is locked.
 *
 * An issue with no active track is not inspected at all, so ordinary work — and
 * every existing status path, UI or service — is unchanged. Cancellation is
 * never gated: an enrolled task must stay abandonable.
 */
export async function assertDeliveryCompletionAllowed(
  tx: DbOrTx,
  issue: { id: string; companyId: string },
): Promise<void> {
  const trackRow = await activeTrackRow(tx, issue.companyId, issue.id);
  if (!trackRow) return;
  const track = serializeTrack(trackRow);

  const acceptance = await tx
    .select()
    .from(deliveryAcceptances)
    .where(and(
      eq(deliveryAcceptances.companyId, issue.companyId),
      eq(deliveryAcceptances.issueId, issue.id),
    ))
    .orderBy(desc(deliveryAcceptances.createdAt))
    .then((rows) => rows[0] ?? null);
  if (!acceptance) {
    throw deliveryDenial(
      "delivery_acceptance_missing",
      "This issue tracks delivery: an accepted candidate is required before it can be completed",
    );
  }

  const submission = await currentSubmissionRow(tx, issue.companyId, issue.id);
  if (!submission || submission.headSha !== acceptance.candidateHeadSha) {
    throw deliveryDenial(
      "delivery_acceptance_stale",
      "A newer candidate was submitted after acceptance; the new candidate must be accepted",
      409,
      { acceptedHeadSha: acceptance.candidateHeadSha, currentHeadSha: submission?.headSha ?? null },
    );
  }

  if (track.pinPlanRevision) {
    const planRevision = await resolveEffectivePlanRevision(tx, issue.companyId, issue.id);
    if (!planRevision.effectiveRevisionId || planRevision.effectiveRevisionId !== acceptance.planRevisionId) {
      throw deliveryDenial(
        "delivery_acceptance_stale",
        "The plan revision changed after acceptance; the current revision must be accepted",
        409,
        {
          acceptedPlanRevisionId: acceptance.planRevisionId,
          effectiveRevisionId: planRevision.effectiveRevisionId,
          staleReason: planRevision.staleReason,
        },
      );
    }
  }

  if (track.requireReview) {
    if (!acceptance.verdictId) {
      throw deliveryDenial("delivery_review_missing", "This issue requires a recorded passing review");
    }
    const verdict = await tx
      .select()
      .from(deliveryVerdicts)
      .where(and(
        eq(deliveryVerdicts.companyId, issue.companyId),
        eq(deliveryVerdicts.id, acceptance.verdictId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!verdict || verdict.verdict !== "pass" || verdict.submissionId !== submission.id) {
      throw deliveryDenial(
        "delivery_review_not_passed",
        "The accepted candidate has no passing review of its own submission",
      );
    }
    if (verdict.reviewerAgentId && verdict.reviewerAgentId === submission.submittedByAgentId) {
      throw deliveryDenial(
        "delivery_reviewer_not_independent",
        "The reviewer must not be the submitter of the accepted candidate",
      );
    }
  }

  if (track.requireVerifiedEvidence) {
    const acceptedEvidenceIds = Array.isArray(acceptance.evidenceIds) ? acceptance.evidenceIds : [];
    if (acceptedEvidenceIds.length === 0) {
      throw deliveryDenial(
        "delivery_evidence_missing",
        "This issue requires registered verification evidence before completion",
      );
    }
    await resolveTrustedEvidence(tx, {
      companyId: issue.companyId,
      issueId: issue.id,
      candidateHeadSha: acceptance.candidateHeadSha,
      evidenceRefs: acceptedEvidenceIds,
    });
  }
}

/** The delivery-tracking operations, named so consumers and tests bind to a contract. */
export interface DeliveryTrackingService {
  getActiveTrack(companyId: string, issueId: string): Promise<DeliveryTrack | null>;
  enroll(issueId: string, input: DeliveryEnrollInput, actor: DeliveryActor): Promise<DeliveryTrack>;
  closeTrack(issueId: string, actor: DeliveryActor): Promise<DeliveryTrack | null>;
  snapshot(issueId: string, actor: DeliveryActor): Promise<DeliveryStateSnapshot>;
  submit(issueId: string, input: DeliverySubmitInput, actor: DeliveryActor): Promise<DeliverySubmissionRecord>;
  recordVerdict(
    issueId: string,
    input: DeliveryVerdictInput,
    actor: DeliveryActor,
  ): Promise<{ verdict: DeliveryVerdictRecord; submission: DeliverySubmissionRecord }>;
  accept(issueId: string, input: DeliveryAcceptInput, actor: DeliveryActor): Promise<DeliveryAcceptanceRecord>;
  ingestEvidence(
    issueId: string,
    input: DeliveryEvidenceIngestInput,
    actor: DeliveryActor,
  ): Promise<DeliveryEvidenceRecord>;
}

export function deliveryTrackingService(db: Db): DeliveryTrackingService {
  return {
    getActiveTrack: async (companyId: string, issueId: string) => {
      const row = await activeTrackRow(db, companyId, issueId);
      return row ? serializeTrack(row) : null;
    },

    /**
     * Opt an issue in. Creating a track is available to a board user or to the
     * agent that currently holds the issue, so an orchestrator can enroll the
     * specific tasks that need candidate tracking without any global rule.
     *
     * Changing an existing track's requirements — or closing it — is board-only,
     * so a worker cannot enroll, then relax its own completion requirements.
     */
    enroll: async (issueId: string, input: DeliveryEnrollInput, actor: DeliveryActor) => {
      const issue = await requireIssue(db, issueId);
      return db.transaction(async (tx) => {
        await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${issue.id} for update`);
        const existing = await tx
          .select()
          .from(deliveryTracks)
          .where(and(eq(deliveryTracks.companyId, issue.companyId), eq(deliveryTracks.issueId, issue.id)))
          .then((rows) => rows[0] ?? null);

        const values = {
          repositoryUrl: input.repositoryUrl ?? null,
          requireReview: input.requireReview,
          requireVerifiedEvidence: input.requireVerifiedEvidence,
          pinPlanRevision: input.pinPlanRevision,
          reviewerAgentIds: [...new Set(input.reviewerAgentIds)],
        };

        if (!existing) {
          if (actor.type === "agent") {
            const writer = await resolveCurrentWriter(tx, issue);
            assertAgentIsCurrentWriter(actor, issue, writer);
          }
          const [created] = await tx
            .insert(deliveryTracks)
            .values({
              companyId: issue.companyId,
              issueId: issue.id,
              projectId: issue.projectId,
              status: "active",
              enrolledByAgentId: actor.type === "agent" ? actor.agentId : null,
              enrolledByUserId: actor.type === "user" ? actor.userId : null,
              ...values,
            })
            .returning();
          if (!created) throw new Error("Failed to create delivery track");
          return serializeTrack(created);
        }

        if (actor.type !== "user") {
          throw deliveryDenial(
            "delivery_acceptance_actor_forbidden",
            "Only a board user can change or reopen an existing delivery track",
            403,
          );
        }
        const [updated] = await tx
          .update(deliveryTracks)
          .set({ ...values, status: "active", closedAt: null, updatedAt: new Date() })
          .where(eq(deliveryTracks.id, existing.id))
          .returning();
        if (!updated) throw new Error("Failed to update delivery track");
        return serializeTrack(updated);
      });
    },

    /** Board-only: stop tracking. Existing submissions and evidence are retained. */
    closeTrack: async (issueId: string, actor: DeliveryActor) => {
      if (actor.type !== "user") {
        throw deliveryDenial(
          "delivery_acceptance_actor_forbidden",
          "Only a board user can close a delivery track",
          403,
        );
      }
      const issue = await requireIssue(db, issueId);
      const [closed] = await db
        .update(deliveryTracks)
        .set({ status: "closed", closedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(deliveryTracks.companyId, issue.companyId),
          eq(deliveryTracks.issueId, issue.id),
          eq(deliveryTracks.status, "active"),
        ))
        .returning();
      return closed ? serializeTrack(closed) : null;
    },

    snapshot: async (issueId: string, actor: DeliveryActor): Promise<DeliveryStateSnapshot> => {
      const issue = await requireIssue(db, issueId);
      const trackRow = await activeTrackRow(db, issue.companyId, issue.id);
      const track = trackRow ? serializeTrack(trackRow) : null;
      const writer = await resolveCurrentWriter(db, issue);
      const actorIsCurrentWriter =
        actor.type === "agent" && Boolean(actor.runId) && writer.runId === actor.runId
        && issue.assigneeAgentId === actor.agentId;

      const submissionRow = track ? await currentSubmissionRow(db, issue.companyId, issue.id) : null;
      const verdictRow = submissionRow ? await latestVerdictRow(db, issue.companyId, submissionRow.id) : null;
      const acceptanceRow = track
        ? await db
          .select()
          .from(deliveryAcceptances)
          .where(and(
            eq(deliveryAcceptances.companyId, issue.companyId),
            eq(deliveryAcceptances.issueId, issue.id),
          ))
          .orderBy(desc(deliveryAcceptances.createdAt))
          .then((rows) => rows[0] ?? null)
        : null;
      const evidenceRows = track
        ? await db
          .select()
          .from(deliveryVerificationEvidence)
          .where(and(
            eq(deliveryVerificationEvidence.companyId, issue.companyId),
            eq(deliveryVerificationEvidence.issueId, issue.id),
          ))
          .orderBy(desc(deliveryVerificationEvidence.createdAt))
        : [];

      const planRevision = track?.pinPlanRevision
        ? await resolveEffectivePlanRevision(db, issue.companyId, issue.id)
        : null;

      const blockers: DeliveryDenialCode[] = [];
      const allowedActions: DeliveryAction[] = [];
      if (!track) {
        allowedActions.push("enroll");
      } else {
        if (planRevision && !planRevision.effectiveRevisionId) blockers.push("delivery_plan_revision_stale");
        if (actor.type === "user") {
          allowedActions.push("ingest_evidence", "verdict");
          if (submissionRow) allowedActions.push("accept");
        }
        if (actorIsCurrentWriter) allowedActions.push("submit");
        if (
          actor.type === "agent"
          && submissionRow
          && submissionRow.submittedByAgentId !== actor.agentId
          && (track.reviewerAgentIds.length === 0 || track.reviewerAgentIds.includes(actor.agentId))
        ) {
          allowedActions.push("verdict");
        }
        if (track.requireReview && (!verdictRow || verdictRow.verdict !== "pass")) {
          blockers.push(verdictRow ? "delivery_review_not_passed" : "delivery_review_missing");
        }
        if (track.requireVerifiedEvidence && evidenceRows.length === 0) {
          blockers.push("delivery_evidence_missing");
        }
        if (!acceptanceRow) blockers.push("delivery_acceptance_missing");
      }

      return {
        issueId: issue.id,
        enrolled: Boolean(track),
        track,
        planRevision,
        currentWriter: writer,
        actorIsCurrentWriter,
        currentSubmission: submissionRow ? serializeSubmission(submissionRow) : null,
        currentVerdict: verdictRow ? serializeVerdict(verdictRow) : null,
        acceptance: acceptanceRow ? serializeAcceptance(acceptanceRow) : null,
        evidence: evidenceRows.map(serializeEvidence),
        allowedActions,
        blockers,
      };
    },

    /**
     * Records a candidate. The server derives actor, run, and plan revision;
     * the caller only asserts what it believes, and a wrong assertion is a
     * rejection rather than a silent overwrite.
     */
    submit: async (issueId: string, input: DeliverySubmitInput, actor: DeliveryActor) => {
      const issue = await requireIssue(db, issueId);
      return db.transaction(async (tx) => {
        await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${issue.id} for update`);
        const trackRow = await activeTrackRow(tx, issue.companyId, issue.id);
        if (!trackRow) {
          throw deliveryDenial("delivery_not_enrolled", "This issue does not track delivery candidates");
        }
        const track = serializeTrack(trackRow);

        const writer = await resolveCurrentWriter(tx, issue);
        assertAgentIsCurrentWriter(actor, issue, writer);

        if (
          track.repositoryUrl
          && normalizeDeliveryRepositoryUrl(track.repositoryUrl)
            !== normalizeDeliveryRepositoryUrl(input.candidate.repositoryUrl)
        ) {
          throw deliveryDenial(
            "delivery_repository_mismatch",
            "Candidate repository does not match the repository this issue tracks",
            422,
            { expectedRepositoryUrl: track.repositoryUrl },
          );
        }

        const planRevisionId = await resolvePinnedPlanRevision(tx, track, issue, input.expectedPlanRevisionId);
        const evidence = await resolveTrustedEvidence(tx, {
          companyId: issue.companyId,
          issueId: issue.id,
          candidateHeadSha: input.candidate.headSha,
          evidenceRefs: input.evidenceRefs ?? [],
        });

        const existing = await tx
          .select()
          .from(deliverySubmissions)
          .where(and(
            eq(deliverySubmissions.companyId, issue.companyId),
            eq(deliverySubmissions.issueId, issue.id),
            eq(deliverySubmissions.headSha, input.candidate.headSha),
          ))
          .then((rows) => rows[0] ?? null);

        // A newer candidate supersedes older ones so review and acceptance always
        // resolve to exactly one current candidate.
        await tx
          .update(deliverySubmissions)
          .set({ supersededAt: new Date() })
          .where(and(
            eq(deliverySubmissions.companyId, issue.companyId),
            eq(deliverySubmissions.issueId, issue.id),
            isNull(deliverySubmissions.supersededAt),
            ...(existing ? [sql`${deliverySubmissions.id} <> ${existing.id}`] : []),
          ));

        if (existing) {
          const [refreshed] = await tx
            .update(deliverySubmissions)
            .set({
              supersededAt: null,
              baseSha: input.candidate.baseSha,
              repositoryUrl: input.candidate.repositoryUrl,
              planRevisionId,
              evidenceIds: evidence.map((row) => row.id),
              submittedByAgentId: actor.type === "agent" ? actor.agentId : existing.submittedByAgentId,
              submittedByUserId: actor.type === "user" ? actor.userId : existing.submittedByUserId,
              submittedByRunId: actor.type === "agent" ? actor.runId : existing.submittedByRunId,
            })
            .where(eq(deliverySubmissions.id, existing.id))
            .returning();
          if (!refreshed) throw new Error("Failed to update delivery submission");
          return serializeSubmission(refreshed);
        }

        const [created] = await tx
          .insert(deliverySubmissions)
          .values({
            companyId: issue.companyId,
            trackId: track.id,
            issueId: issue.id,
            planRevisionId,
            repositoryUrl: input.candidate.repositoryUrl,
            headSha: input.candidate.headSha,
            baseSha: input.candidate.baseSha,
            submittedByAgentId: actor.type === "agent" ? actor.agentId : null,
            submittedByUserId: actor.type === "user" ? actor.userId : null,
            submittedByRunId: actor.type === "agent" ? actor.runId : null,
            evidenceIds: evidence.map((row) => row.id),
          })
          .returning();
        if (!created) throw new Error("Failed to create delivery submission");
        return serializeSubmission(created);
      });
    },

    /** Appends a review verdict for the current candidate. Never accepts. */
    recordVerdict: async (issueId: string, input: DeliveryVerdictInput, actor: DeliveryActor) => {
      const issue = await requireIssue(db, issueId);
      return db.transaction(async (tx) => {
        await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${issue.id} for update`);
        const trackRow = await activeTrackRow(tx, issue.companyId, issue.id);
        if (!trackRow) {
          throw deliveryDenial("delivery_not_enrolled", "This issue does not track delivery candidates");
        }
        const track = serializeTrack(trackRow);

        if (actor.type === "agent") {
          if (!actor.runId) {
            throw deliveryDenial("delivery_actor_run_required", "Agent review requires an active run", 403);
          }
          if (track.reviewerAgentIds.length > 0 && !track.reviewerAgentIds.includes(actor.agentId)) {
            throw deliveryDenial(
              "delivery_reviewer_not_allowed",
              "This agent is not a configured reviewer for this issue",
              403,
            );
          }
          const run = await tx
            .select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, actor.runId))
            .then((rows) => rows[0] ?? null);
          if (!run || run.agentId !== actor.agentId || TERMINAL_RUN_STATUSES[run.status]) {
            throw deliveryDenial(
              "delivery_actor_run_not_current",
              "Agent review requires the caller's own live run",
              409,
            );
          }
        }

        const submission = await currentSubmissionRow(tx, issue.companyId, issue.id);
        if (!submission) {
          throw deliveryDenial("delivery_candidate_unknown", "No candidate has been submitted for this issue");
        }
        if (submission.headSha !== input.candidateHeadSha) {
          throw deliveryDenial(
            "delivery_candidate_superseded",
            "candidateHeadSha is not the current candidate for this issue",
            409,
            { currentHeadSha: submission.headSha },
          );
        }
        if (actor.type === "agent" && submission.submittedByAgentId === actor.agentId) {
          throw deliveryDenial(
            "delivery_reviewer_not_independent",
            "An agent cannot review the candidate it submitted",
            403,
          );
        }

        const planRevisionId = await resolvePinnedPlanRevision(tx, track, issue, input.expectedPlanRevisionId);
        const evidence = await resolveTrustedEvidence(tx, {
          companyId: issue.companyId,
          issueId: issue.id,
          candidateHeadSha: submission.headSha,
          evidenceRefs: [
            ...(input.evidenceRefs ?? []),
            ...input.findings.flatMap((finding) => (finding.evidenceRef ? [finding.evidenceRef] : [])),
          ],
        });

        const [created] = await tx
          .insert(deliveryVerdicts)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            submissionId: submission.id,
            planRevisionId,
            candidateHeadSha: submission.headSha,
            verdict: input.verdict,
            findings: input.findings,
            reviewerAgentId: actor.type === "agent" ? actor.agentId : null,
            reviewerUserId: actor.type === "user" ? actor.userId : null,
            reviewerRunId: actor.type === "agent" ? actor.runId : null,
            evidenceIds: evidence.map((row) => row.id),
          })
          .returning();
        if (!created) throw new Error("Failed to record delivery verdict");
        return { verdict: serializeVerdict(created), submission: serializeSubmission(submission) };
      });
    },

    /**
     * Board/evaluator acceptance of the current candidate. Model prose and
     * self-reported check labels are never inputs here: review and evidence must
     * already exist as rows.
     */
    accept: async (issueId: string, input: DeliveryAcceptInput, actor: DeliveryActor) => {
      if (actor.type !== "user") {
        throw deliveryDenial(
          "delivery_acceptance_actor_forbidden",
          "Only a board/evaluator identity can accept a delivery candidate",
          403,
        );
      }
      const issue = await requireIssue(db, issueId);
      return db.transaction(async (tx) => {
        await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${issue.id} for update`);
        const trackRow = await activeTrackRow(tx, issue.companyId, issue.id);
        if (!trackRow) {
          throw deliveryDenial("delivery_not_enrolled", "This issue does not track delivery candidates");
        }
        const track = serializeTrack(trackRow);

        const submission = await currentSubmissionRow(tx, issue.companyId, issue.id);
        if (!submission) {
          throw deliveryDenial("delivery_candidate_unknown", "No candidate has been submitted for this issue");
        }
        if (submission.headSha !== input.candidateHeadSha) {
          throw deliveryDenial(
            "delivery_candidate_superseded",
            "candidateHeadSha is not the current candidate for this issue",
            409,
            { currentHeadSha: submission.headSha },
          );
        }

        const planRevisionId = await resolvePinnedPlanRevision(tx, track, issue, input.expectedPlanRevisionId);

        let verdictId: string | null = null;
        if (track.requireReview) {
          const verdict = await latestVerdictRow(tx, issue.companyId, submission.id);
          if (!verdict) {
            throw deliveryDenial("delivery_review_missing", "This issue requires a recorded review before acceptance");
          }
          if (verdict.verdict !== "pass") {
            throw deliveryDenial(
              "delivery_review_not_passed",
              "The current candidate's latest review did not pass",
              409,
              { verdictId: verdict.id },
            );
          }
          if (verdict.reviewerAgentId && verdict.reviewerAgentId === submission.submittedByAgentId) {
            throw deliveryDenial(
              "delivery_reviewer_not_independent",
              "The recorded reviewer is the submitter of this candidate",
            );
          }
          verdictId = verdict.id;
        } else {
          verdictId = (await latestVerdictRow(tx, issue.companyId, submission.id))?.id ?? null;
        }

        if (track.requireVerifiedEvidence && input.verificationEvidenceRefs.length === 0) {
          throw deliveryDenial(
            "delivery_evidence_missing",
            "This issue requires registered verification evidence for acceptance",
          );
        }
        const evidence = await resolveTrustedEvidence(tx, {
          companyId: issue.companyId,
          issueId: issue.id,
          candidateHeadSha: submission.headSha,
          evidenceRefs: input.verificationEvidenceRefs,
        });
        if (track.pinPlanRevision) {
          const mismatched = evidence.filter((row) => row.planRevisionId && row.planRevisionId !== planRevisionId);
          if (mismatched.length > 0) {
            throw deliveryDenial(
              "delivery_evidence_untrusted",
              "Evidence was registered against a different plan revision",
              422,
              { evidenceIds: mismatched.map((row) => row.id) },
            );
          }
        }

        const existing = await tx
          .select()
          .from(deliveryAcceptances)
          .where(and(
            eq(deliveryAcceptances.companyId, issue.companyId),
            eq(deliveryAcceptances.issueId, issue.id),
            eq(deliveryAcceptances.candidateHeadSha, submission.headSha),
          ))
          .then((rows) => rows[0] ?? null);
        if (existing) {
          const [refreshed] = await tx
            .update(deliveryAcceptances)
            .set({
              submissionId: submission.id,
              verdictId,
              planRevisionId,
              evidenceIds: evidence.map((row) => row.id),
              acceptedByUserId: actor.userId,
              acceptedBySessionId: actor.sessionId,
            })
            .where(eq(deliveryAcceptances.id, existing.id))
            .returning();
          if (!refreshed) throw new Error("Failed to update delivery acceptance");
          return serializeAcceptance(refreshed);
        }

        const [created] = await tx
          .insert(deliveryAcceptances)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            submissionId: submission.id,
            verdictId,
            planRevisionId,
            candidateHeadSha: submission.headSha,
            evidenceIds: evidence.map((row) => row.id),
            acceptedByUserId: actor.userId,
            acceptedBySessionId: actor.sessionId,
          })
          .returning();
        if (!created) throw new Error("Failed to create delivery acceptance");
        return serializeAcceptance(created);
      });
    },

    /**
     * Trusted verification-evidence ingestion. Board/evaluator only: this is the
     * one operation that turns an external verification result into something
     * acceptance will read, and no agent may call it.
     */
    ingestEvidence: async (issueId: string, input: DeliveryEvidenceIngestInput, actor: DeliveryActor) => {
      if (actor.type !== "user") {
        throw deliveryDenial(
          "delivery_acceptance_actor_forbidden",
          "Only a board/evaluator identity can register verification evidence",
          403,
        );
      }
      const issue = await requireIssue(db, issueId);
      const trackRow = await activeTrackRow(db, issue.companyId, issue.id);
      if (!trackRow) {
        throw deliveryDenial("delivery_not_enrolled", "This issue does not track delivery candidates");
      }

      if (input.planRevisionId) {
        const belongsToPlan = await db
          .select({ id: documentRevisions.id })
          .from(issueDocuments)
          .innerJoin(documentRevisions, eq(documentRevisions.documentId, issueDocuments.documentId))
          .where(and(
            eq(issueDocuments.companyId, issue.companyId),
            eq(issueDocuments.issueId, issue.id),
            eq(issueDocuments.key, "plan"),
            eq(documentRevisions.id, input.planRevisionId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!belongsToPlan) {
          throw deliveryDenial(
            "delivery_plan_revision_mismatch",
            "planRevisionId must be a revision of this issue's plan document",
          );
        }
      }

      const existing = await db
        .select()
        .from(deliveryVerificationEvidence)
        .where(and(
          eq(deliveryVerificationEvidence.companyId, issue.companyId),
          eq(deliveryVerificationEvidence.issueId, issue.id),
          eq(deliveryVerificationEvidence.digest, input.digest),
        ))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        // Immutable: a repeated ingestion of identical bytes returns the row it
        // already produced, and a conflicting re-registration is refused.
        if (existing.candidateHeadSha !== input.candidateHeadSha || existing.kind !== input.kind) {
          throw deliveryDenial(
            "delivery_evidence_untrusted",
            "This digest is already registered for a different candidate or kind",
            409,
            { evidenceId: existing.id },
          );
        }
        return serializeEvidence(existing);
      }

      const [created] = await db
        .insert(deliveryVerificationEvidence)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          planRevisionId: input.planRevisionId ?? null,
          candidateHeadSha: input.candidateHeadSha,
          kind: input.kind,
          digest: input.digest,
          producerLabel: input.producerLabel,
          producedByUserId: actor.userId,
          producedBySessionId: actor.sessionId,
          summary: input.summary as Record<string, unknown>,
        })
        .returning();
      if (!created) throw new Error("Failed to register verification evidence");
      return serializeEvidence(created);
    },
  };
}
