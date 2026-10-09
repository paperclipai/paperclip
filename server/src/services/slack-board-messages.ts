import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  assets,
  issueAttachments,
  authUsers,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatPublications,
  companyMemberships,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import { slackBoardAuthor } from "./slack-board-authority.js";
import { forbidden } from "../errors.js";

type Executor = Pick<Db, "select" | "insert">;

/** Called only for an authenticated Board comment, in its insert transaction.
 * Provider ingress and agent-authored comments never enter this path. */
export async function mirrorSlackBoardComment(
  db: Executor,
  comment: {
    id: string;
    companyId: string;
    issueId: string;
    body: string;
    authorType?: string | null;
    authorUserId?: string | null;
    deletedAt?: unknown;
  },
  options: {
    publicationKey?: string;
    wakeAgent?: boolean;
    endpointId?: string;
    conversationId?: string;
    attachmentIds?: readonly string[];
  } = {},
) {
  if (
    comment.authorType !== "user" ||
    !comment.authorUserId ||
    comment.deletedAt
  )
    return;
  if (
    !options.wakeAgent &&
    !(await instanceSettingsService(db as Db).getExperimental())
      .enableChatConnectors
  )
    return;
  const bindings = await db
    .select({ conversation: chatConversations, endpoint: chatEndpoints })
    .from(chatConversations)
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.id, chatConversations.endpointId),
        eq(chatEndpoints.companyId, comment.companyId),
      ),
    )
    .innerJoin(
      issues,
      and(
        eq(issues.id, chatConversations.issueId),
        eq(issues.companyId, comment.companyId),
        eq(issues.assigneeAgentId, chatEndpoints.assignedAgentId),
      ),
    )
    .where(
      and(
        eq(chatConversations.companyId, comment.companyId),
        eq(chatConversations.issueId, comment.issueId),
        eq(chatEndpoints.provider, "slack"),
        ...(!options.wakeAgent
          ? [eq(chatEndpoints.publicationMode, "automatic")]
          : []),
        ...(options.endpointId
          ? [eq(chatEndpoints.id, options.endpointId)]
          : []),
        ...(options.conversationId
          ? [eq(chatConversations.id, options.conversationId)]
          : []),
        inArray(chatConversations.state, ["active", "waiting", "completed"]),
      ),
    );
  const [user] = await db
    .select({ name: authUsers.name })
    .from(authUsers)
    .where(eq(authUsers.id, comment.authorUserId));
  const author = (user?.name ?? comment.authorUserId)
    .replace(/[\r\n*_`<>\[\]()\\]/g, " ")
    .trim()
    .slice(0, 160);
  for (const { conversation, endpoint } of bindings) {
    const principal = await slackBoardAuthor(db, endpoint, comment.authorUserId);
    if (!principal) {
      throw forbidden("Link your Slack account to this connection before sending a message to its Slack thread");
    }
    const [receipt] = await db
      .insert(chatActions)
      .values({
        companyId: comment.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        kind: "slack_board_message",
        providerActionId: `board-comment:${comment.id}`,
        status: options.wakeAgent ? "received" : "processed",
        payload: {
          issueId: comment.issueId,
          commentId: comment.id,
          userId: comment.authorUserId,
          principalId: principal.id,
          agentId: endpoint.assignedAgentId,
        },
      })
      .onConflictDoNothing()
      .returning();
    if (!receipt) continue;
    const [publication] = await db
      .insert(chatPublications)
      .values({
        companyId: comment.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: comment.issueId,
        commentId: comment.id,
        idempotencyKey:
          options.publicationKey ??
          `board-comment:${comment.id}:${endpoint.id}`,
        payload: projectSafeChatPublication({
          classification: "external",
          source: "explicit_board_send",
          text: `**${author} (via Paperclip)**\n\n${comment.body}`,
        }),
        state: "pending",
      })
      .onConflictDoNothing()
      .returning();
    if (!publication)
      throw new Error("Slack Board publication identity already exists");
    const files = await db
      .select({ id: issueAttachments.id, name: assets.originalFilename })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .where(
        and(
          eq(issueAttachments.companyId, comment.companyId),
          eq(issueAttachments.issueId, comment.issueId),
          eq(issueAttachments.issueCommentId, comment.id),
        ),
      )
      .orderBy(asc(issueAttachments.createdAt), asc(issueAttachments.id));
    const byId = new Map(files.map((file) => [file.id, file]));
    const orderedFiles = options.attachmentIds
      ? options.attachmentIds.flatMap((id) =>
          byId.has(id) ? [byId.get(id)!] : [],
        )
      : files;
    for (const [index, file] of orderedFiles.entries())
      await db
        .insert(chatPublications)
        .values({
          companyId: comment.companyId,
          endpointId: endpoint.id,
          conversationId: conversation.id,
          issueId: comment.issueId,
          commentId: comment.id,
          idempotencyKey: `${options.publicationKey ?? `board-comment:${comment.id}:${endpoint.id}`}:attachment:${file.id}`,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "explicit_board_send",
            text: `Shared ${file.name ?? "a file"}.`,
            attachmentIds: [file.id],
          }),
          state: "pending",
          createdAt: new Date(Date.now() + index + 1),
        })
        .onConflictDoNothing();
    await logActivity(db as Db, {
      companyId: comment.companyId,
      actorType: "user",
      actorId: comment.authorUserId,
      action: "chat.publication_requested",
      entityType: "chat_publication",
      entityId: publication.id,
      issueId: comment.issueId,
      details: {
        endpointId: endpoint.id,
        conversationId: conversation.id,
        commentId: comment.id,
        source: "paperclip_comment",
      },
    });
  }
}

/** A durable mirror receipt, not task text or a context field, proves the return path. */
export async function slackBoardReplyBindings(
  db: Executor,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    commentIds: string[];
    userId: string | null;
  },
) {
  if (!input.commentIds.length || !input.userId) return [];
  const bindings = await db
    .select({
      companyId: chatActions.companyId,
      endpointId: chatActions.endpointId,
      conversationId: chatConversations.id,
      endpoint: chatEndpoints,
      principalId: sql<string>`${chatActions.payload}->>'principalId'`,
    })
    .from(chatActions)
    .innerJoin(
      issueComments,
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        sql`${issueComments.id}::text = ${chatActions.payload}->>'commentId'`,
      ),
    )
    .innerJoin(
      chatConversations,
      and(
        eq(chatConversations.id, chatActions.conversationId),
        eq(chatConversations.companyId, input.companyId),
        eq(chatConversations.issueId, input.issueId),
      ),
    )
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.id, chatActions.endpointId),
        eq(chatEndpoints.companyId, input.companyId),
        eq(chatEndpoints.provider, "slack"),
        eq(chatEndpoints.assignedAgentId, input.agentId),
      ),
    )
    .innerJoin(
      companyMemberships,
      and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .where(
      and(
        eq(chatActions.companyId, input.companyId),
        eq(chatActions.kind, "slack_board_message"),
        eq(sql<string>`${chatActions.payload}->>'userId'`, input.userId),
        eq(sql<string>`${chatActions.payload}->>'agentId'`, input.agentId),
        eq(issueComments.authorType, "user"),
        eq(issueComments.authorUserId, input.userId),
        isNull(issueComments.deletedAt),
        inArray(issueComments.id, input.commentIds),
        inArray(chatEndpoints.status, ["active", "verifying"]),
        inArray(chatConversations.state, ["active", "waiting", "completed"]),
      ),
    );
  const authorized = [];
  for (const { endpoint, principalId, ...binding } of bindings) {
    const principal = await slackBoardAuthor(db, endpoint, input.userId);
    if (principal && principal.id === principalId) authorized.push(binding);
  }
  return authorized;
}
