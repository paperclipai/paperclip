import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  PLUGIN_ID,
  PLUGIN_VERSION,
  WEBHOOK_KEYS,
} from "./constants.js";
import { TOOL_DECLARATIONS } from "./tool-declarations.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack Chat OS",
  description:
    "Full Chat OS for Slack: escalation, multi-agent sessions, media pipeline, custom commands, and proactive suggestions. Push Paperclip notifications, receive slash commands, and manage agent workflows.",
  author: "mvanhorn",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "agents.invoke",
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "approvals.resolve",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "instance.settings.register",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
    "agent.tools.register",
    "users.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      slackTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Slack Bot Token (secret reference)",
        description:
          "Secret UUID for your Slack Bot OAuth token. Create the secret in Settings → Secrets, then paste its UUID here.",
        default: DEFAULT_CONFIG.slackTokenRef,
      },
      slackSigningSecretRef: {
        type: "string",
        format: "secret-ref",
        title: "Slack Signing Secret (secret reference)",
        description:
          "Secret UUID for your Slack app's Signing Secret. Required to verify that incoming webhooks are genuinely from Slack.",
        default: DEFAULT_CONFIG.slackSigningSecretRef,
      },
      slackUserTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Slack User Token (secret reference, optional)",
        description:
          "Required for slack_search_messages. Bot tokens cannot use search.messages. Leave blank to disable search.",
        default: DEFAULT_CONFIG.slackUserTokenRef,
      },
      companyId: {
        type: "string",
        title: "Company ID (optional runtime scope)",
        description:
          "Hosted single-company deployments should set this to avoid unscoped company discovery from Slack webhooks and scheduled jobs.",
        default: DEFAULT_CONFIG.companyId,
      },
      defaultChannelId: {
        type: "string",
        title: "Default Slack Channel ID",
        description: "Channel ID to post notifications to (e.g. C01ABC2DEF3).",
        default: DEFAULT_CONFIG.defaultChannelId,
      },
      approvalsChannelId: {
        type: "string",
        title: "Approvals Channel ID",
        description:
          "Dedicated channel for approval notifications (optional, falls back to default).",
        default: DEFAULT_CONFIG.approvalsChannelId,
      },
      errorsChannelId: {
        type: "string",
        title: "Errors Channel ID",
        description:
          "Dedicated channel for agent error notifications (optional, falls back to default).",
        default: DEFAULT_CONFIG.errorsChannelId,
      },
      pipelineChannelId: {
        type: "string",
        title: "Pipeline Channel ID",
        description:
          "Dedicated channel for agent lifecycle events (optional, falls back to default).",
        default: DEFAULT_CONFIG.pipelineChannelId,
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
      approvalReactorSlackIds: {
        type: "array",
        items: { type: "string" },
        title: "Approval reactor allowlist (Slack user IDs)",
        description:
          "Slack user IDs (e.g. U01ABC2DEF3) allowed to resolve approvals via reaction (✅ approve / ❌ reject), thread command (!approve / !reject / !revise), approval buttons, or /clip approve. Leave empty to keep approval cards read-only. Reaction/thread interactions require the Slack app to subscribe to reaction_added, reaction_removed, and message.channels events (scopes: reactions:read, channels:history/groups:history).",
        default: DEFAULT_CONFIG.approvalReactorSlackIds,
      },
      notifyOnAgentError: {
        type: "boolean",
        title: "Notify on agent error",
        default: DEFAULT_CONFIG.notifyOnAgentError,
      },
      notifyOnAgentConnected: {
        type: "boolean",
        title: "Notify on agent connected/disconnected",
        default: DEFAULT_CONFIG.notifyOnAgentConnected,
      },
      notifyOnBudgetThreshold: {
        type: "boolean",
        title: "Notify on budget threshold reached",
        default: DEFAULT_CONFIG.notifyOnBudgetThreshold,
      },
      enableDailyDigest: {
        type: "boolean",
        title: "Send daily activity digest",
        description:
          "Posts a summary of all agent activity, costs, and completed tasks once per day.",
        default: DEFAULT_CONFIG.enableDailyDigest,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        description: "Base URL of your Paperclip instance for dashboard links.",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      escalationChatId: {
        type: "string",
        title: "Escalation Channel ID",
        description:
          "Dedicated channel for escalation notifications (optional, falls back to approvalsChannelId or defaultChannelId).",
        default: DEFAULT_CONFIG.escalationChatId,
      },
      escalationTimeoutMs: {
        type: "number",
        title: "Escalation Timeout (ms)",
        description:
          "Time in milliseconds before an unresolved escalation triggers the default action.",
        default: DEFAULT_CONFIG.escalationTimeoutMs,
      },
      escalationDedupeWindowMs: {
        type: "number",
        title: "Escalation dedupe window (ms)",
        description:
          "Suppresses duplicate issue.escalation.needs_human_decision Slack posts for the same issue inside this window. Defaults to 1 hour.",
        default: DEFAULT_CONFIG.escalationDedupeWindowMs,
      },
      escalationDefaultAction: {
        type: "string",
        title: "Escalation Default Action",
        description:
          "Action to take when an escalation times out: 'defer', 'dismiss', or 'auto_reply'.",
        default: DEFAULT_CONFIG.escalationDefaultAction,
      },
      escalationHoldMessage: {
        type: "string",
        title: "Escalation Hold Message",
        description:
          "Message sent to the customer while waiting for a human to respond.",
        default: DEFAULT_CONFIG.escalationHoldMessage,
      },
      maxAgentsPerThread: {
        type: "number",
        title: "Max Agents Per Thread",
        description:
          "Maximum number of concurrent agents allowed in a single Slack thread.",
        default: DEFAULT_CONFIG.maxAgentsPerThread,
      },
    },
    required: ["slackTokenRef", "slackSigningSecretRef", "defaultChannelId"],
  },
  jobs: [
    {
      jobKey: "daily-digest",
      displayName: "Daily Activity Digest",
      description:
        "Posts a summary of agent activity, costs, and completed tasks to Slack.",
      schedule: "0 9 * * *",
    },
    {
      jobKey: "check-escalation-timeouts",
      displayName: "Check Escalation Timeouts",
      description:
        "Checks for unresolved escalations that have exceeded the configured timeout.",
      schedule: "*/1 * * * *",
    },
    {
      jobKey: "check-watches",
      displayName: "Check Event Watches",
      description:
        "Processes pending event watches and triggers agent invocations for matching events.",
      schedule: "*/2 * * * *",
    },
    {
      jobKey: "commit-pending-approvals",
      displayName: "Commit Pending Approvals",
      description:
        "Commits reaction-staged approval decisions whose undo grace window has elapsed (two-phase resolve). Backstop for reactions that are never removed.",
      schedule: "*/1 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.slackEvents,
      displayName: "Slack Events API",
      description:
        "Receives Slack Events API payloads (url_verification, event callbacks: file_shared, reaction_added, reaction_removed, message). Approval reaction/thread interactions require the Slack app to subscribe to reaction_added, reaction_removed, and message.channels with scopes reactions:read and channels:history (or groups:history for private channels).",
    },
    {
      endpointKey: WEBHOOK_KEYS.slashCommand,
      displayName: "Slack Slash Command",
      description: "Receives /clip slash commands from Slack.",
    },
    {
      endpointKey: WEBHOOK_KEYS.interactivity,
      displayName: "Slack Interactivity",
      description:
        "Receives button click payloads from interactive messages (approve/reject/escalation/handoff/discussion/command).",
    },
  ],
  // Tool declarations are imported from `tool-declarations.ts`, which is also
  // consumed by `worker.ts` so manifest and runtime registrations stay in sync.
  // Spread copies the readonly source array into the mutable shape the manifest
  // type expects, without losing the immutability of TOOL_DECLARATIONS itself.
  tools: [...TOOL_DECLARATIONS],
};

export default manifest;
