import { and, eq, like } from "drizzle-orm";
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
  /** Outbound DMs: a DM with another active workspace member may be read and written (outbound DMs are standard, no Proactive DMs group exists). */
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
  // A task that read personal DMs may only answer in the DM with the person whose DMs were read.
  await assertPersonalDmWriteAllowed(db, authority, channel);
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

const PERSONAL_DM_SOURCE_PREFIX = "slack-private-dm:";

export const SLACK_PERSONAL_DM_PRIVACY = "slack_personal_dm_private";
export const personalDmPrivacy = () =>
  forbidden(
    "This task read your direct messages, so Slack output stays in your own DM with the bot.",
    { code: SLACK_PERSONAL_DM_PRIVACY },
  );

/**
 * Whether a task may read the requester's own DMs with their personal token at all. A reply that goes to a
 * channel conversation would reach that whole audience, so only tasks started from a direct message or from
 * Paperclip (no Slack conversation) qualify.
 */
export const personalDmReadsAllowed = (authority: Pick<SlackTaskAuthority, "conversation">) =>
  !authority.conversation || authority.conversation.isDirectMessage === true;

/** Records that this task read the requester's own DMs or group DMs with their personal token. */
export async function recordSlackPersonalDmRead(
  db: Db,
  authority: SlackTaskAuthority,
  channel: SlackObject,
) {
  await db
    .insert(chatActions)
    .values({
      companyId: authority.endpoint.companyId,
      endpointId: authority.endpoint.id,
      conversationId: authority.conversation?.id ?? null,
      principalId: authority.principalId,
      kind: "slack_private_source",
      status: "processed",
      providerActionId: `${PERSONAL_DM_SOURCE_PREFIX}${authority.issueId}:${channel.id}:${authority.slackUserId}`,
      payload: {
        issueId: authority.issueId,
        channelId: channel.id,
        requesterId: authority.slackUserId,
        source: "personal_dm",
      },
    })
    .onConflictDoNothing();
}

/**
 * Slack user ids whose DMs this task has read with their personal token. Looked up across every Slack
 * connection in the company, not just the current one: a task can use more than one connection, and
 * reading through one must not open writes through another.
 */
export async function personalDmReaders(
  db: Db,
  authority: Pick<SlackTaskAuthority, "endpoint" | "issueId">,
): Promise<string[]> {
  const prefix = `${PERSONAL_DM_SOURCE_PREFIX}${authority.issueId}:`;
  const rows = await db
    .select({ providerActionId: chatActions.providerActionId })
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, authority.endpoint.companyId),
        eq(chatActions.kind, "slack_private_source"),
        like(chatActions.providerActionId, `${prefix}%`),
      ),
    );
  return [
    ...new Set(
      rows
        .map((row) => String(row.providerActionId ?? ""))
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(id.lastIndexOf(":") + 1)),
    ),
  ];
}

/** True once this task has read personal DMs. */
export const taskReadPersonalDms = async (
  db: Db,
  authority: Pick<SlackTaskAuthority, "endpoint" | "issueId">,
) => (await personalDmReaders(db, authority)).length > 0;

/**
 * After a task read personal DMs, Slack output may only go to the DM between the bot and the person whose
 * DMs were read. Called for every channel write.
 */
export async function assertPersonalDmWriteAllowed(
  db: Db,
  authority: Pick<SlackTaskAuthority, "endpoint" | "issueId">,
  channel: SlackObject,
) {
  const readers = await personalDmReaders(db, authority);
  if (
    readers.length > 0 &&
    !(channel.is_im === true && readers.every((reader) => reader === channel.user))
  )
    throw personalDmPrivacy();
}

/** The same rule for writes that name no channel: no DM with anyone else, and no new channels. */
export async function assertPersonalDmToolAllowed(
  db: Db,
  authority: Pick<SlackTaskAuthority, "endpoint" | "issueId" | "slackUserId">,
  name: string,
  args: Record<string, unknown>,
) {
  const outbound =
    name === "slack_create_channel" ||
    (name === "slack_open_dm" && typeof args.user === "string" && args.user !== authority.slackUserId);
  if (outbound && (await taskReadPersonalDms(db, authority))) throw personalDmPrivacy();
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
