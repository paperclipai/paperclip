import { chatMessageLinks, type Db, type issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { photonReplyReference } from "../../photon/adapter.js";
import { logActivity, type ActivityPublication } from "../../activity-log.js";
import type { DbOrTransaction, EndpointRow } from "../runtime-types.js";

export async function photonControlTargetsConversation(db: Db, endpoint: EndpointRow, guid: string, conversationId: string | undefined): Promise<boolean> {
  const source = await db
    .select({ conversationId: chatMessageLinks.conversationId })
    .from(chatMessageLinks)
    .where(
      and(
        eq(chatMessageLinks.companyId, endpoint.companyId),
        eq(chatMessageLinks.endpointId, endpoint.id),
        eq(chatMessageLinks.providerMessageId, guid),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  return Boolean(source && source.conversationId === conversationId);
}

export function photonReplyMetadata(raw: unknown) {
  const reference = photonReplyReference(raw);
  return reference ? [
    { type: "key_value" as const, label: "Reply to message", value: reference.guid },
    ...(reference.part ? [{ type: "key_value" as const, label: "Reply part", value: reference.part }] : []),
  ] : [];
}

export async function recordPhotonInboundActivity(
  taskTx: DbOrTransaction,
  taskEndpoint: EndpointRow,
  issue: Pick<typeof issues.$inferSelect, "id" | "identifier">,
  commentId: string,
  taskUserId: string | null,
  inboundActivityPublications: ActivityPublication[],
): Promise<void> {
    await logActivity(
      taskTx as Db,
      {
        companyId: taskEndpoint.companyId,
        actorType: taskUserId ? "user" : "system",
        actorId: taskUserId ?? "chat:imessage-photon",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: commentId,
          issueIdentifier: issue.identifier,
          source: "chat:imessage-photon",
          endpointId: taskEndpoint.id,
        },
      },
      inboundActivityPublications,
    );
}

export async function photonConversationBindingIsComplete(
  conversationId: string,
  hasCommittedTaskControlCompletion: (conversationId: string) => Promise<boolean>,
): Promise<boolean> {
  // A reply finishes an iMessage turn, not the conversation. Only a
  // delivered /new or /close releases this chat's task binding. Use
  // the durable control receipt so pre-fix completed rows also resume.
  return await hasCommittedTaskControlCompletion(conversationId);
}
