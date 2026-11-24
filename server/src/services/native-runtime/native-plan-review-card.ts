import { and, eq, inArray } from "drizzle-orm";
import { documentRevisions, documents, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { logActivity, publishActivity } from "../activity-log.js";
import { documentService } from "../documents.js";
import { HttpError } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { activeIssueInteractionCondition, hasGovernedPayload } from "../issue-question-context.js";
import { isConversation } from "../../lib/conversation-wake-policy.js";

/**
 * The Plan-mode review card for the current plan revision.
 *
 * Codex and Claude report their plan as a provider event, and the session
 * opens the Approve / Request changes card for it. Harnesses without such an
 * event (Antigravity and other ACPX agents) write the Plan document with a
 * tool and must open the card themselves. A run that forgets, or a recovered
 * run that resumes after the original process died, would otherwise leave a
 * Plan-mode task waiting on a review nobody can give. When a Plan-mode run
 * settles, the server opens the card for the current revision unless one
 * already covers it.
 */
export type NativePlanReviewCardOutcome =
  /** The server opened the card for this revision. */
  | { kind: "created"; interactionId: string; revisionId: string }
  /** A pending card (or question) already gives the user the next action. */
  | { kind: "pending"; interactionId: string }
  /** The current revision was already answered; the agent owes a new revision. */
  | { kind: "reviewed"; revisionId: string }
  /** Plan mode produced no plan to review. */
  | { kind: "no_plan" }
  /** Not a Plan-mode task this agent owns, or the revision is not the agent's. */
  | { kind: "not_applicable" };

type Binding = { companyId: string; issueId: string; runId: string; agentId: string };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function planReviewCardIdempotencyKey(revisionId: string): string {
  return `plan-review:v1:${revisionId}`;
}

/**
 * The one Plan-review card shape, for the card Paperclip opens from a
 * provider's plan event (Codex, Claude) and the one it opens on settle.
 */
export function planReviewConfirmationInput(input: {
  issueId: string;
  documentId: string;
  revisionId: string;
  revisionNumber: number;
  sourceRunId: string;
  idempotencyKey: string;
  source: "provider_plan" | "plan_document";
}) {
  return {
    kind: "request_confirmation" as const,
    idempotencyKey: input.idempotencyKey,
    sourceRunId: input.sourceRunId,
    title: `Review plan revision ${input.revisionNumber}`,
    summary: input.source === "provider_plan"
      ? "Review the synchronized Paperclip plan."
      : "Review the plan before the agent starts the work.",
    continuationPolicy: "wake_assignee" as const,
    payload: {
      version: 1 as const,
      prompt: `Approve plan revision ${input.revisionNumber}?`,
      ...(input.source === "provider_plan"
        ? { detailsMarkdown: "The completed provider plan has been synchronized to the canonical Plan document." }
        : {}),
      acceptLabel: "Approve plan",
      rejectLabel: "Request changes",
      rejectRequiresReason: true,
      supersedeOnUserComment: false,
      target: {
        type: "issue_document" as const,
        issueId: input.issueId,
        documentId: input.documentId,
        key: "plan",
        revisionId: input.revisionId,
        revisionNumber: input.revisionNumber,
        label: `Plan v${input.revisionNumber}`,
      },
    },
  };
}

async function coveringCard(db: Db, binding: Binding, revision: { id: string }, conversationMode: boolean) {
  // A historical or deferred card cannot give the user the next action; the
  // same rule decides the run's governance gate.
  const active = new Set((await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, binding.companyId),
    eq(issueThreadInteractions.issueId, binding.issueId),
    eq(issueThreadInteractions.status, "pending"),
    activeIssueInteractionCondition({ runId: binding.runId, conversationMode }),
  ))).map(row => row.id));
  const cards = await db.select({
    id: issueThreadInteractions.id,
    kind: issueThreadInteractions.kind,
    status: issueThreadInteractions.status,
    payload: issueThreadInteractions.payload,
    createdAt: issueThreadInteractions.createdAt,
    resolvedByUserId: issueThreadInteractions.resolvedByUserId,
    resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
    result: issueThreadInteractions.result,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, binding.companyId),
    eq(issueThreadInteractions.issueId, binding.issueId),
    inArray(issueThreadInteractions.kind, ["request_confirmation", "ask_user_questions"]),
  ));
  const targetRevision = (payload: unknown) => {
    const target = record(record(payload).target);
    return target.type === "issue_document" && typeof target.revisionId === "string" ? target.revisionId : null;
  };
  // Only an explicit plan review covers a revision: a card bound to this
  // revision (the server's, Codex/Claude's, or an agent's card opened with the
  // plan target). An unbound confirmation is an ordinary request: it never
  // covers a plan, never starts execution and is never withdrawn here. A
  // pending question also gives the user the next action. A card bound to an
  // older revision does not cover this one.
  const covers = (card: (typeof cards)[number]) => {
    if (card.kind === "ask_user_questions") return card.status === "pending";
    if (hasGovernedPayload(card.payload)) return false;
    return targetRevision(card.payload) === revision.id;
  };
  // A pending card bound to this revision always gates it, also when the
  // conversation prior-turn rule would leave it out of the active set.
  const pending = cards.find(card => card.status === "pending" && covers(card) &&
    (active.has(card.id) || targetRevision(card.payload) === revision.id));
  if (pending) return { kind: "pending" as const, interactionId: pending.id };
  // How each terminal state of a card bound to this revision counts:
  // - accepted or rejected: the user decided this revision;
  // - cancelled by the user (withdrawn from the thread): the user declined to
  //   review this revision. Do not reopen it; the agent is asked to revise.
  // - cancelled by an agent or the system, expired (superseded, stale, task
  //   closed) or failed: no one reviewed it. The revision gets a fresh card.
  // A card withdrawn as a stale target was for an older revision, even though
  // the withdrawal records the current revision on it.
  const bound = cards.filter(card => card.kind === "request_confirmation" && covers(card) &&
    record(card.result).outcome !== "stale_target");
  const decided = bound.find(card => ["accepted", "rejected"].includes(card.status) ||
    (card.status === "cancelled" && card.resolvedByUserId && !card.resolvedByAgentId));
  if (decided) return { kind: "reviewed" as const, revisionId: revision.id };
  const unreviewed = bound.filter(card => card.status !== "pending")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return unreviewed ? { kind: "reopen" as const, afterInteractionId: unreviewed.id } : null;
}

