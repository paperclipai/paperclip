/**
 * Shared tool declarations for the Slack plugin.
 *
 * These declarations are consumed in two places:
 *   1. `manifest.ts` — exposes them as `manifest.tools[]` so the host-side
 *      `PluginToolRegistry` registers them and routes calls back to the worker.
 *   2. `worker.ts` — passed verbatim into `ctx.tools.register(name, decl, fn)`
 *      so the worker binds the runtime handlers to the same declaration shape
 *      the host advertised.
 *
 * Centralising the declarations here keeps the manifest and runtime registrations
 * in lockstep (the manifest must mirror runtime). When adding or modifying a
 * tool, edit it here only.
 */
import type { PluginToolDeclaration } from "@paperclipai/plugin-sdk";

export const ESCALATE_TO_HUMAN_DECLARATION: PluginToolDeclaration = {
  name: "escalate_to_human",
  displayName: "Escalate to Human",
  description:
    "Escalates the current conversation to a human operator via the configured Slack escalation channel.",
  parametersSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why the agent is escalating",
      },
      confidence: {
        type: "number",
        description: "Agent confidence score (0-1)",
      },
      agentName: {
        type: "string",
        description: "Name of the escalating agent",
      },
      conversationHistory: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string" },
            text: { type: "string" },
          },
        },
        description: "Last N messages of conversation context",
      },
      agentReasoning: {
        type: "string",
        description: "Agent's reasoning for the escalation",
      },
      suggestedReply: {
        type: "string",
        description: "Agent's suggested reply for the human to use",
      },
    },
    required: ["reason"],
  },
};

export const HANDOFF_TO_AGENT_DECLARATION: PluginToolDeclaration = {
  name: "handoff_to_agent",
  displayName: "Handoff to Agent",
  description:
    "Requests a handoff from one agent to another in the same Slack thread. Posts an approval prompt with Approve/Reject buttons.",
  parametersSchema: {
    type: "object",
    properties: {
      fromAgent: {
        type: "string",
        description: "Name of the agent initiating the handoff",
      },
      toAgent: {
        type: "string",
        description: "Name of the target agent to hand off to",
      },
      reason: {
        type: "string",
        description: "Why the handoff is needed",
      },
      context: {
        type: "string",
        description: "Context to pass to the target agent on approval",
      },
      channelId: { type: "string", description: "Slack channel ID" },
      threadTs: {
        type: "string",
        description: "Slack thread timestamp",
      },
    },
    required: ["fromAgent", "toAgent", "reason", "channelId", "threadTs"],
  },
};

export const DISCUSS_WITH_AGENT_DECLARATION: PluginToolDeclaration = {
  name: "discuss_with_agent",
  displayName: "Discuss with Agent",
  description:
    "Starts a conversation loop between two agents in a Slack thread with human checkpoints every 5 turns.",
  parametersSchema: {
    type: "object",
    properties: {
      initiatorAgent: {
        type: "string",
        description: "Name of the agent starting the discussion",
      },
      targetAgent: {
        type: "string",
        description: "Name of the other agent",
      },
      topic: {
        type: "string",
        description: "The topic or question to discuss",
      },
      maxTurns: {
        type: "number",
        description: "Maximum number of turns (default 10)",
      },
      channelId: { type: "string", description: "Slack channel ID" },
      threadTs: {
        type: "string",
        description: "Slack thread timestamp",
      },
    },
    required: [
      "initiatorAgent",
      "targetAgent",
      "topic",
      "channelId",
      "threadTs",
    ],
  },
};

export const PROCESS_MEDIA_DECLARATION: PluginToolDeclaration = {
  name: "process_media",
  displayName: "Process Media",
  description:
    "Processes a media file (audio/video) from Slack - transcribes audio and optionally generates a brief.",
  parametersSchema: {
    type: "object",
    properties: {
      fileId: { type: "string", description: "Slack file ID to process" },
      channelId: {
        type: "string",
        description: "Channel to post results to",
      },
      threadTs: {
        type: "string",
        description: "Thread to post results in",
      },
      briefAgentId: {
        type: "string",
        description:
          "Optional agent ID to generate a brief from the transcription",
      },
    },
    required: ["fileId", "channelId", "threadTs"],
  },
};

export const REGISTER_COMMAND_DECLARATION: PluginToolDeclaration = {
  name: "register_command",
  displayName: "Register Custom Command",
  description:
    "Registers a custom !command that can be triggered from Slack messages. Commands can have workflow steps like invoking agents, posting messages, or creating issues.",
  parametersSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Command name (without ! prefix)",
      },
      description: {
        type: "string",
        description: "What the command does",
      },
      usage: {
        type: "string",
        description: "Usage example (e.g. '!deploy staging')",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "invoke_agent",
                "post_message",
                "create_issue",
                "wait_approval",
              ],
            },
            agentId: { type: "string" },
            prompt: { type: "string" },
            message: { type: "string" },
            issueTitle: { type: "string" },
            issueDescription: { type: "string" },
            timeout: { type: "number" },
          },
          required: ["type"],
        },
        description: "Workflow steps to execute",
      },
    },
    required: ["name", "description", "usage", "steps"],
  },
};

