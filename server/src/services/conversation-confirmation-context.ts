import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";

/** Supply current card identities even when they were created outside the provider session. */
export async function getConversationConfirmationContext(input: {
  db: Db; companyId: string; issueId: string; agentId: string;
}) {
  const { db, companyId, issueId, agentId } = input;
  const [issue] = await db.select({ boundaryId: issues.conversationBoundaryCommentId }).from(issues).where(and(
    eq(issues.id, issueId), eq(issues.companyId, companyId),
    eq(issues.conversationAgentId, agentId), eq(issues.assigneeAgentId, agentId), isNotNull(issues.conversationUserId),
  ));
  if (!issue) return null;
  const [boundary] = issue.boundaryId ? await db.select({ createdAt: issueComments.createdAt }).from(issueComments).where(and(
    eq(issueComments.id, issue.boundaryId), eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
  )) : [];
  if (issue.boundaryId && !boundary) return null;
  const limit = 12;
  const rows = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
    eq(issueThreadInteractions.status, "pending"),
    inArray(issueThreadInteractions.kind, ["request_confirmation", "request_checkbox_confirmation"]),
    // Dedicated approval payloads are not conversational confirmations.
    sql`not (${issueThreadInteractions.payload} ?| array['toolAction', 'secretProposal', 'connectionAuthorization'])`,
    boundary ? gt(issueThreadInteractions.createdAt, boundary.createdAt) : undefined,
  )).orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id)).limit(limit + 1);
  return {
    truncated: rows.length > limit,
    cards: rows.slice(0, limit).map(card => {
      const payload = card.payload as unknown as Record<string, unknown>;
      const options = Array.isArray(payload.options) ? payload.options as Array<{ id: string; label: string }> : [];
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      return {
        id: card.id, kind: card.kind, status: card.status, title: card.title?.slice(0, 256) ?? null,
        prompt: prompt.slice(0, 2000), promptTruncated: prompt.length > 2000,
        resolverPolicy: card.effectiveResolverPolicy,
        addresseeAgentId: card.addresseeAgentId, addresseeUserId: card.addresseeUserId,
        options: options.slice(0, 20).map(option => ({ id: option.id, label: option.label.slice(0, 256) })),
        optionsTruncated: options.length > 20,
      };
    }),
  };
}

export type ConversationConfirmationContext = Awaited<ReturnType<typeof getConversationConfirmationContext>>;
