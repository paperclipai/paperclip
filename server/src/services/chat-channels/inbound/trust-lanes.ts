import { chatConversations, chatDeliveries, chatMessageLinks, issues } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { DbOrTransaction, EndpointRow } from "../runtime-types.js";

type ConversationRow = typeof chatConversations.$inferSelect;
type LaneIssue = Pick<typeof issues.$inferSelect, "sourceTrust">;

export type ChatTrustLane = "guest" | "verified";

export const TRUST_LANE_AUDIENCE_MAX_PRINCIPALS = 25;
export const TRUST_LANE_THREAD_ROWS_MAX = 50;
export const TRUST_LANE_AUDIENCE_NOTICE =
  "I can't run this request in this thread because it includes participants who aren't linked to a Paperclip account, and my replies would be visible to them. Start a new thread or send a direct message to continue.";

export function chatTrustLaneOfIssue(issue: LaneIssue): ChatTrustLane {
  return issue.sourceTrust?.preset === LOW_TRUST_REVIEW_PRESET ? "guest" : "verified";
}

export function invokerLaneRow<Row extends { issue: LaneIssue }>(
  rowsNewestFirst: Row[],
  invokerVerified: boolean,
): Row | null {
  const own = rowsNewestFirst.find(
    (row) => (chatTrustLaneOfIssue(row.issue) === "verified") === invokerVerified,
  );
  return own ?? (invokerVerified ? (rowsNewestFirst[0] ?? null) : null);
}

type LaneSelection =
  | { kind: "reuse"; conversation: ConversationRow }
  | { kind: "create"; sessionGeneration: number }
  | { kind: "refused" };

type LaneSelectionInput = {
  endpoint: EndpointRow;
  thread: { id: string; channelId: string };
  principalId: string;
  verifiedUserId: string | null;
};

type PrincipalAuthorization = (
  tx: DbOrTransaction,
  endpoint: EndpointRow,
  principalId: string,
) => Promise<{ allowed: boolean; userId: string | null }>;

export async function selectChatTrustLane(
  tx: DbOrTransaction,
  input: LaneSelectionInput,
  lockThreadParticipantAuthorization: PrincipalAuthorization,
): Promise<LaneSelection> {
  const lane: ChatTrustLane = input.verifiedUserId ? "verified" : "guest";
  const rows = await tx
    .select({ conversation: chatConversations, issue: { sourceTrust: issues.sourceTrust } })
    .from(chatConversations)
    .innerJoin(
      issues,
      and(eq(issues.companyId, chatConversations.companyId), eq(issues.id, chatConversations.issueId)),
    )
    .where(
      and(
        eq(chatConversations.companyId, input.endpoint.companyId),
        eq(chatConversations.endpointId, input.endpoint.id),
        eq(chatConversations.externalConversationId, input.thread.channelId),
        eq(chatConversations.externalThreadId, input.thread.id),
      ),
    )
    .orderBy(desc(chatConversations.sessionGeneration));
  if (lane === "verified" && rows.some((row) => chatTrustLaneOfIssue(row.issue) === "guest")) {
    const others = await tx
      .selectDistinct({ principalId: chatDeliveries.principalId })
      .from(chatMessageLinks)
      .innerJoin(
        chatDeliveries,
        and(eq(chatDeliveries.companyId, chatMessageLinks.companyId), eq(chatDeliveries.id, chatMessageLinks.deliveryId)),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, input.endpoint.companyId),
          eq(chatMessageLinks.endpointId, input.endpoint.id),
          inArray(chatMessageLinks.conversationId, rows.map((row) => row.conversation.id)),
          eq(chatMessageLinks.direction, "inbound"),
          isNotNull(chatDeliveries.principalId),
          ne(chatDeliveries.principalId, input.principalId),
        ),
      )
      .orderBy(asc(chatDeliveries.principalId))
      .limit(TRUST_LANE_AUDIENCE_MAX_PRINCIPALS + 1);
    if (others.length > TRUST_LANE_AUDIENCE_MAX_PRINCIPALS) return { kind: "refused" };
    for (const other of others) {
      const authorization = await lockThreadParticipantAuthorization(tx, input.endpoint, other.principalId!);
      if (!authorization.allowed || authorization.userId === null) return { kind: "refused" };
    }
  }
  const sameLane = rows.find((row) => chatTrustLaneOfIssue(row.issue) === lane);
  if (sameLane && (lane === "guest" || ["active", "waiting"].includes(sameLane.conversation.state))) {
    return { kind: "reuse", conversation: sameLane.conversation };
  }
  return { kind: "create", sessionGeneration: (rows[0]?.conversation.sessionGeneration ?? 0) + 1 };
}
