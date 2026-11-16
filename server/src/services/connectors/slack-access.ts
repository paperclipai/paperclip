import { and, eq } from "drizzle-orm";
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
export type SlackChannelAuthorizationOptions = {
  /** Proactive DMs is enabled: a DM with another active workspace member may be read and written. */
  allowOtherUserDm?: boolean;
};

/** An active, full member of the bot's own workspace: not deleted, not a bot, not a guest, not from another team. */
async function assertActiveWorkspaceMember(
  authority: Pick<SlackTaskAuthority, "endpoint">,
  api: Api,
  userId: string,
) {
  const other = object((await api("users.info", { user: userId })).user);
  if (
    other.id !== userId ||
    other.deleted === true ||
    other.is_bot === true ||
    other.is_restricted === true ||
    other.is_ultra_restricted === true ||
    other.team_id !== authority.endpoint.providerAccountId
  )
    throw forbidden("That Slack user is not an active member of this workspace");
}

export async function authorizeSlackChannel(
  authority: Pick<SlackTaskAuthority, "endpoint" | "slackUserId">,
  api: Api,
  channelId: string,
  options: SlackChannelAuthorizationOptions = {},
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
    if (channel.user !== authority.slackUserId) {
      if (options.allowOtherUserDm !== true || typeof channel.user !== "string")
        throw forbidden("Other people's bot DMs are not accessible");
      await assertActiveWorkspaceMember(authority, api, channel.user);
    }
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
  options: SlackChannelAuthorizationOptions = {},
) {
  const channel = await authorizeSlackChannel(authority, api, channelId, options);
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
  return channel;
}

/**
 * Audit record of private channel content access.
 *
 * Audit-only, not publication enforcement. Bot membership/access plus existing
 * write permissions define allowed sharing. Preserves existing chat_actions
 * audit records without schema or data migration.
 */
export async function recordSlackPrivateRead(
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
