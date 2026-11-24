import { and, eq, inArray, sql } from "drizzle-orm";
import { documentRevisions, documents, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { logActivity, publishActivity } from "../activity-log.js";
import { documentService } from "../documents.js";
import { HttpError } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { activeIssueInteractionCondition, governedActionPayloadSql, GOVERNED_REVIEW_PAYLOAD_KEYS, hasGovernedPayload } from "../issue-question-context.js";
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

async function coveringCard(db: Db, binding: Binding, revision: { id: string; createdAt: Date }, conversationMode: boolean) {
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
    createdByAgentId: issueThreadInteractions.createdByAgentId,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, binding.companyId),
    eq(issueThreadInteractions.issueId, binding.issueId),
    inArray(issueThreadInteractions.kind, ["request_confirmation", "ask_user_questions"]),
  ));
  const targetRevision = (payload: unknown) => {
    const target = record(record(payload).target);
    return target.type === "issue_document" && typeof target.revisionId === "string" ? target.revisionId : null;
  };
  // A card covers the revision when it is a plan review of it: bound to this
  // revision (the server's and Codex/Claude cards), or the plain confirmation
  // the assigned agent opened itself after writing it (ACPX agents open their
  // plan card without a target). A pending question also gives the user the
  // next action. A card bound to an older revision does not: the new one
  // replaces it.
  const covers = (card: (typeof cards)[number]) => {
    if (card.kind === "ask_user_questions") return card.status === "pending";
    // Governed-action cards (tool calls, secrets, connections, quality
    // reviews) are about something else and never stand in for a plan review.
    if (hasGovernedPayload(card.payload)) return false;
    const revisionId = targetRevision(card.payload);
    if (revisionId) return revisionId === revision.id;
    return card.createdByAgentId === binding.agentId && card.createdAt >= revision.createdAt;
  };
  // A pending card bound to this revision always gates it, also when the
  // conversation prior-turn rule would leave it out of the active set.
  const pending = cards.find(card => card.status === "pending" && covers(card) &&
    (active.has(card.id) || targetRevision(card.payload) === revision.id));
  if (pending) return { kind: "pending" as const, interactionId: pending.id };
  const answered = cards.find(card => card.kind === "request_confirmation" && card.status !== "expired" && covers(card));
  if (answered) return { kind: "reviewed" as const, revisionId: revision.id };
  return null;
}

export async function ensureNativePlanReviewCard(db: Db, binding: Binding): Promise<NativePlanReviewCardOutcome> {
  const [issue] = await db.select({
    workMode: issues.workMode, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId, hiddenAt: issues.hiddenAt,
    conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId,
  }).from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).limit(1);
  if (!issue || issue.workMode !== "planning" || issue.hiddenAt || issue.assigneeUserId ||
    issue.assigneeAgentId !== binding.agentId || ["done", "cancelled"].includes(issue.status)) {
    return { kind: "not_applicable" };
  }
  const plan = await documentService(db).getIssueDocumentByKey(binding.issueId, "plan");
  if (!plan?.latestRevisionId) return { kind: "no_plan" };
  const [revision] = await db.select({
    id: documentRevisions.id, revisionNumber: documentRevisions.revisionNumber,
    createdAt: documentRevisions.createdAt, createdByAgentId: documentRevisions.createdByAgentId,
  }).from(documentRevisions).where(and(
    eq(documentRevisions.id, plan.latestRevisionId), eq(documentRevisions.companyId, binding.companyId),
  )).limit(1);
  if (!revision) return { kind: "no_plan" };
  const conversationMode = isConversation(issue);
  const existing = await coveringCard(db, binding, revision, conversationMode);
  if (existing) return existing;
  // Only the assigned agent's own proposal is put up for review. A revision a
  // person wrote is theirs already.
  if (revision.createdByAgentId !== binding.agentId) return { kind: "not_applicable" };

  // Withdraw review cards bound to an older plan revision, judged against
  // the locked current document: a delayed settle for an older revision must
  // never withdraw the card of a newer one. Answering a stale card is already
  // refused, so this only tidies the thread and is best effort.
  let superseded = false;
  await db.transaction(async (tx) => {
    // Issue before document: the same lock order as card creation.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update");
    const [current] = await tx.select({ latestRevisionId: documents.latestRevisionId, latestRevisionNumber: documents.latestRevisionNumber })
      .from(documents).where(and(eq(documents.id, plan.id), eq(documents.companyId, binding.companyId))).for("update");
    if (current?.latestRevisionId !== revision.id) {
      superseded = true;
      return;
    }
    await issueThreadInteractionService(tx as unknown as Db).expireStaleRequestConfirmationsForIssueDocument(
      { id: binding.issueId, companyId: binding.companyId },
      { id: plan.id, key: "plan", latestRevisionId: current.latestRevisionId, latestRevisionNumber: current.latestRevisionNumber },
      { agentId: binding.agentId, runId: binding.runId });
  }).catch((error: unknown) => logger.warn({ issueId: binding.issueId, error }, "Could not withdraw stale plan review cards"));
  // A newer revision was written meanwhile; its own settle opens its card.
  if (superseded) return { kind: "not_applicable" };
  const interactions = issueThreadInteractionService(db);
  let inserted = false;
  const publications: Parameters<typeof publishActivity>[0][] = [];
  let interactionId: string;
  try {
    const interaction = await interactions.create(
      { id: binding.issueId, companyId: binding.companyId },
      planReviewConfirmationInput({
        issueId: binding.issueId, documentId: plan.id, revisionId: revision.id, revisionNumber: revision.revisionNumber,
        sourceRunId: binding.runId, source: "plan_document",
        // One card per revision, whichever run, retry or reconcile opens it.
        idempotencyKey: planReviewCardIdempotencyKey(revision.id),
      }) as never,
      { agentId: binding.agentId, runId: binding.runId },
      {
        // Replace the agent's own earlier plan confirmations (an ACPX agent's
        // card has no target, so the document cleanup above cannot see it)
        // while its tool, secret, connection and quality-review cards stay
        // answerable. A plain card made after this revision covers it, so any
        // sibling left here is about an older plan.
        supersedeSiblingFilter: sql`not ${governedActionPayloadSql(GOVERNED_REVIEW_PAYLOAD_KEYS)}
          and coalesce(${issueThreadInteractions.payload}->'target'->>'type' = 'issue_document'
            and ${issueThreadInteractions.payload}->'target'->>'key' = 'plan', ${issueThreadInteractions.payload}->'target' is null)`,
        // Only the call that inserted the card records it; a concurrent or
        // repeated settle replays the same card and logs nothing.
        afterInsertInTransaction: async (tx, row) => {
          inserted = true;
          await logActivity(tx, {
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
    interactionId = interaction.id;
  } catch (error) {
    // A concurrent settle opened it first (same key, other run), the plan
    // moved on, the task closed, or the agent may no longer write here.
    // Whatever now covers the revision wins; a refused card must not fail the
    // run's settlement. Database errors still surface, so finalization retries.
    if (!(error instanceof HttpError) || error.status >= 500) throw error;
    return await coveringCard(db, binding, revision, conversationMode) ?? { kind: "not_applicable" };
  }
  for (const publication of publications) publishActivity(publication);
  if (!inserted) return { kind: "pending", interactionId };
  return { kind: "created", interactionId, revisionId: revision.id };
}
