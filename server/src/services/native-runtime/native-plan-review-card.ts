import { and, eq, inArray } from "drizzle-orm";
import { documentRevisions, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { logActivity, publishActivity } from "../activity-log.js";
import { documentService } from "../documents.js";
import { HttpError } from "../../errors.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { activeIssueInteractionCondition } from "../issue-question-context.js";
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
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, binding.companyId),
    eq(issueThreadInteractions.issueId, binding.issueId),
    inArray(issueThreadInteractions.kind, ["request_confirmation", "ask_user_questions"]),
  ));
  const targetRevision = (payload: unknown) => {
    const target = record(record(payload).target);
    return target.type === "issue_document" && typeof target.revisionId === "string" ? target.revisionId : null;
  };
  // A pending question, or a card the agent opened for this revision without
  // naming it, already covers the revision. A card bound to an older revision
  // does not: the new card replaces it.
  const covers = (card: (typeof cards)[number]) => {
    if (card.kind === "ask_user_questions") return card.status === "pending";
    const revisionId = targetRevision(card.payload);
    if (revisionId) return revisionId === revision.id;
    return card.createdAt >= revision.createdAt;
  };
  const pending = cards.find(card => card.status === "pending" && active.has(card.id) && covers(card));
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

  let inserted = false;
  const publications: Parameters<typeof publishActivity>[0][] = [];
  let interactionId: string;
  try {
    const interaction = await issueThreadInteractionService(db).create(
      { id: binding.issueId, companyId: binding.companyId },
      {
        kind: "request_confirmation",
        // One card per revision, whichever run, retry or reconcile opens it.
        idempotencyKey: planReviewCardIdempotencyKey(revision.id),
        sourceRunId: binding.runId,
        title: `Review plan revision ${revision.revisionNumber}`,
        summary: "Review the plan before the agent starts the work.",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: `Approve plan revision ${revision.revisionNumber}?`,
          acceptLabel: "Approve plan",
          rejectLabel: "Request changes",
          rejectRequiresReason: true,
          supersedeOnUserComment: false,
          target: {
            type: "issue_document",
            issueId: binding.issueId,
            documentId: plan.id,
            key: "plan",
            revisionId: revision.id,
            revisionNumber: revision.revisionNumber,
            label: `Plan v${revision.revisionNumber}`,
          },
        },
      } as never,
      { agentId: binding.agentId, runId: binding.runId },
      {
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
    // moved on, or the task closed. Whatever now covers the revision wins.
    if (!(error instanceof HttpError) || ![409, 422].includes(error.status)) throw error;
    return await coveringCard(db, binding, revision, conversationMode) ?? { kind: "not_applicable" };
  }
  for (const publication of publications) publishActivity(publication);
  if (!inserted) return { kind: "pending", interactionId };
  return { kind: "created", interactionId, revisionId: revision.id };
}
