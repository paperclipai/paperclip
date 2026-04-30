import { z } from "zod";
import { TeamsClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>, client: TeamsClient) => Promise<unknown>,
  client: TeamsClient,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed, client));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

const topOpt = z.number().int().min(1).max(50).default(20).describe("Max messages to return (1–50, default 20)");
const contentTypeOpt = z.enum(["text", "html"]).default("text").describe("Content type: 'text' or 'html'");

export function createToolDefinitions(client: TeamsClient): ToolDefinition[] {
  return [
    // ── List teams ────────────────────────────────────────────────────────────
    makeTool(
      "teams_list_teams",
      "List all Microsoft Teams teams accessible to the service account.",
      z.object({}),
      async () => client.listTeams(),
      client,
    ),

    // ── Get team ──────────────────────────────────────────────────────────────
    makeTool(
      "teams_get_team",
      "Get details of a specific team by ID.",
      z.object({
        teamId: z.string().describe("Team ID"),
      }),
      async ({ teamId }) => client.getTeam(teamId),
      client,
    ),

    // ── List channels ─────────────────────────────────────────────────────────
    makeTool(
      "teams_list_channels",
      "List all channels in a team.",
      z.object({
        teamId: z.string().describe("Team ID"),
      }),
      async ({ teamId }) => client.listChannels(teamId),
      client,
    ),

    // ── Get channel ───────────────────────────────────────────────────────────
    makeTool(
      "teams_get_channel",
      "Get details of a specific channel.",
      z.object({
        teamId: z.string().describe("Team ID"),
        channelId: z.string().describe("Channel ID"),
      }),
      async ({ teamId, channelId }) => client.getChannel(teamId, channelId),
      client,
    ),

    // ── List channel messages ──────────────────────────────────────────────────
    makeTool(
      "teams_list_channel_messages",
      "List recent messages in a Teams channel.",
      z.object({
        teamId: z.string().describe("Team ID"),
        channelId: z.string().describe("Channel ID"),
        top: topOpt,
      }),
      async ({ teamId, channelId, top }) => client.listChannelMessages(teamId, channelId, top),
      client,
    ),

    // ── Send channel message ──────────────────────────────────────────────────
    makeTool(
      "teams_send_channel_message",
      "Send a message to a Teams channel via the bot. Supports @mentions. Returns the created message ID.",
      z.object({
        teamId: z.string().describe("Team ID"),
        channelId: z.string().describe("Channel ID"),
        content: z.string().describe("Message body. Include <at>DisplayName</at> tags where mentions should appear, or omit and let mentions be auto-prepended."),
        contentType: contentTypeOpt,
        subject: z.string().optional().describe("Optional message subject / card title"),
        mentions: z.array(z.object({
          userId: z.string().describe("AAD user object ID to @mention"),
          displayName: z.string().describe("Display name shown in the @mention tag"),
        })).optional().describe("Users to @mention in the message"),
      }),
      async ({ teamId, channelId, content, contentType, subject, mentions }) =>
        client.sendChannelMessage(teamId, channelId, content, contentType, subject, mentions),
      client,
    ),

    // ── Reply to channel message ───────────────────────────────────────────────
    makeTool(
      "teams_reply_to_message",
      "Reply to an existing message thread in a Teams channel via the bot. Supports @mentions.",
      z.object({
        teamId: z.string().describe("Team ID"),
        channelId: z.string().describe("Channel ID"),
        messageId: z.string().describe("ID of the parent message to reply to"),
        content: z.string().describe("Reply body"),
        contentType: contentTypeOpt,
        mentions: z.array(z.object({
          userId: z.string().describe("AAD user object ID to @mention"),
          displayName: z.string().describe("Display name shown in the @mention tag"),
        })).optional().describe("Users to @mention in the reply"),
      }),
      async ({ teamId, channelId, messageId, content, contentType, mentions }) =>
        client.replyToChannelMessage(teamId, channelId, messageId, content, contentType, mentions),
      client,
    ),

    // ── List message replies ───────────────────────────────────────────────────
    makeTool(
      "teams_list_message_replies",
      "List all replies in a message thread in a Teams channel.",
      z.object({
        teamId: z.string().describe("Team ID"),
        channelId: z.string().describe("Channel ID"),
        messageId: z.string().describe("Parent message ID"),
      }),
      async ({ teamId, channelId, messageId }) =>
        client.listMessageReplies(teamId, channelId, messageId),
      client,
    ),

    // ── List chats ────────────────────────────────────────────────────────────
    makeTool(
      "teams_list_chats",
      "List 1:1 and group chats for a user (by their AAD user ID or UPN).",
      z.object({
        userId: z.string().describe("AAD user ID or UPN, e.g. 'user@domain.com'"),
        top: topOpt,
      }),
      async ({ userId, top }) => client.listChats(userId, top),
      client,
    ),

    // ── List chat messages ────────────────────────────────────────────────────
    makeTool(
      "teams_list_chat_messages",
      "List recent messages in a 1:1 or group chat.",
      z.object({
        chatId: z.string().describe("Chat ID from teams_list_chats"),
        top: topOpt,
      }),
      async ({ chatId, top }) => client.listChatMessages(chatId, top),
      client,
    ),

    // ── Send chat message ─────────────────────────────────────────────────────
    makeTool(
      "teams_send_chat_message",
      "Send a message in a 1:1 or group chat.",
      z.object({
        chatId: z.string().describe("Chat ID from teams_list_chats"),
        content: z.string().describe("Message body"),
        contentType: contentTypeOpt,
      }),
      async ({ chatId, content, contentType }) =>
        client.sendChatMessage(chatId, content, contentType),
      client,
    ),

    // ── Send activity notification ─────────────────────────────────────────────
    makeTool(
      "teams_send_activity_notification",
      "Send an in-app activity feed notification to a user in Teams. Useful for alerting a user about an agent action without posting to a channel.",
      z.object({
        userId: z.string().describe("AAD user ID or UPN to notify"),
        topic: z.string().describe("Notification topic / title"),
        activityType: z.string().describe("Activity type registered in the Teams app manifest (e.g. 'taskCreated')"),
        previewText: z.string().describe("Short preview text shown in the notification"),
        teamId: z.string().optional().describe("Team ID if linking to a channel message"),
        channelId: z.string().optional().describe("Channel ID if linking to a channel message"),
        messageId: z.string().optional().describe("Message ID if linking to a specific message"),
      }),
      async ({ userId, topic, activityType, previewText, teamId, channelId, messageId }) =>
        client.sendActivityNotification(userId, topic, activityType, previewText, teamId, channelId, messageId),
      client,
    ),

    // ── Search messages ────────────────────────────────────────────────────────
    makeTool(
      "teams_search_messages",
      "Search across all Teams messages accessible to the service account by keyword.",
      z.object({
        query: z.string().describe("Search query string"),
      }),
      async ({ query }) => client.searchMessages(query),
      client,
    ),
  ];
}
