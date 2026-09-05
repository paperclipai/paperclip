import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatConversations,
  chatEndpoints,
  chatPublications,
} from "@paperclipai/db";
import type { ExternalChannelBindingSummary } from "@paperclipai/shared";

/**
 * Derive the task-facing chat binding from durable Paperclip records. The
 * company predicate is intentionally part of the lookup so callers cannot use
 * a globally unique task id as a cross-company discovery oracle.
 */
export async function getExternalChannelBindingSummary(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<ExternalChannelBindingSummary | null> {
  const row = await db
    .select({
      conversation: chatConversations,
      endpoint: chatEndpoints,
      publicationState: chatPublications.state,
    })
    .from(chatConversations)
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.companyId, chatConversations.companyId),
        eq(chatEndpoints.id, chatConversations.endpointId),
      ),
    )
    .leftJoin(
      chatPublications,
      and(
        eq(chatPublications.companyId, chatConversations.companyId),
        eq(chatPublications.conversationId, chatConversations.id),
      ),
    )
    .where(
      and(
        eq(chatConversations.companyId, companyId),
        eq(chatConversations.issueId, issueId),
      ),
    )
    .orderBy(desc(chatPublications.createdAt), desc(chatConversations.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return {
    endpointId: row.endpoint.id,
    provider: row.endpoint.provider,
    botLabel: row.endpoint.botDisplayName,
    externalLabel: row.conversation.externalLabel,
    externalUrl: row.conversation.providerUrl,
    conversationId: row.conversation.id,
    publicationState: row.publicationState ?? null,
    assignedAgentLocked: true,
  };
}