export const REGISTER_WATCH_DECLARATION: PluginToolDeclaration = {
  name: "register_watch",
  displayName: "Register Event Watch",
  description:
    "Registers a watch that triggers an agent when a matching event occurs. The agent will be invoked with a prompt interpolated with event data.",
  parametersSchema: {
    type: "object",
    properties: {
      eventPattern: {
        type: "string",
        description:
          "Event pattern to watch (e.g. 'issue.created', 'agent.run.*')",
      },
      agentId: {
        type: "string",
        description: "Agent to invoke when triggered",
      },
      prompt: {
        type: "string",
        description:
          "Prompt template (use ${event.payload.key} for interpolation)",
      },
      channelId: {
        type: "string",
        description: "Slack channel to post results to",
      },
      threadTs: {
        type: "string",
        description: "Optional thread to post results in",
      },
    },
    required: ["eventPattern", "agentId", "prompt", "channelId"],
  },
};

export const REMOVE_WATCH_DECLARATION: PluginToolDeclaration = {
  name: "remove_watch",
  displayName: "Remove Event Watch",
  description: "Removes a registered event watch by ID.",
  parametersSchema: {
    type: "object",
    properties: {
      watchId: { type: "string", description: "Watch ID to remove" },
    },
    required: ["watchId"],
  },
};

export const LIST_WATCH_TEMPLATES_DECLARATION: PluginToolDeclaration = {
  name: "list_watch_templates",
  displayName: "List Watch Templates",
  description:
    "Lists built-in watch templates for common use cases like sales follow-ups, deal monitoring, and error diagnosis.",
  parametersSchema: {
    type: "object",
    properties: {},
  },
};

// ===========================================================================
// Slack-API tool declarations (Task 9): direct, agent-callable Slack calls.
// Each one wraps a single Slack Web API method via slack-api.ts helpers.
// ===========================================================================

export const SLACK_POST_MESSAGE_DECLARATION: PluginToolDeclaration = {
  name: "slack_post_message",
  displayName: "Post Slack message",
  description:
    "Post a message to a Slack channel. Use the channel ID (e.g. C01ABC2DEF3), not the channel name.",
  parametersSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Slack channel ID (e.g. C01ABC2DEF3)",
      },
      text: { type: "string", description: "Message text" },
      blocks: {
        type: "array",
        description: "Optional Slack Block Kit blocks",
        items: { type: "object" },
      },
      thread_ts: {
        type: "string",
        description: "Optional thread timestamp to reply in-thread",
      },
    },
    required: ["channel", "text"],
  },
};

export const SLACK_UPDATE_MESSAGE_DECLARATION: PluginToolDeclaration = {
  name: "slack_update_message",
  displayName: "Update Slack message",
  description:
    "Edit a previously-posted Slack message. Requires the channel ID and the message ts (timestamp returned by post).",
  parametersSchema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Slack channel ID" },
      ts: {
        type: "string",
        description: "Timestamp of the message to edit",
      },
      text: { type: "string", description: "New message text" },
      blocks: {
        type: "array",
        description: "Optional Slack Block Kit blocks",
        items: { type: "object" },
      },
    },
    required: ["channel", "ts", "text"],
  },
};

export const SLACK_REACT_DECLARATION: PluginToolDeclaration = {
  name: "slack_react",
  displayName: "React to Slack message",
  description:
    "Add an emoji reaction to a Slack message. Use the emoji name without colons (e.g. 'thumbsup', not ':thumbsup:').",
  parametersSchema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Slack channel ID" },
      timestamp: {
        type: "string",
        description: "Timestamp of the message to react to",
      },
      name: {
        type: "string",
        description: "Emoji name without colons (e.g. 'thumbsup')",
      },
    },
    required: ["channel", "timestamp", "name"],
  },
};

export const SLACK_SEND_DM_DECLARATION: PluginToolDeclaration = {
  name: "slack_send_dm",
  displayName: "Send Slack DM",
  description:
    "Send a direct message to a user. Pass the user ID (U…) or the user's email. The bot must have im:write scope.",
  parametersSchema: {
    type: "object",
    properties: {
      user: {
        type: "string",
        description: "Slack user ID (U…) or email address",
      },
      text: { type: "string", description: "Message text" },
      blocks: {
        type: "array",
        description: "Optional Slack Block Kit blocks",
        items: { type: "object" },
      },
    },
    required: ["user", "text"],
  },
};

