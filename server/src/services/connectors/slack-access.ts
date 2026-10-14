import { and, eq, sql } from "drizzle-orm";
import { chatActions, chatEndpointResources, type Db } from "@paperclipai/db";
import { HttpError, forbidden, unprocessable } from "../../errors.js";
import type { SlackTaskAuthority } from "./slack-authority.js";
import {
  nextCursor,
  object,
  type slackClient,
  type SlackObject,
} from "./slack-client.js";

type Api = ReturnType<typeof slackClient>;
export async function authorizeSlackChannel(
  authority: Pick<SlackTaskAuthority, "endpoint" | "slackUserId">,
  api: Api,
  channelId: string,
) {
  let channel: SlackObject;
  try {
    channel = object(
      (await api("conversations.info", { channel: channelId })).channel,
    );
  } catch (error) {
    // Membership can disappear between listing and inspection. Slack also
    // hides inaccessible conversations with channel_not_found. Treat only
    // these definite access failures as denials; outages must still surface.
    if (
      error instanceof HttpError &&
      error.status === 422 &&
      ["slack_channel_not_found", "slack_not_in_channel"].includes(
        String(object(error.details).code),
      )
    ) {
      throw forbidden("This Slack channel is no longer accessible to the bot");
    }
    throw error;
  }
  if (
    channel.id !== channelId ||
    (channel.is_member !== true && channel.is_im !== true)
  )
    throw forbidden("Invite this bot to the channel before reading it");
  const user = object(
    (await api("users.info", { user: authority.slackUserId })).user,
  );
  if (
    user.id !== authority.slackUserId ||
    user.deleted === true ||
    user.is_bot === true ||
    user.team_id !== authority.endpoint.providerAccountId
  )
    throw forbidden(
      "The linked Slack user is no longer an active workspace member",
    );
  if (channel.is_im === true) {
    if (channel.user !== authority.slackUserId)
      throw forbidden("Other people's bot DMs are not accessible");
    return channel;
  }
  // Public channels follow workspace rules. Guests and Slack Connect users need
  // explicit channel membership, as do all private conversations.
  if (
    channel.is_private === true ||
    channel.is_mpim === true ||
    channel.is_ext_shared === true ||
    user.is_restricted === true ||
    user.is_ultra_restricted === true
  ) {
    let cursor = "";
    let found = false;
    const seen = new Set<string>();
    do {
      const page = await api("conversations.members", {
        channel: channelId,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (
        Array.isArray(page.members) &&
        page.members.includes(authority.slackUserId)
      ) {
        found = true;
        break;
      }
      cursor = nextCursor(page);
      if (cursor && seen.has(cursor))
        throw unprocessable("Slack returned incomplete membership information");
      seen.add(cursor);
      if (seen.size >= 100 && cursor)
        throw forbidden(
          "Channel membership could not be verified within the lookup limit",
        );
    } while (cursor);
    if (!found)
      throw forbidden(
        "The linked user must belong to this private or restricted channel",
      );
  }
  return channel;
}

export async function authorizeSlackWrite(
  db: Db,
  authority: SlackTaskAuthority,
  api: Api,
  channelId: string,
) {
  const channel = await authorizeSlackChannel(authority, api, channelId);
  if (channel.is_archived === true)
    throw forbidden("This Slack channel is archived");
  if (channel.is_im === true) {
    if (!authority.endpoint.allowDirectMessages)
      throw forbidden("Direct messages are disabled");
  } else {
    const [resource] = await db
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.companyId, authority.endpoint.companyId),
          eq(chatEndpointResources.endpointId, authority.endpoint.id),
          eq(chatEndpointResources.providerResourceId, channelId),
          eq(chatEndpointResources.availability, "available"),
          eq(chatEndpointResources.enabled, true),
        ),
      );
    if (!resource)
      throw forbidden(
        "Responses are disabled in this channel. Enable it in connection Settings first.",
      );
  }
  if (
    !(await slackPublicationAllowed(
      db,
      authority.endpoint.companyId,
      authority.endpoint.id,
      authority.issueId,
      channelId,
      channel.is_im === true ? authority.slackUserId : null,
    ))
  )
    throw forbidden(
      "Private research may only be delivered in its source channel or a DM with the requester",
    );
  return channel;
}

/** Persist only source identity, never retrieved message text. Commit before returning private data. */
export async function recordSlackReadBoundary(
  db: Db,
  authority: SlackTaskAuthority,
  channel: SlackObject,
) {
  if (
    channel.is_private !== true &&
    channel.is_im !== true &&
    channel.is_mpim !== true
  )
    return;
  if (
    authority.conversation &&
    !authority.conversation.isDirectMessage &&
    channel.id !==
      authority.conversation.externalConversationId.replace(/^slack:/, "")
  )
    throw forbidden(
      "Ask for cross-channel private research in a DM with the bot",
    );
  await db
    .insert(chatActions)
    .values({
      companyId: authority.endpoint.companyId,
      endpointId: authority.endpoint.id,
      conversationId: authority.conversation?.id ?? null,
      principalId: authority.principalId,
      kind: "slack_private_source",
      status: "processed",
      providerActionId: `slack-private:${authority.issueId}:${channel.id}:${authority.slackUserId}`,
      payload: {
        issueId: authority.issueId,
        channelId: channel.id,
        requesterId: authority.slackUserId,
        allowedDmChannel: authority.conversation?.isDirectMessage
          ? authority.conversation.externalConversationId.replace(/^slack:/, "")
          : null,
      },
    })
    .onConflictDoNothing();
}
export async function slackPublicationAllowed(
  db: Pick<Db, "select">,
  companyId: string,
  endpointId: string,
  issueId: string,
  channelId: string,
  directRecipient: string | null,
) {
  channelId = channelId.replace(/^slack:/, "");
  const sources = await db
    .select({ payload: chatActions.payload })
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, companyId),
        eq(chatActions.endpointId, endpointId),
        eq(chatActions.kind, "slack_private_source"),
        sql`${chatActions.payload}->>'issueId' = ${issueId}`,
      ),
    );
  return sources.every(
    ({ payload }) =>
      payload.channelId === channelId ||
      payload.allowedDmChannel === channelId ||
      (directRecipient !== null && directRecipient === payload.requesterId),
  );
}

/** Initial messages in a private channel are already model context, even before
 * the first history call. Their publication boundary must cover tool writes. */
export async function recordSlackOriginBoundary(
  db: Db,
  authority: SlackTaskAuthority,
  api: Api,
) {
  if (!authority.conversation || authority.conversation.isDirectMessage) return;
  const origin = await authorizeSlackChannel(
    authority,
    api,
    authority.conversation.externalConversationId.replace(/^slack:/, ""),
  );
  await recordSlackReadBoundary(db, authority, origin);
}