export async function ensureNativePlanReviewCard(db: Db, binding: Binding): Promise<NativePlanReviewCardOutcome> {
  const publications: Parameters<typeof publishActivity>[0][] = [];
  // One decision per task at a time: reading the current revision and its
  // cards, withdrawing older cards, choosing the key and inserting all happen
  // under the task row lock, so two settles can never both open a card for
  // one plan. Card creation takes the same lock first, so the order matches.
  const outcome = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [issue] = await tx.select({
      workMode: issues.workMode, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId, hiddenAt: issues.hiddenAt,
      conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId,
    }).from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).limit(1).for("update");
    if (!issue || issue.workMode !== "planning" || issue.hiddenAt || issue.assigneeUserId ||
      issue.assigneeAgentId !== binding.agentId || ["done", "cancelled"].includes(issue.status)) {
      return { kind: "not_applicable" } as const;
    }
    const plan = await documentService(tx).getIssueDocumentByKey(binding.issueId, "plan");
    if (!plan?.latestRevisionId) return { kind: "no_plan" } as const;
    const [revision] = await tx.select({
      id: documentRevisions.id, revisionNumber: documentRevisions.revisionNumber,
      createdByAgentId: documentRevisions.createdByAgentId,
    }).from(documentRevisions).where(and(
      eq(documentRevisions.id, plan.latestRevisionId), eq(documentRevisions.companyId, binding.companyId),
    )).limit(1);
    if (!revision) return { kind: "no_plan" } as const;
    // A delayed settle that read an older revision must not act on it.
    const [current] = await tx.select({ latestRevisionId: documents.latestRevisionId, latestRevisionNumber: documents.latestRevisionNumber })
      .from(documents).where(and(eq(documents.id, plan.id), eq(documents.companyId, binding.companyId))).for("update");
    if (current?.latestRevisionId !== revision.id) return { kind: "not_applicable" } as const;
    const conversationMode = isConversation(issue);
    const existing = await coveringCard(tx, binding, revision, conversationMode);
    if (existing && existing.kind !== "reopen") return existing;
    // Only the assigned agent's own proposal is put up for review. A revision
    // a person wrote is theirs already.
    if (revision.createdByAgentId !== binding.agentId) return { kind: "not_applicable" } as const;
    // A card for this revision that no one reviewed keeps its key; the fresh
    // card's key names the one it follows.
    const idempotencyKey = existing?.kind === "reopen"
      ? `${planReviewCardIdempotencyKey(revision.id)}:after:${existing.afterInteractionId}`
      : planReviewCardIdempotencyKey(revision.id);
    // Withdraw cards bound to an older revision. Answering one is already
    // refused as a stale target, so this only tidies the thread: a row it
    // cannot read must not stop the current card from opening.
    await tx.transaction(async (savepoint) => {
      await issueThreadInteractionService(savepoint as unknown as Db).expireStaleRequestConfirmationsForIssueDocument(
        { id: binding.issueId, companyId: binding.companyId },
        { id: plan.id, key: "plan", latestRevisionId: current.latestRevisionId, latestRevisionNumber: current.latestRevisionNumber },
        { agentId: binding.agentId, runId: binding.runId });
    }).catch((error: unknown) => logger.warn({ issueId: binding.issueId, error }, "Could not withdraw stale plan review cards"));
    let inserted = false;
    try {
      const interaction = await issueThreadInteractionService(tx).create(
        { id: binding.issueId, companyId: binding.companyId },
        planReviewConfirmationInput({
          issueId: binding.issueId, documentId: plan.id, revisionId: revision.id, revisionNumber: revision.revisionNumber,
          sourceRunId: binding.runId, source: "plan_document", idempotencyKey,
        }) as never,
        { agentId: binding.agentId, runId: binding.runId },
        {
          // Leave the agent's other pending cards answerable. Only cards bound
          // to an older plan revision were withdrawn above; an unbound card is
          // never withdrawn by guess.
          supersedePendingSiblingInteractions: false,
          // Only the call that inserted the card records it.
          afterInsertInTransaction: async (insertTx, row) => {
            inserted = true;
            await logActivity(insertTx, {
              companyId: binding.companyId,
              actorType: "system",
              actorId: "native-plan-review",
              agentId: binding.agentId,
              runId: binding.runId,
              issueId: binding.issueId,
              action: "issue.thread_interaction_created",
              entityType: "issue",
              entityId: binding.issueId,
              details: {
                interactionId: row.id,
                interactionKind: "request_confirmation",
                source: "plan_mode_settle",
                planRevisionId: revision.id,
                planRevisionNumber: revision.revisionNumber,
              },
            }, publications);
          },
        },
      );
      return inserted
        ? { kind: "created", interactionId: interaction.id, revisionId: revision.id } as const
        : { kind: "pending", interactionId: interaction.id } as const;
    } catch (error) {
      // The task closed or the agent may no longer write here. A refused card
      // must not fail the run's settlement; database errors still surface so
      // finalization (or the recovery pass) retries.
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      const covered = await coveringCard(tx, binding, revision, conversationMode);
      return covered && covered.kind !== "reopen" ? covered : { kind: "not_applicable" } as const;
    }
  });
  for (const publication of publications) publishActivity(publication);
  return outcome;
}