export const SLACK_LIST_CHANNELS_DECLARATION: PluginToolDeclaration = {
  name: "slack_list_channels",
  displayName: "List Slack channels",
  description:
    "List public channels the bot can see. Use to find a channel ID by name. Optional name_filter does case-insensitive substring match client-side.",
  parametersSchema: {
    type: "object",
    properties: {
      types: {
        type: "string",
        description:
          "Comma-separated channel types (e.g. 'public_channel,private_channel')",
      },
      name_filter: {
        type: "string",
        description: "Optional case-insensitive substring filter",
      },
      cursor: { type: "string", description: "Pagination cursor" },
      limit: {
        type: "number",
        description: "Max channels to return per page",
      },
    },
  },
};

export const SLACK_JOIN_CHANNEL_DECLARATION: PluginToolDeclaration = {
  name: "slack_join_channel",
  displayName: "Join Slack channel",
  description:
    "Make the bot join a public channel. Requires channels:join scope.",
  parametersSchema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Slack channel ID" },
    },
    required: ["channel"],
  },
};

export const SLACK_LIST_USERS_DECLARATION: PluginToolDeclaration = {
  name: "slack_list_users",
  displayName: "List Slack users",
  description:
    "List active members of the workspace. Filters out bots and deleted users from the response.",
  parametersSchema: {
    type: "object",
    properties: {
      cursor: { type: "string", description: "Pagination cursor" },
      limit: {
        type: "number",
        description: "Max users to return per page",
      },
    },
  },
};

export const SLACK_GET_USER_INFO_DECLARATION: PluginToolDeclaration = {
  name: "slack_get_user_info",
  displayName: "Get Slack user info",
  description:
    "Look up a user by ID or by email. Returns id, name, real_name, email, is_bot.",
  parametersSchema: {
    type: "object",
    properties: {
      user: {
        type: "string",
        description: "Slack user ID (U…) or email address",
      },
    },
    required: ["user"],
  },
};

export const SLACK_GET_THREAD_REPLIES_DECLARATION: PluginToolDeclaration = {
  name: "slack_get_thread_replies",
  displayName: "Get Slack thread replies",
  description:
    "Read replies to a thread. Returns the parent + all replies. Use to summarize a discussion.",
  parametersSchema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Slack channel ID" },
      thread_ts: {
        type: "string",
        description: "Parent message timestamp",
      },
      cursor: { type: "string", description: "Pagination cursor" },
      limit: {
        type: "number",
        description: "Max messages to return per page",
      },
    },
    required: ["channel", "thread_ts"],
  },
};

export const SLACK_SEARCH_MESSAGES_DECLARATION: PluginToolDeclaration = {
  name: "slack_search_messages",
  displayName: "Search Slack messages",
  description:
    "Search messages across the workspace. Requires a Slack user token (xoxp-) configured as slackUserTokenRef in plugin settings — bot tokens cannot use search.",
  parametersSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      count: { type: "number", description: "Max results" },
      sort: {
        type: "string",
        enum: ["score", "timestamp"],
        description: "Sort order",
      },
    },
    required: ["query"],
  },
};

export const SLACK_UPLOAD_FILE_DECLARATION: PluginToolDeclaration = {
  name: "slack_upload_file",
  displayName: "Upload Slack file",
  description:
    "Upload a file (binary) to a Slack channel. Provide either base64 content or a source URL.",
  parametersSchema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Slack channel ID" },
      filename: {
        type: "string",
        description: "Filename including extension",
      },
      content_base64: {
        type: "string",
        description: "Base64-encoded file contents (alternative to source_url)",
      },
      source_url: {
        type: "string",
        description: "URL to fetch file from (alternative to content_base64)",
      },
      title: { type: "string", description: "Optional file title" },
    },
    required: ["channel", "filename"],
  },
};

/**
 * Ordered list mirroring the order of `ctx.tools.register(...)` calls in
 * `worker.ts`. Used by `manifest.ts` for the `tools[]` field.
 */
export const TOOL_DECLARATIONS: readonly PluginToolDeclaration[] = [
  ESCALATE_TO_HUMAN_DECLARATION,
  HANDOFF_TO_AGENT_DECLARATION,
  DISCUSS_WITH_AGENT_DECLARATION,
  PROCESS_MEDIA_DECLARATION,
  REGISTER_COMMAND_DECLARATION,
  REGISTER_WATCH_DECLARATION,
  REMOVE_WATCH_DECLARATION,
  LIST_WATCH_TEMPLATES_DECLARATION,
  SLACK_POST_MESSAGE_DECLARATION,
  SLACK_UPDATE_MESSAGE_DECLARATION,
  SLACK_REACT_DECLARATION,
  SLACK_SEND_DM_DECLARATION,
  SLACK_LIST_CHANNELS_DECLARATION,
  SLACK_JOIN_CHANNEL_DECLARATION,
  SLACK_LIST_USERS_DECLARATION,
  SLACK_GET_USER_INFO_DECLARATION,
  SLACK_GET_THREAD_REPLIES_DECLARATION,
  SLACK_SEARCH_MESSAGES_DECLARATION,
  SLACK_UPLOAD_FILE_DECLARATION,
];
