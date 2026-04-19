import { DEFAULT_CONFIG, PLUGIN_ID, PLUGIN_VERSION, MAX_AGENTS_PER_THREAD } from "./constants.js";

const manifest = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Bot",
  description:
    "Bidirectional Telegram integration: push notifications, bot commands, escalation to humans, multi-agent sessions (native + ACP), media pipeline with transcription, custom workflow commands, and proactive suggestion watches.",
  author: "mvanhorn",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "agents.read",
    "agents.invoke",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "agent.tools.register",
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      telegramBotTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Telegram Bot Token (secret reference)",
        description:
          "Secret UUID for your Telegram Bot token. Create the secret in Settings -> Secrets, then paste its UUID here. Get a token from @BotFather.",
        default: DEFAULT_CONFIG.telegramBotTokenRef,
      },
      defaultChatId: {
        type: "string",
        title: "Default Chat ID",
        description:
          "Telegram chat ID to send notifications to. Use a group chat ID (negative number) or a user chat ID.",
        default: DEFAULT_CONFIG.defaultChatId,
      },
      approvalsChatId: {
        type: "string",
        title: "Approvals Chat ID",
        description: "Chat ID for approval requests. Falls back to default chat.",
        default: DEFAULT_CONFIG.approvalsChatId,
      },
      errorsChatId: {
        type: "string",
        title: "Errors Chat ID",
        description: "Chat ID for agent error notifications. Falls back to default chat.",
        default: DEFAULT_CONFIG.errorsChatId,
      },
      notifyOnIssueCreated: {
        type: "boolean",
        title: "Notify on issue created",
        default: DEFAULT_CONFIG.notifyOnIssueCreated,
      },
      notifyOnIssueDone: {
        type: "boolean",
        title: "Notify on issue completed",
        default: DEFAULT_CONFIG.notifyOnIssueDone,
      },
      notifyOnApprovalCreated: {
        type: "boolean",
        title: "Notify on approval requested",
        default: DEFAULT_CONFIG.notifyOnApprovalCreated,
      },
      notifyOnAgentError: {
        type: "boolean",
        title: "Notify on agent error",
        default: DEFAULT_CONFIG.notifyOnAgentError,
      },
      enableCommands: {
        type: "boolean",
        title: "Enable bot commands",
        description: "Allow users to interact with Paperclip via Telegram bot commands (/status, /issues, /agents).",
        default: DEFAULT_CONFIG.enableCommands,
      },
      enableInbound: {
        type: "boolean",
        title: "Enable inbound message routing",
        description:
          "Route Telegram messages to Paperclip issue comments. Messages sent in reply to a notification get attached to that issue.",
        default: DEFAULT_CONFIG.enableInbound,
      },
      dailyDigestEnabled: {
        type: "boolean",
        title: "Daily digest",
        description: "Send a daily summary of agent activity.",
        default: DEFAULT_CONFIG.dailyDigestEnabled,
      },
      dailyDigestTime: {
        type: "string",
        title: "Digest time (HH:MM UTC)",
        description: "Time to send the daily digest in UTC.",
        default: DEFAULT_CONFIG.dailyDigestTime,
      },
      topicRouting: {
        type: "boolean",
        title: "Forum topic routing",
        description:
          "Map Telegram forum topics to Paperclip projects. Requires the bot to be in a group with forum topics enabled.",
        default: DEFAULT_CONFIG.topicRouting,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        description: "Base URL of the Paperclip API server.",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      escalationChatId: {
        type: "string",
        title: "Escalation Chat ID",
        description:
          "Telegram chat ID where escalations are sent for human review. If empty, escalations are logged but not forwarded.",
        default: DEFAULT_CONFIG.escalationChatId,
      },
      escalationTimeoutMs: {
        type: "number",
        title: "Escalation Timeout (ms)",
        description:
          "How long to wait for a human response before taking the default action. Default: 900000 (15 minutes).",
        default: DEFAULT_CONFIG.escalationTimeoutMs,
      },
      escalationDefaultAction: {
        type: "string",
        title: "Escalation Default Action",
        description:
          "What to do when an escalation times out: defer (do nothing), auto_reply (send suggested reply), or close.",
        enum: ["defer", "auto_reply", "close"],
        default: DEFAULT_CONFIG.escalationDefaultAction,
      },
      escalationHoldMessage: {
        type: "string",
        title: "Escalation Hold Message",
        description: "Message sent to the user when their conversation is escalated to a human.",
        default: DEFAULT_CONFIG.escalationHoldMessage,
      },
      maxAgentsPerThread: {
        type: "number",
        title: "Max Agents Per Thread",
        description: "Maximum number of concurrent agent sessions allowed in a single thread.",
        default: MAX_AGENTS_PER_THREAD,
      },
      briefAgentId: {
        type: "string",
        title: "Brief Agent ID",
        description: "Agent ID for processing media intake briefs. Leave empty to disable media pipeline.",
        default: DEFAULT_CONFIG.briefAgentId,
      },
      briefAgentChatIds: {
        type: "array",
        items: { type: "string" },
        title: "Brief Agent Intake Chat IDs",
        description:
          "Telegram chat IDs where media is routed to the Brief Agent. Media in other chats goes to active agent sessions.",
        default: DEFAULT_CONFIG.briefAgentChatIds,
      },
      transcriptionApiKeyRef: {
        type: "string",
        format: "secret-ref",
        title: "Transcription API Key (secret reference)",
        description:
          "Secret UUID for your OpenAI API key used for Whisper transcription. Create the secret in Settings -> Secrets, then paste its UUID here.",
        default: DEFAULT_CONFIG.transcriptionApiKeyRef,
      },
      maxSuggestionsPerHourPerCompany: {
        type: "number",
        title: "Max Suggestions per Hour per Company",
        description: "Rate limit for proactive watch suggestions.",
        default: DEFAULT_CONFIG.maxSuggestionsPerHourPerCompany,
      },
      watchDeduplicationWindowMs: {
        type: "number",
        title: "Watch Deduplication Window (ms)",
        description:
          "Suppress duplicate watch suggestions for the same entity within this window. Default: 86400000 (24 hours).",
        default: DEFAULT_CONFIG.watchDeduplicationWindowMs,
      },
    },
    required: ["telegramBotTokenRef", "defaultChatId"],
  },
  jobs: [
    {
      jobKey: "telegram-daily-digest",
      displayName: "Telegram Daily Digest",
      description: "Send a daily summary of agent activity to Telegram.",
      schedule: "0 9 * * *",
    },
    {
      jobKey: "check-escalation-timeouts",
      displayName: "Check Escalation Timeouts",
      description: "Check for timed-out escalations and apply default actions.",
      schedule: "* * * * *",
    },
    {
      jobKey: "check-watches",
      displayName: "Check Proactive Watches",
      description: "Evaluate registered watches and send suggestions when conditions are met.",
      schedule: "*/15 * * * *",
    },
  ],
  tools: [
    {
      name: "escalate_to_human",
      displayName: "Escalate to Human",
      description: "Escalate a conversation to a human when you cannot handle it confidently",
      parametersSchema: { type: "object" },
    },
    {
      name: "handoff_to_agent",
      displayName: "Handoff to Agent",
      description: "Hand off work to another agent in this thread",
      parametersSchema: { type: "object" },
    },
    {
      name: "discuss_with_agent",
      displayName: "Discuss with Agent",
      description: "Start a back-and-forth conversation with another agent",
      parametersSchema: { type: "object" },
    },
    {
      name: "register_watch",
      displayName: "Register Watch",
      description: "Register a proactive watch that monitors entities and sends suggestions",
      parametersSchema: { type: "object" },
    },
  ],
};

export default manifest;
