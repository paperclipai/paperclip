import { and, desc, eq, isNull } from "drizzle-orm";
import { heartbeatRuns, issueComments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { resolveConfirmationFromCommentSchema, type ResolveConfirmationFromComment } from "@paperclipai/shared";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { assertIssueThreadInteractionResolverAudience } from "./issue-thread-interaction-resolution.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

type ResolutionActor = Parameters<ReturnType<typeof issueThreadInteractionService>["acceptInteraction"]>[3];

/**
 * Record the agent's interpretation of a reply, using the agent's own authority.
 * The message is provenance, not a credential or server-verified proof of consent.
 * Never promote its author to the resolver: human-only and independent-review
 * gates must still reject this agent, even when the referenced text says yes.
 */
export async function resolveConfirmationFromComment(db: Db, args: {
  companyId: string;
  issueId: string;
  interactionId: string;
  input: ResolveConfirmationFromComment;
  actor: ResolutionActor & { agentId: string; runId: string };
}) {
  const input = resolveConfirmationFromCommentSchema.parse(args.input);
  let publication: ActivityPublication | null = null;
  const commitEffects: Array<(committedDb: Db) => Promise<void>> = [];
  const result = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // Match task mutation/Stop/reset lock ordering, including replay checks.
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, args.issueId), eq(issues.companyId, args.companyId),
    )).for("update");
    if (!issue) throw notFound("Issue not found");
    await assertAgentRunWriteAllowed(tx, args.companyId, args.actor);
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, args.actor.runId), eq(heartbeatRuns.companyId, args.companyId),
      eq(heartbeatRuns.agentId, args.actor.agentId),
    )).for("share");
    if (!run || run.status !== "running" || issue.executionRunId !== run.id
      || issue.assigneeAgentId !== args.actor.agentId
      || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) !== issue.id) {
      throw forbidden("Only the active responding run can record a conversational decision");
    }
    const [card] = await tx.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, args.interactionId), eq(issueThreadInteractions.companyId, args.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
    )).for("update");
    if (!card) throw notFound("Interaction not found");
    if (card.kind !== "request_confirmation" && card.kind !== "request_checkbox_confirmation") {
      throw unprocessable("Only confirmation cards can be answered from a conversation");
    }
    const payload = card.payload as unknown as Record<string, unknown>;
    if (payload.toolAction || payload.secretProposal || payload.connectionAuthorization) {
      throw forbidden("Governed actions must use their dedicated approval controls");
    }
    const [comment] = await tx.select().from(issueComments).where(and(
      eq(issueComments.id, input.commentId), eq(issueComments.companyId, args.companyId),
      eq(issueComments.issueId, issue.id),
    )).for("share");
    if (!comment || comment.deletedAt || comment.authorType !== "user"
      || !comment.authorUserId || comment.authorAgentId || comment.createdByRunId
      || comment.sourceTrust?.disposition === "quarantined"
      || comment.createdAt < card.createdAt || comment.body.trim() === "/new") {
      throw unprocessable("The answer must be a user message posted after this confirmation on the same task");
    }
    if ((issue.conversationUserId && comment.authorUserId !== issue.conversationUserId)
      || (run.responsibleUserId && comment.authorUserId !== run.responsibleUserId)) {
      throw forbidden("The answer is not from this conversation's user");
    }
    if (issue.conversationAgentId) {
      if (run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration) {
        throw conflict("Conversation session changed");
      }
      if (issue.conversationBoundaryCommentId) {
        const [boundary] = await tx.select().from(issueComments).where(and(
          eq(issueComments.id, issue.conversationBoundaryCommentId), eq(issueComments.companyId, args.companyId),
          eq(issueComments.issueId, issue.id),
        ));
        if (!boundary || card.createdAt <= boundary.createdAt || comment.createdAt <= boundary.createdAt) {
          throw conflict("A new conversation cannot answer a previous session's confirmation");
        }
      }
    }
    const [latest] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, args.companyId), eq(issueComments.issueId, issue.id),
      eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt),
    )).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
    if (latest?.id !== comment.id) throw conflict("A newer user message must be considered before resolving this confirmation");

    const svc = issueThreadInteractionService(tx);
    const current = await svc.getForIssue(issue, card.id);
    assertIssueThreadInteractionResolverAudience({
      actor: { type: "agent", agentId: args.actor.agentId, runId: args.actor.runId },
      interaction: card, additionalRestriction: args.actor.resolverPolicyRestriction,
    });
    const expected = input.decision === "accept" ? "accepted" : "rejected";
    const selected = input.selectedOptionIds;
    if (card.kind === "request_checkbox_confirmation" && input.decision === "accept" && selected === undefined) {
      throw unprocessable("Record the user's explicit selection; checkbox defaults are not an answer");
    }
    if (card.kind === "request_confirmation" && selected !== undefined) {
      throw unprocessable("Selections apply only to checkbox confirmations");
    }
    if (card.status !== "pending") {
      const prior = current.result as { commentId?: string; selectedOptionIds?: string[]; reason?: string } | null;
      const sameSelection = JSON.stringify([...(prior?.selectedOptionIds ?? [])].sort()) === JSON.stringify([...(selected ?? [])].sort());
      if (card.status !== expected || prior?.commentId !== comment.id || !sameSelection
        || (input.decision === "reject" && (prior?.reason ?? "") !== (input.reason ?? ""))) {
        throw conflict("This confirmation already has a different decision");
      }
      return { interaction: current, deduplicated: true };
    }

    // These service methods recheck resolver audience, company review policy,
    // target revision, selection bounds and issue lifecycle under the same lock.
    const mutationOptions = { deferConfirmationCommitEffects: (effect: (committedDb: Db) => Promise<void>) => { commitEffects.push(effect); } };
    const interaction = input.decision === "accept"
      ? (await svc.acceptInteraction(issue, card.id, { selectedOptionIds: selected }, args.actor, mutationOptions)).interaction
      : await svc.rejectInteraction(issue, card.id, { reason: input.reason }, args.actor, mutationOptions);
    if ((interaction.kind !== "request_confirmation" && interaction.kind !== "request_checkbox_confirmation") || !interaction.result) {
      throw conflict("Confirmation resolution did not persist a result");
    }
    await tx.update(issueThreadInteractions).set({
      result: { ...interaction.result, commentId: comment.id },
    }).where(and(eq(issueThreadInteractions.id, card.id), eq(issueThreadInteractions.companyId, args.companyId)));
    publication = (await persistActivity(tx, {
      companyId: args.companyId, actorType: "agent", actorId: args.actor.agentId,
      agentId: args.actor.agentId, runId: args.actor.runId,
      action: `issue.thread_interaction_${expected}`, entityType: "issue", entityId: issue.id,
      details: { interactionId: card.id, interactionKind: card.kind, interactionStatus: expected,
        responseCommentId: comment.id, responseUserId: comment.authorUserId, source: "conversation_reply" },
    })).publication;
    return { interaction: await svc.getForIssue(issue, card.id), deduplicated: false };
  });
  if (publication) publishActivity(publication);
  for (const effect of commitEffects) await effect(db);
  return result;
}
