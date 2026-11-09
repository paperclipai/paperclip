import { chatConversations, issues, type Db } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import type { EndpointRow } from "../runtime-types.js";

type ConversationRow = typeof chatConversations.$inferSelect;

type ConversationBindingInput = {
  endpoint: Pick<EndpointRow, "id" | "companyId">;
  thread: { id: string; channelId: string };
  isLinear: () => boolean;
  lookupConversation?: () => Promise<ConversationRow | null>;
  conversationIsComplete?: (conversationId: string) => Promise<boolean>;
};

export async function resolveInboundConversationBinding(
  db: Db,
  input: ConversationBindingInput,
) {
  const { endpoint, thread, lookupConversation, conversationIsComplete } = input;
  const latestConversation =
    lookupConversation
      ? await lookupConversation()
      : await db
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.endpointId, endpoint.id),
              eq(
                chatConversations.externalConversationId,
                thread.channelId,
              ),
              eq(chatConversations.externalThreadId, thread.id),
            ),
          )
          .orderBy(desc(chatConversations.sessionGeneration))
          .then((rows) => rows[0] ?? null);
  const isLinear = input.isLinear();
  let existingConversation: ConversationRow | null = latestConversation;
  let existingIssue: typeof issues.$inferSelect | null =
    existingConversation
      ? await db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, endpoint.companyId),
              eq(issues.id, existingConversation.issueId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
  if (
    isLinear &&
    existingConversation &&
    (conversationIsComplete
      ? await conversationIsComplete(existingConversation.id)
      : existingConversation.state === "completed" ||
        existingIssue?.status === "done" ||
        existingIssue?.status === "cancelled")
  ) {
    if (existingConversation.state !== "completed") {
      await db
        .update(chatConversations)
        .set({ state: "completed", updatedAt: new Date() })
        .where(eq(chatConversations.id, existingConversation.id));
    }
    existingConversation = null;
    existingIssue = null;
  }
  return { conversation: existingConversation, issue: existingIssue, latestConversation, isLinear };
}
