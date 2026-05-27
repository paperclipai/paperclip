import { createHmac, timingSafeEqual } from "node:crypto";
import {
  definePlugin,
  startWorkerRpcHost,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type ToolRunContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS, STATE_KEYS } from "./constants.js";
import {
  ESCALATE_TO_HUMAN_DECLARATION,
  HANDOFF_TO_AGENT_DECLARATION,
  DISCUSS_WITH_AGENT_DECLARATION,
  PROCESS_MEDIA_DECLARATION,
  REGISTER_COMMAND_DECLARATION,
  REGISTER_WATCH_DECLARATION,
  REMOVE_WATCH_DECLARATION,
  LIST_WATCH_TEMPLATES_DECLARATION,
} from "./tool-declarations.js";
import {
  authTest,
  conversationsInfo,
  postMessage,
  respondToAction,
  respondEphemeral,
  type SlackMessage,
} from "./slack-api.js";
import { registerTool, registerTools } from "./tools.js";
import { SlackAdapter } from "./adapter.js";
import {
  routeMessageToAgent,
  handleAgentOutput,
  handleHandoffAction,
  handleDiscussionAction,
  handleAcpSlashCommand,
  startDiscussion,
  buildHandoffBlocks,
} from "./acp-bridge.js";
import {
  setBaseUrl,
  formatIssueCreated,
  formatAssigneeDmIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatIssueThreadInteractionCreated,
  formatApprovalResolved,
  formatAgentError,
  formatAgentConnected,
  formatBudgetThreshold,
  formatOnboardingMilestone,
  formatDailyDigest,
  formatEscalationMessage,
  formatEscalationResolved,
} from "./formatters.js";
import { processMediaFile, isMediaFile } from "./media-pipeline.js";
import {
  registerCommand,
  handleCommandsSlash,
  tryCustomCommand,
} from "./custom-commands.js";
import {
  registerWatch,
  removeWatch,
  listWatches,
  checkWatches,
  BUILTIN_WATCH_TEMPLATES,
} from "./proactive-suggestions.js";
import { resolveSlackUserId } from "./user-mapping.js";
import type {
  SlackPluginConfig,
  EscalationRecord,
  CommandDefinition,
  CommandStep,
  SessionEntry,
} from "./types.js";

let pluginCtx: PluginContext;
let pluginToken: string;
let pluginConfig: SlackPluginConfig;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let slackAdapter: SlackAdapter;

// --- Slack signature verification ---
let slackSigningSecret: string | null = null;

function verifySlackSignature(
  headers: Record<string, string | string[]>,
  rawBody: string,
): boolean {
  if (!slackSigningSecret) return true; // skip if not configured
  const timestamp = String(
    headers["x-slack-request-timestamp"] ??
      headers["X-Slack-Request-Timestamp"] ??
      "",
  );
  const signature = String(
    headers["x-slack-signature"] ?? headers["X-Slack-Signature"] ?? "",
  );
  if (!timestamp || !signature) return false;
  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", slackSigningSecret)
    .update(baseString)
    .digest("hex");
  const expected = `v0=${hmac}`;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// --- Helpers ---
async function resolveChannel(
  ctx: PluginContext,
  companyId: string,
  fallback?: string | null,
): Promise<string | null> {
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.slackChannel,
  });
  return (override as string | null) ?? fallback ?? null;
}

interface ParsedSlashCommand {
  command: string;
  text: string;
  responseUrl: string;
  userId: string;
  channelId: string;
  threadTs: string;
}

function parseSlashCommand(rawBody: string): ParsedSlashCommand {
  const params = new URLSearchParams(rawBody);
  return {
    command: params.get("command") ?? "",
    text: params.get("text") ?? "",
    responseUrl: params.get("response_url") ?? "",
    userId: params.get("user_id") ?? "",
    channelId: params.get("channel_id") ?? "",
    threadTs: params.get("thread_ts") ?? "",
  };
}

function statusBadge(status: string): string {
  const badges: Record<string, string> = {
    active: ":large_green_circle:",
    running: ":large_green_circle:",
    idle: ":white_circle:",
    paused: ":double_vertical_bar:",
    error: ":red_circle:",
    pending_approval: ":hourglass:",
    terminated: ":black_circle:",
  };
  return badges[status] ?? ":white_circle:";
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Slash command routing ---
async function handleSlashCommand(
  ctx: PluginContext,
  rawBody: string,
): Promise<void> {
  const { text, responseUrl, channelId, threadTs } = parseSlashCommand(rawBody);
  const parts = text.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";
  const arg = parts[1]?.toLowerCase() ?? "";
  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id ?? "";
  try {
    switch (subcommand) {
      case "status":
        await handleStatusCommand(ctx, companyId, responseUrl);
        break;
      case "help":
      case "":
        await handleHelpCommand(ctx, responseUrl);
        break;
      case "agents":
        await handleAgentsCommand(ctx, companyId, responseUrl);
        break;
      case "issues":
        await handleIssuesCommand(ctx, companyId, responseUrl, arg);
        break;
      case "approve":
        await handleApproveCommand(ctx, responseUrl, arg);
        break;
      case "acp": {
        const acpText = parts.slice(1).join(" ");
        await handleAcpSlashCommand(ctx, pluginToken, {
          channel: channelId,
          threadTs,
          text: acpText,
          companyId,
        });
        break;
      }
      case "commands":
        await handleCommandsSlash(ctx, companyId, responseUrl);
        break;
      case "watches": {
        const watches = await listWatches(ctx, companyId);
        if (watches.length === 0) {
          await respondEphemeral(ctx, responseUrl, {
            text: "No active watches. Use the `register_watch` tool to add watches.",
          });
        } else {
          const lines = watches.map(
            (w) =>
              `:bell: \`${w.eventPattern}\` -> *${w.agentId}* (triggered ${w.triggerCount}x)`,
          );
          await respondEphemeral(ctx, responseUrl, {
            text: `${watches.length} active watch(es)`,
            blocks: [
              {
                type: "header",
                text: {
                  type: "plain_text",
                  text: `Active Watches (${watches.length})`,
                },
              },
              {
                type: "section",
                text: { type: "mrkdwn", text: lines.join("\n") },
              },
            ],
          });
        }
        break;
      }
      default:
        await respondEphemeral(ctx, responseUrl, {
          text: `Unknown command: \`${subcommand}\`. Use \`/clip help\` to see available commands.`,
        });
    }
    await ctx.metrics.write("slack.commands.handled", 1, {
      command_name: subcommand || "help",
    });
  } catch (err) {
    ctx.logger.warn("Slash command failed", { subcommand, err });
    await respondEphemeral(ctx, responseUrl, {
      text: "Something went wrong processing your command. Please try again.",
    });
  }
}

async function handleStatusCommand(
  ctx: PluginContext,
  companyId: string,
  responseUrl: string,
): Promise<void> {
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });
  const activeAgents = agents.filter(
    (a) => a.status === "active" || a.status === "running",
  );
  const recentDone = await ctx.issues.list({
    companyId,
    status: "done",
    limit: 5,
    offset: 0,
  });
  const agentSummary =
    activeAgents.length > 0
      ? activeAgents
          .map((a) => `${statusBadge(a.status)} ${a.name}`)
          .join("\n")
      : "_No active agents_";
  const issueSummary =
    recentDone.length > 0
      ? recentDone.map((i) => `:white_check_mark: ${i.title}`).join("\n")
      : "_No recent completions_";
  await respondEphemeral(ctx, responseUrl, {
    text: `Status: ${activeAgents.length} active agents, ${recentDone.length} recent completions`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Paperclip Status" },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Active Agents (${activeAgents.length})*\n${agentSummary}`,
          },
          { type: "mrkdwn", text: `*Recent Completions*\n${issueSummary}` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Dashboard" },
            url: pluginConfig.paperclipBaseUrl,
            action_id: "view_dashboard",
          },
        ],
      },
    ],
  });
}

async function handleHelpCommand(
  ctx: PluginContext,
  responseUrl: string,
): Promise<void> {
  await respondEphemeral(ctx, responseUrl, {
    text: "Available /clip commands",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Paperclip Slash Commands" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "`/clip status` - Show active agents and recent completions",
            "`/clip agents` - List all agents with status badges",
            "`/clip issues [open|done]` - List issues filtered by status",
            "`/clip approve <id>` - Approve a pending approval",
            "`/clip acp spawn <agent> [display]` - Add an agent to this thread",
            "`/clip acp status` - Show all agents in this thread",
            "`/clip acp close [name]` - Close a specific agent (or most recent)",
            "`/clip commands` - List registered custom commands",
            "`/clip watches` - List active event watches",
            "`/clip help` - Show this help message",
          ].join("\n"),
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${pluginConfig.paperclipBaseUrl}|Open Paperclip Dashboard>`,
          },
        ],
      },
    ],
  });
}

async function handleAgentsCommand(
  ctx: PluginContext,
  companyId: string,
  responseUrl: string,
): Promise<void> {
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });
  if (agents.length === 0) {
    await respondEphemeral(ctx, responseUrl, { text: "No agents found." });
    return;
  }
  const lines = agents.map(
    (a) => `${statusBadge(a.status)} *${a.name}* - \`${a.status}\``,
  );
  await respondEphemeral(ctx, responseUrl, {
    text: `${agents.length} agents`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Agents (${agents.length})` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

async function handleIssuesCommand(
  ctx: PluginContext,
  companyId: string,
  responseUrl: string,
  filter: string,
): Promise<void> {
  const status =
    filter === "done" ? "done" : filter === "open" ? "todo" : undefined;
  const issues = await ctx.issues.list({
    companyId,
    status,
    limit: 10,
    offset: 0,
  });
  if (issues.length === 0) {
    await respondEphemeral(ctx, responseUrl, {
      text: `No ${status ?? ""} issues found.`,
    });
    return;
  }
  const lines = issues.map((i) => {
    const badge = i.status === "done" ? ":white_check_mark:" : ":blue_book:";
    return `${badge} *${i.title}* - \`${i.status}\``;
  });
  await respondEphemeral(ctx, responseUrl, {
    text: `${issues.length} issues`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Issues${status ? ` (${status})` : ""} - showing ${issues.length}`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

async function handleApproveCommand(
  ctx: PluginContext,
  responseUrl: string,
  approvalId: string,
): Promise<void> {
  if (!approvalId) {
    await respondEphemeral(ctx, responseUrl, {
      text: "Usage: `/clip approve <approval-id>`",
    });
    return;
  }
  try {
    await ctx.http.fetch(
      `${pluginConfig.paperclipBaseUrl}/api/approvals/${approvalId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decidedByUserId: "slack:command" }),
      },
    );
    await respondEphemeral(ctx, responseUrl, {
      text: `:white_check_mark: Approval \`${approvalId}\` approved.`,
    });
    await ctx.metrics.write("slack.approvals.decided", 1, {
      decision: "approve",
    });
  } catch (err) {
    ctx.logger.warn("Approve command failed", { approvalId, err });
    await respondEphemeral(ctx, responseUrl, {
      text: `:x: Failed to approve \`${approvalId}\`. Check the ID and try again.`,
    });
  }
}

async function validateSlackConfig(
  rawConfig: Record<string, unknown>,
): Promise<{ ok: boolean; warnings?: string[]; errors?: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const config = rawConfig as unknown as SlackPluginConfig;

  if (!pluginCtx) {
    errors.push("Plugin worker not initialized");
    return { ok: false, errors };
  }

  if (!config.slackTokenRef) {
    errors.push("Slack Bot Token (secret reference) is required");
    return { ok: false, errors };
  }

  let token: string;
  try {
    token = await pluginCtx.secrets.resolve(config.slackTokenRef);
  } catch (err) {
    errors.push(
      `Could not resolve Slack Bot Token secret: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, errors };
  }

  const auth = await authTest(pluginCtx, token);
  if (!auth.ok) {
    errors.push(`Slack auth.test failed: ${auth.error ?? "unknown error"}`);
    return { ok: false, errors };
  }

  warnings.push(`Connected as ${auth.user ?? "?"} on team ${auth.team ?? "?"}`);

  if (!config.slackSigningSecretRef) {
    warnings.push("No signing secret configured — incoming webhook signature verification is disabled");
  } else {
    try {
      await pluginCtx.secrets.resolve(config.slackSigningSecretRef);
    } catch (err) {
      errors.push(
        `Could not resolve Slack Signing Secret: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!config.slackUserTokenRef) {
    warnings.push("No user token — slack_search_messages tool is disabled");
  }

  const channelChecks: Array<{ key: keyof SlackPluginConfig; label: string }> = [
    { key: "defaultChannelId", label: "Default channel" },
    { key: "approvalsChannelId", label: "Approvals channel" },
    { key: "errorsChannelId", label: "Errors channel" },
    { key: "pipelineChannelId", label: "Pipeline channel" },
    { key: "escalationChatId", label: "Escalation channel" },
  ];

  if (!config.defaultChannelId) {
    warnings.push("No default channel — notifications will not post anywhere by default");
  }

  // Errors that mean "the channel id might still be valid, but we can't verify
  // it from this token" — surface as warnings so a chat:write-only token doesn't
  // false-fail the whole test.
  const UNVERIFIABLE_CHANNEL_ERRORS = new Set([
    "missing_scope",
    "not_in_channel",
    "channel_not_visible",
  ]);

  for (const { key, label } of channelChecks) {
    const channelId = config[key];
    if (typeof channelId !== "string" || channelId.length === 0) continue;
    const info = await conversationsInfo(pluginCtx, token, channelId);
    if (info.ok) {
      if (info.channel?.is_archived) {
        warnings.push(`${label} (${channelId}) is archived`);
      }
      continue;
    }
    const slackError = info.error ?? "not accessible";
    if (UNVERIFIABLE_CHANNEL_ERRORS.has(slackError)) {
      warnings.push(
        `${label} (${channelId}): could not verify (${slackError}); the channel may still work for posting if the bot is a member and has chat:write`,
      );
    } else {
      errors.push(`${label} (${channelId}): ${slackError}`);
    }
  }

  return { ok: errors.length === 0, warnings, errors };
}

// --- Plugin definition ---
const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const config = rawConfig as unknown as SlackPluginConfig;
    pluginCtx = ctx;
    pluginConfig = config;
    if (config.paperclipBaseUrl) {
      setBaseUrl(config.paperclipBaseUrl);
    }
    if (!config.slackTokenRef) {
      ctx.logger.warn("No slackTokenRef configured, notifications disabled");
      return;
    }
    const token = await ctx.secrets.resolve(config.slackTokenRef);
    pluginToken = token;
    // Resolve Slack signing secret for webhook signature verification
    if (config.slackSigningSecretRef) {
      try {
        slackSigningSecret = await ctx.secrets.resolve(
          config.slackSigningSecretRef,
        );
      } catch {
        ctx.logger.warn(
          "Slack signing secret not configured — webhook signature verification disabled",
        );
      }
    }

    // =========================================================================
    // PHASE 1: Escalation - using 3-arg ctx.tools.register with ToolRunContext
    // =========================================================================
    registerTool(
      ctx,
      ESCALATE_TO_HUMAN_DECLARATION,
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const companyId = runCtx.companyId;
        const escalationId = genId("esc");
        const record: EscalationRecord = {
          id: escalationId,
          reason: String(p.reason ?? ""),
          confidence: p.confidence != null ? Number(p.confidence) : undefined,
          agentName: p.agentName != null ? String(p.agentName) : undefined,
          conversationHistory: p.conversationHistory as
            | EscalationRecord["conversationHistory"]
            | undefined,
          agentReasoning:
            p.agentReasoning != null ? String(p.agentReasoning) : undefined,
          suggestedReply:
            p.suggestedReply != null ? String(p.suggestedReply) : undefined,
          status: "open",
          createdAt: new Date().toISOString(),
        };
        const channelId =
          config.escalationChatId ||
          config.approvalsChannelId ||
          config.defaultChannelId;
        if (!channelId) {
          return { error: "No escalation channel configured" };
        }
        const message = formatEscalationMessage(record);
        const result = await postMessage(ctx, token, channelId, message);
        if (result.ok && result.ts) {
          await ctx.state.set(
            {
              scopeKind: "company",
              scopeId: companyId,
              stateKey: STATE_KEYS.escalationTs(escalationId),
            },
            result.ts,
          );
          await ctx.state.set(
            {
              scopeKind: "company",
              scopeId: companyId,
              stateKey: STATE_KEYS.escalationChannel(escalationId),
            },
            channelId,
          );
          await ctx.state.set(
            {
              scopeKind: "company",
              scopeId: companyId,
              stateKey: STATE_KEYS.escalationRecord(escalationId),
            },
            record,
          );
          await ctx.activity.log({
            companyId,
            message: `Escalation posted to Slack: ${record.reason}`,
            entityType: "plugin",
            entityId: escalationId,
          });
          await ctx.metrics.write("slack.escalations.created", 1);
        }
        if (config.escalationHoldMessage) {
          return {
            content: JSON.stringify({
              escalationId,
              holdMessage: config.escalationHoldMessage,
            }),
          };
        }
        return { content: JSON.stringify({ escalationId }) };
      },
    );

    // =========================================================================
    // PHASE 2: Multi-Agent - handoff and discuss tools
    // =========================================================================
    registerTool(
      ctx,
      HANDOFF_TO_AGENT_DECLARATION,
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const companyId = runCtx.companyId;
        const fromAgent = String(p.fromAgent ?? "");
        const toAgent = String(p.toAgent ?? "");
        const reason = String(p.reason ?? "");
        const channelId = String(p.channelId ?? "");
        const threadTs = String(p.threadTs ?? "");
        const context = p.context != null ? String(p.context) : undefined;
        const handoffId = genId("hoff");
        await ctx.state.set(
          {
            scopeKind: "company",
            scopeId: companyId,
            stateKey: STATE_KEYS.handoff(handoffId),
          },
          {
            id: handoffId,
            fromAgent,
            toAgent,
            reason,
            context,
            channelId,
            threadTs,
            companyId,
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        );
        const blocks = buildHandoffBlocks(fromAgent, toAgent, reason, handoffId);
        await postMessage(
          ctx,
          token,
          channelId,
          {
            text: `Handoff: ${fromAgent} -> ${toAgent}: ${reason}`,
            blocks,
          },
          threadTs ? { threadTs } : undefined,
        );
        return {
          content: JSON.stringify({ handoffId, status: "pending" }),
        };
      },
    );

    registerTool(
      ctx,
      DISCUSS_WITH_AGENT_DECLARATION,
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const companyId = runCtx.companyId;
        const result = await startDiscussion(ctx, token, companyId, {
          initiatorAgent: String(p.initiatorAgent ?? ""),
          targetAgent: String(p.targetAgent ?? ""),
          topic: String(p.topic ?? ""),
          channelId: String(p.channelId ?? ""),
          threadTs: String(p.threadTs ?? ""),
          maxTurns: Number(p.maxTurns ?? 10),
        });
        return { content: JSON.stringify(result) };
      },
    );

    // =========================================================================
    // PHASE 3: Media Pipeline tool
    // =========================================================================
    registerTool(
      ctx,
      PROCESS_MEDIA_DECLARATION,
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const result = await processMediaFile(
          ctx,
          token,
          runCtx.companyId,
          String(p.fileId),
          String(p.channelId),
          String(p.threadTs),
          p.briefAgentId ? String(p.briefAgentId) : undefined,
        );
        if (!result) {
          return { error: "Failed to process media file" };
        }
        return { content: JSON.stringify(result) };
      },
    );

    // =========================================================================
    // PHASE 4: Custom Commands tool
    // =========================================================================
    registerTool(
      ctx,
      REGISTER_COMMAND_DECLARATION,
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const command: CommandDefinition = {
          name: String(p.name),
          description: String(p.description),
          usage: String(p.usage),
          steps: (p.steps as CommandStep[] | undefined) ?? [],
        };
        const ok = await registerCommand(ctx, runCtx.companyId, command);
        return {
          content: JSON.stringify({ registered: ok, name: command.name }),
        };
      },
    );

    // =========================================================================
    // PHASE 5: Proactive Suggestions tool
    // =========================================================================
    registerTool(
      ctx,
      REGISTER_WATCH_DECLARATION,
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const watch = await registerWatch(ctx, runCtx.companyId, {
          channelId: String(p.channelId),
          threadTs: String(p.threadTs ?? ""),
          companyId: runCtx.companyId,
          eventPattern: String(p.eventPattern),
          agentId: String(p.agentId),
          prompt: String(p.prompt),
          createdBy: runCtx.agentId ?? "tool",
        });
        return {
          content: JSON.stringify({
            watchId: watch.id,
            eventPattern: watch.eventPattern,
          }),
        };
      },
    );

    registerTool(
      ctx,
      REMOVE_WATCH_DECLARATION,
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const removed = await removeWatch(ctx, String(p.watchId));
        return {
          content: JSON.stringify({ removed, watchId: String(p.watchId) }),
        };
      },
    );

    registerTool(
      ctx,
      LIST_WATCH_TEMPLATES_DECLARATION,
      async (
        _params: unknown,
        _runCtx: ToolRunContext,
      ): Promise<ToolResult> => {
        const templates = BUILTIN_WATCH_TEMPLATES.map((t) => ({
          name: t.name,
          eventPattern: t.eventPattern,
          description: t.description,
        }));
        return { content: JSON.stringify({ templates }) };
      },
    );

    // =========================================================================
    // Slack-API tools (Task 9): 11 direct, agent-callable Slack handlers.
    // =========================================================================
    registerTools(ctx, {
      slackTokenRef: config.slackTokenRef,
      slackUserTokenRef: config.slackUserTokenRef,
    });

    // =========================================================================
    // Notification helper (supports per-type channel override + threading)
    // =========================================================================
    const notify = async (
      event: PluginEvent,
      formatter: (event: PluginEvent) => SlackMessage,
      overrideChannelId?: string,
      opts?: { threadTs?: string },
    ) => {
      const fallback = overrideChannelId || config.defaultChannelId;
      const channelId = await resolveChannel(ctx, event.companyId, fallback);
      if (!channelId) {
        await ctx.metrics.write("slack.notifications.failed", 1, {
          event_type: event.eventType,
          error_code: "no_channel",
        });
        return;
      }
      const result = await postMessage(
        ctx,
        token,
        channelId,
        formatter(event),
        opts,
      );
      if (result.ok) {
        await ctx.activity.log({
          companyId: event.companyId,
          message: `Forwarded ${event.eventType} to Slack`,
          entityType: "plugin",
          entityId: event.entityId,
        });
        await ctx.metrics.write("slack.notifications.sent", 1, {
          event_type: event.eventType,
        });
      } else {
        await ctx.metrics.write("slack.notifications.failed", 1, {
          event_type: event.eventType,
          error_code: result.error ?? "unknown",
        });
      }
      return result;
    };

    // =========================================================================
    // Core event subscriptions (existing notifications)
    // =========================================================================
    if (config.notifyOnIssueCreated) {
      ctx.events.on("issue.created", async (event) => {
        const result = await notify(event, formatIssueCreated);
        if (result?.ok && result.ts) {
          await ctx.state.set(
            {
              scopeKind: "company",
              scopeId: event.companyId,
              stateKey: STATE_KEYS.threadIssue(event.entityId ?? ""),
            },
            result.ts,
          );
        }
      });
    }
    if (config.notifyOnIssueDone) {
      ctx.events.on("issue.updated", async (event) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status !== "done") return;
        const threadTs = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.threadIssue(event.entityId ?? ""),
        });
        await notify(
          event,
          formatIssueDone,
          undefined,
          threadTs ? { threadTs: String(threadTs) } : undefined,
        );
      });
    }
    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", async (event) => {
        await notify(event, formatApprovalCreated, config.approvalsChannelId);
      });
      ctx.events.on("issue.thread_interaction.created", async (event) => {
        await notify(event, formatIssueThreadInteractionCreated, config.approvalsChannelId);
      });
    }
    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", async (event) => {
        await notify(event, formatAgentError, config.errorsChannelId);
      });
    }
    if (config.notifyOnAgentConnected) {
      ctx.events.on("agent.status_changed", async (event) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status === "active" || payload.status === "online") {
          await notify(event, formatAgentConnected, config.pipelineChannelId);
        }
      });
      ctx.events.on("agent.run.finished", async (event) => {
        const payload = event.payload as Record<string, unknown>;
        const key = STATE_KEYS.firstRunNotified(event.entityId ?? "");
        const alreadyNotified = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: key,
        });
        if (alreadyNotified) return;
        await ctx.state.set(
          {
            scopeKind: "company",
            scopeId: event.companyId,
            stateKey: key,
          },
          true,
        );
        const milestoneEvent: PluginEvent = {
          ...event,
          payload: { ...payload, milestone: "first successful run" },
        };
        await notify(
          milestoneEvent,
          formatOnboardingMilestone,
          config.pipelineChannelId,
        );
      });
    }
    if (config.notifyOnBudgetThreshold) {
      ctx.events.on("cost_event.created", async (event) => {
        const payload = event.payload as Record<string, unknown>;
        const pct = Number(payload.percentUsed ?? 0);
        if (pct < 80) return;
        const bucket = pct >= 100 ? 100 : pct >= 90 ? 90 : 80;
        const key = STATE_KEYS.budgetAlert(event.entityId ?? "", bucket);
        const alreadySent = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: key,
        });
        if (alreadySent) return;
        await ctx.state.set(
          {
            scopeKind: "company",
            scopeId: event.companyId,
            stateKey: key,
          },
          true,
        );
        await notify(event, formatBudgetThreshold, config.pipelineChannelId);
        await ctx.metrics.write("slack.budget_alerts.sent", 1, {
          threshold: String(bucket),
        });
      });
    }

    // =========================================================================
    // Per-company channel overrides
    // =========================================================================
    ctx.data.register("channel-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.slackChannel,
      });
      return { channelId: saved ?? config.defaultChannelId };
    });
    ctx.actions.register("set-channel", async (params) => {
      const companyId = String(params.companyId);
      const channelId = String(params.channelId);
      await ctx.state.set(
        {
          scopeKind: "company",
          scopeId: companyId,
          stateKey: STATE_KEYS.slackChannel,
        },
        channelId,
      );
      ctx.logger.info("Updated Slack channel mapping", { companyId, channelId });
      return { ok: true };
    });

    // =========================================================================
    // Jobs
    // =========================================================================
    // Daily digest. Register the handler unconditionally so the scheduler
    // (driven by the manifest cron) finds it; gate the work on
    // `enableDailyDigest` inside the handler. Without this, instances that
    // leave `enableDailyDigest` at its default (false) log a
    // "No handler registered for job 'daily-digest'" error every day.
    ctx.jobs.register("daily-digest", async () => {
      if (!config.enableDailyDigest) return;
      const companies = await ctx.companies.list({ limit: 100, offset: 0 });
        for (const company of companies) {
          const channelId = await resolveChannel(
            ctx,
            company.id,
            config.defaultChannelId,
          );
          if (!channelId) continue;
          const issues = await ctx.issues.list({
            companyId: company.id,
            limit: 200,
            offset: 0,
          });
          const now = new Date();
          const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          let tasksCompleted = 0;
          let tasksCreated = 0;
          for (const issue of issues) {
            const updated = new Date(issue.updatedAt);
            const created = new Date(issue.createdAt);
            if (issue.status === "done" && updated >= dayAgo) tasksCompleted++;
            if (created >= dayAgo) tasksCreated++;
          }
          const agents = await ctx.agents.list({
            companyId: company.id,
            limit: 100,
            offset: 0,
          });
          const agentsActive = agents.filter(
            (a) => a.status === "active" || a.status === "running",
          ).length;
          const dateKey = now.toISOString().slice(0, 10);
          const dailyCost = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyCost(dateKey),
          });
          const totalCost = dailyCost
            ? String((dailyCost as number).toFixed(2))
            : "0.00";
          const topAgentCosts = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyAgentCosts(dateKey),
          });
          let topAgent = "";
          if (topAgentCosts && typeof topAgentCosts === "object") {
            const costs = topAgentCosts as Record<string, number>;
            let maxCost = 0;
            for (const [name, cost] of Object.entries(costs)) {
              if (cost > maxCost) {
                maxCost = cost;
                topAgent = name;
              }
            }
          }
          await postMessage(
            ctx,
            token,
            channelId,
            formatDailyDigest({
              tasksCompleted,
              tasksCreated,
              agentsActive,
              totalCost,
              topAgent,
            }),
          );
          // Clean up previous day's cost state
          const yesterday = new Date(now.getTime() - 86400000)
            .toISOString()
            .slice(0, 10);
          await ctx.state.delete({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyCost(yesterday),
          });
          await ctx.state.delete({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyAgentCosts(yesterday),
          });
        }
        ctx.logger.info("Daily digest posted to Slack");
        await ctx.metrics.write("slack.digest.sent", 1);
    });
    if (config.enableDailyDigest) {
      // Accumulate costs
      ctx.events.on("cost_event.created", async (event) => {
        const payload = event.payload as Record<string, unknown>;
        const cost = Number(payload.cost ?? 0);
        if (cost <= 0) return;
        const dateKey = new Date().toISOString().slice(0, 10);
        const currentTotal = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.dailyCost(dateKey),
        });
        await ctx.state.set(
          {
            scopeKind: "company",
            scopeId: event.companyId,
            stateKey: STATE_KEYS.dailyCost(dateKey),
          },
          ((currentTotal as number | null) ?? 0) + cost,
        );
        const agentName = String(
          payload.agentName ?? payload.name ?? event.entityId,
        );
        const agentCosts = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.dailyAgentCosts(dateKey),
        });
        const costs =
          (agentCosts as Record<string, number> | null) ?? {};
        costs[agentName] = (costs[agentName] ?? 0) + cost;
        await ctx.state.set(
          {
            scopeKind: "company",
            scopeId: event.companyId,
            stateKey: STATE_KEYS.dailyAgentCosts(dateKey),
          },
          costs,
        );
      });
      ctx.logger.info("Daily digest job registered (9am daily)");
    }
    // Escalation timeout job
    ctx.jobs.register("check-escalation-timeouts", async () => {
      const companies = await ctx.companies.list({ limit: 100, offset: 0 });
      const timeoutMs = config.escalationTimeoutMs ?? 900000;
      const now = Date.now();
      for (const company of companies) {
        const openEscalationsRaw = await ctx.state.get({
          scopeKind: "company",
          scopeId: company.id,
          stateKey: "escalation-records-index",
        });
        const escalationIds = Array.isArray(openEscalationsRaw)
          ? (openEscalationsRaw as string[])
          : [];
        for (const escalationKey of escalationIds) {
          const record = (await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.escalationRecord(escalationKey),
          })) as EscalationRecord | null;
          if (!record || record.status !== "open") continue;
          const createdAt = new Date(String(record.createdAt)).getTime();
          if (now - createdAt < timeoutMs) continue;
          const escalationId = String(record.id);
          const defaultAction = config.escalationDefaultAction ?? "defer";
          await ctx.state.set(
            {
              scopeKind: "company",
              scopeId: company.id,
              stateKey: STATE_KEYS.escalationRecord(escalationId),
            },
            {
              ...record,
              status: "timed_out",
              resolvedAt: new Date().toISOString(),
              resolvedBy: "system:timeout",
            },
          );
          const channelId = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.escalationChannel(escalationId),
          });
          const threadTs = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.escalationTs(escalationId),
          });
          if (channelId && threadTs) {
            await postMessage(
              ctx,
              token,
              String(channelId),
              {
                text: `Escalation timed out - default action: ${defaultAction}`,
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `:hourglass: *Escalation timed out*\nDefault action applied: \`${defaultAction}\``,
                    },
                  },
                ],
              },
              { threadTs: String(threadTs) },
            );
          }
          await ctx.metrics.write("slack.escalations.timed_out", 1, {
            action: defaultAction,
          });
          ctx.logger.info("Escalation timed out", {
            escalationId,
            defaultAction,
          });
        }
      }
    });
    // Phase 5: Check watches job
    ctx.jobs.register("check-watches", async () => {
      const companies = await ctx.companies.list({ limit: 100, offset: 0 });
      for (const company of companies) {
        // Get recent events from state (populated by event listeners below)
        const recentEventsRaw = await ctx.state.get({
          scopeKind: "company",
          scopeId: company.id,
          stateKey: "recent-watch-events",
        });
        const recentEvents = Array.isArray(recentEventsRaw)
          ? (recentEventsRaw as Array<{
              eventType: string;
              payload: Record<string, unknown>;
            }>)
          : [];
        if (recentEvents.length > 0) {
          await checkWatches(ctx, token, company.id, recentEvents);
          // Clear after processing
          await ctx.state.set(
            {
              scopeKind: "company",
              scopeId: company.id,
              stateKey: "recent-watch-events",
            },
            [],
          );
        }
      }
    });

    // =========================================================================
    // Agent output listeners (native streaming + ACP events)
    // =========================================================================
    // Native agent streaming output
    ctx.events.on("plugin.slack.agent-stream-chunk", async (event) => {
      const p = event.payload as Record<string, unknown>;
      await handleAgentOutput(ctx, token, event.companyId, {
        channel: String(p.channel ?? ""),
        threadTs: String(p.threadTs ?? ""),
        text: String(p.text ?? ""),
        agentName: p.agentName != null ? String(p.agentName) : undefined,
        agentDisplayName:
          p.agentDisplayName != null ? String(p.agentDisplayName) : undefined,
        toolName: p.toolName != null ? String(p.toolName) : undefined,
      });
    });
    // ACP output events (from cross-plugin)
    ctx.events.on(`plugin.paperclip-plugin-acp.output`, async (event) => {
      const p = event.payload as Record<string, unknown>;
      await handleAgentOutput(ctx, token, event.companyId, {
        channel: String(p.channel ?? ""),
        threadTs: String(p.threadTs ?? ""),
        text: String(p.text ?? ""),
        agentName: p.agentName != null ? String(p.agentName) : undefined,
        agentDisplayName:
          p.agentDisplayName != null ? String(p.agentDisplayName) : undefined,
        toolName: p.toolName != null ? String(p.toolName) : undefined,
      });
    });
    // Escalation thread reply routing (from Slack Events API)
    ctx.events.on("plugin.slack.thread_reply_escalation", async (event) => {
      const p = event.payload as Record<string, unknown>;
      const escalationId = String(p.escalationId ?? "");
      const replyText = String(p.text ?? "");
      const userId = String(p.userId ?? "unknown");
      if (!escalationId || !replyText) return;
      const record = (await ctx.state.get({
        scopeKind: "company",
        scopeId: event.companyId,
        stateKey: STATE_KEYS.escalationRecord(escalationId),
      })) as
        | (EscalationRecord & {
            sessionId?: string;
            channelId?: string;
            threadTs?: string;
          })
        | null;
      if (record) {
        await ctx.state.set(
          {
            scopeKind: "company",
            scopeId: event.companyId,
            stateKey: STATE_KEYS.escalationRecord(escalationId),
          },
          {
            ...record,
            status: "resolved",
            resolvedAt: new Date().toISOString(),
            resolvedBy: `slack:${userId}`,
          },
        );
      }
      // Route reply to agent session if we have one
      if (record?.sessionId && record?.agentName) {
        const sessions = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.sessionRegistry(
            String(record.channelId ?? ""),
            String(record.threadTs ?? ""),
          ),
        });
        // Find session and send reply back
        if (Array.isArray(sessions)) {
          const session = (sessions as SessionEntry[]).find(
            (s) =>
              s.agentName === String(record.agentName) && s.status === "active",
          );
          if (session && session.transport === "native") {
            await ctx.agents.sessions.sendMessage(
              session.sessionId,
              event.companyId,
              {
                prompt: `Human reply to escalation: ${replyText}`,
                reason: "Escalation reply from Slack",
              },
            );
          }
        }
      }
      await ctx.metrics.write("slack.escalations.resolved", 1, {
        action: "human_reply",
      });
    });
    // Thread message routing (multi-agent + custom commands + media)
    ctx.events.on("plugin.slack.thread_message", async (event) => {
      const p = event.payload as Record<string, unknown>;
      const channel = String(p.channel ?? "");
      const threadTs = String(p.threadTs ?? "");
      const text = String(p.text ?? "");
      const replyToMessageTs =
        p.replyToMessageTs != null ? String(p.replyToMessageTs) : undefined;
      const files = Array.isArray(p.files)
        ? (p.files as Array<Record<string, unknown>>)
        : [];
      if (!channel || !threadTs) return;
      // Phase 3: Check for media files
      for (const file of files) {
        const fileId = String(file.id ?? "");
        const mimetype = String(file.mimetype ?? "");
        if (fileId && isMediaFile(mimetype)) {
          await processMediaFile(
            ctx,
            token,
            event.companyId,
            fileId,
            channel,
            threadTs,
          );
        }
      }
      // Phase 4: Check for custom commands
      if (text) {
        const handled = await tryCustomCommand(
          ctx,
          token,
          event.companyId,
          channel,
          threadTs,
          text,
        );
        if (handled) return;
      }
      // Phase 2: Route to agent sessions
      if (text) {
        await routeMessageToAgent(
          ctx,
          event.companyId,
          channel,
          threadTs,
          text,
          replyToMessageTs,
        );
      }
    });
    // Collect events for watch checking (Phase 5)
    const watchableEvents = [
      "issue.created",
      "issue.updated",
      "agent.run.failed",
      "agent.run.finished",
      "agent.status_changed",
      "cost_event.created",
      "approval.created",
      "issue.thread_interaction.created",
    ] as const;
    for (const eventType of watchableEvents) {
      ctx.events.on(eventType, async (event) => {
        const recentEventsRaw = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: "recent-watch-events",
        });
        const recentEvents = Array.isArray(recentEventsRaw)
          ? (recentEventsRaw as Array<{
              eventType: string;
              payload: Record<string, unknown>;
            }>)
          : [];
        // Keep last 100 events
        recentEvents.push({
          eventType: event.eventType,
          payload: event.payload as Record<string, unknown>,
        });
        if (recentEvents.length > 100) {
          recentEvents.splice(0, recentEvents.length - 100);
        }
        await ctx.state.set(
          {
            scopeKind: "company",
            scopeId: event.companyId,
            stateKey: "recent-watch-events",
          },
          recentEvents,
        );
      });
    }
    slackAdapter = new SlackAdapter(ctx, token);

    // Expose paperclip-user → slack-user mapping to this plugin's UI via
    // usePluginData("slack:resolve-user", { paperclipUserId }). Cross-plugin
    // invocation (e.g. from the Linear plugin) is not yet wired in the SDK
    // — until it is, sibling plugins reach assignees via `issue.created` /
    // `issue.updated` event payloads carrying assigneeUserId, which the
    // subscriber below acts on.
    ctx.data.register("slack:resolve-user", async (params) => {
      const paperclipUserId = (params as { paperclipUserId?: string })
        .paperclipUserId;
      if (!paperclipUserId) {
        return { slackUserId: null, source: "missing-email" };
      }
      return resolveSlackUserId(ctx, token, paperclipUserId);
    });

    // DM the human assignee when an issue is created OR reassigned to a
    // user. Linear-imported issues hit issue.created; UI-driven assignment
    // changes and Linear webhook reassignments hit issue.updated. The
    // Linear plugin resolves assignee email → paperclip user id at create
    // time; the Slack plugin completes the chain by mapping that paperclip
    // user id → slack user id. resolveSlackUserId caches per paperclip
    // user, so the email→Slack lookup runs at most once per assignee per
    // install. Per-(issue, assignee) dedup state prevents double-DMs from
    // racing webhook delivery (Linear can fire issue.create + issue.update
    // close together) and from re-import passes.
    //
    // Backfill caveat: re-running a Linear import that finds existing
    // unassigned Paperclip issues and sets assigneeUserId fires
    // issue.updated with _previous.assigneeUserId === null. Those DM the
    // assignee just like a real-time assignment. Disable
    // notifyAssigneeOnAssignment temporarily before triggering a backfill
    // if you don't want the historical-assignment DMs to go out.
    if (config.notifyAssigneeOnAssignment) {
      const dmAssignee = async (
        event: PluginEvent,
        paperclipUserId: string,
        formatter: (event: PluginEvent) => SlackMessage,
      ) => {
        const dedupRef = {
          scopeKind: "instance" as const,
          stateKey: STATE_KEYS.assigneeDmSent(event.entityId ?? "", paperclipUserId),
        };
        if (await ctx.state.get(dedupRef)) return;

        const resolved = await resolveSlackUserId(ctx, token, paperclipUserId);
        if (!resolved.slackUserId) {
          if (resolved.source === "slack-error") {
            ctx.logger.warn(
              `Skipped assignee DM for issue ${event.entityId}: slack lookup error (${resolved.error ?? "unknown"})`,
            );
          }
          return;
        }

        const result = await postMessage(ctx, token, resolved.slackUserId, formatter(event));
        if (result.ok) {
          await ctx.state.set(dedupRef, true);
          await ctx.metrics.write("slack.assignee_dm.sent", 1, {
            event_type: event.eventType,
          });
        } else {
          await ctx.metrics.write("slack.assignee_dm.failed", 1, {
            event_type: event.eventType,
            error_code: result.error ?? "unknown",
          });
        }
      };

      ctx.events.on("issue.created", async (event) => {
        const payload = event.payload as Record<string, unknown>;
        const assigneeUserId = payload.assigneeUserId;
        if (typeof assigneeUserId !== "string" || !assigneeUserId) return;
        await dmAssignee(event, assigneeUserId, formatAssigneeDmIssueCreated);
      });

      ctx.events.on("issue.updated", async (event) => {
        const payload = event.payload as Record<string, unknown>;
        const patch = (payload.patch as Record<string, unknown> | undefined) ?? {};
        const previous = (payload._previous as Record<string, unknown> | undefined) ?? {};
        // Only act if the patch actually carries a new assigneeUserId. Skip
        // no-op updates and the unassign case (null/empty new value).
        if (!("assigneeUserId" in patch)) return;
        const newAssignee = patch.assigneeUserId;
        if (typeof newAssignee !== "string" || !newAssignee) return;
        if (newAssignee === previous.assigneeUserId) return;
        await dmAssignee(event, newAssignee, formatAssigneeDmIssueCreated);
      });
    }

    ctx.logger.info("Slack Chat OS plugin started (v2.0.0) - all 5 phases active");
  },
  // =========================================================================
  // Webhook handler (Slack Events, Slash Commands, Interactivity)
  // =========================================================================
  async onWebhook(input: PluginWebhookInput) {
    // Verify Slack request signature (skip for url_verification challenge)
    const body = input.parsedBody as Record<string, unknown> | undefined;
    const isVerificationChallenge = body?.type === "url_verification";
    if (
      !isVerificationChallenge &&
      !verifySlackSignature(input.headers, input.rawBody)
    ) {
      pluginCtx.logger.warn("Rejected webhook: invalid Slack signature");
      return;
    }
    // Slack Events API (url_verification + event callbacks)
    if (input.endpointKey === WEBHOOK_KEYS.slackEvents) {
      if (body?.type === "url_verification") {
        return;
      }
      // Handle file_shared events for Phase 3 media pipeline
      if (body?.type === "event_callback") {
        const event = body.event as Record<string, unknown> | undefined;
        if (event?.type === "file_shared") {
          const companies = await pluginCtx.companies.list({
            limit: 1,
            offset: 0,
          });
          const companyId = companies[0]?.id ?? "";
          const fileId = String(event.file_id ?? "");
          const channelId = String(event.channel_id ?? "");
          if (fileId && channelId) {
            await processMediaFile(
              pluginCtx,
              pluginToken,
              companyId,
              fileId,
              channelId,
              "",
            );
          }
        }
      }
    }
    // Slash commands
    if (input.endpointKey === WEBHOOK_KEYS.slashCommand) {
      await handleSlashCommand(pluginCtx, input.rawBody);
      return;
    }
    // Interactivity (button clicks)
    if (input.endpointKey === WEBHOOK_KEYS.interactivity) {
      const payload = (
        body?.payload
          ? JSON.parse(String(body.payload))
          : body
      ) as Record<string, unknown> | undefined;
      if (!payload || payload.type !== "block_actions") return;
      const actions = payload.actions as
        | Array<Record<string, unknown>>
        | undefined;
      const responseUrl = String(payload.response_url ?? "");
      const user = payload.user as Record<string, unknown> | undefined;
      const userId = user
        ? String(user.id ?? user.username ?? "unknown")
        : "unknown";
      if (!actions?.length || !responseUrl) return;
      const action = actions[0];
      const actionId = String(action.action_id ?? "");
      const actionValue = String(action.value ?? "");
      if (!actionValue) return;
      const companies = await pluginCtx.companies.list({
        limit: 1,
        offset: 0,
      });
      const companyId = companies[0]?.id ?? "";
      // --- Approval buttons ---
      if (actionId === "approval_approve" || actionId === "approval_reject") {
        const approved = actionId === "approval_approve";
        const endpoint = approved ? "approve" : "reject";
        try {
          await pluginCtx.http.fetch(
            `${pluginConfig.paperclipBaseUrl}/api/approvals/${actionValue}/${endpoint}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                decidedByUserId: `slack:${userId}`,
              }),
            },
          );
          await respondToAction(
            pluginCtx,
            pluginToken,
            responseUrl,
            formatApprovalResolved(actionValue, approved, userId),
          );
          await pluginCtx.metrics.write("slack.approvals.decided", 1, {
            decision: endpoint,
          });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle approval action", {
            err,
            approvalId: actionValue,
          });
        }
        return;
      }
      // --- Escalation buttons ---
      if (
        actionId === "escalation_use_suggested" ||
        actionId === "escalation_reply" ||
        actionId === "escalation_override" ||
        actionId === "escalation_dismiss"
      ) {
        try {
          const record = (await pluginCtx.state.get({
            scopeKind: "company",
            scopeId: companyId,
            stateKey: STATE_KEYS.escalationRecord(actionValue),
          })) as EscalationRecord | null;
          if (record) {
            await pluginCtx.state.set(
              {
                scopeKind: "company",
                scopeId: companyId,
                stateKey: STATE_KEYS.escalationRecord(actionValue),
              },
              {
                ...record,
                status: "resolved",
                resolvedAt: new Date().toISOString(),
                resolvedBy: `slack:${userId}`,
              },
            );
          }
          await respondToAction(
            pluginCtx,
            pluginToken,
            responseUrl,
            formatEscalationResolved(actionValue, actionId, userId),
          );
          await pluginCtx.metrics.write("slack.escalations.resolved", 1, {
            action: actionId,
          });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle escalation action", {
            err,
            escalationId: actionValue,
          });
        }
        return;
      }
      // --- Handoff buttons ---
      if (actionId === "handoff_approve" || actionId === "handoff_reject") {
        try {
          const approved = actionId === "handoff_approve";
          await handleHandoffAction(
            pluginCtx,
            pluginToken,
            companyId,
            actionValue,
            approved,
            userId,
          );
          const emoji = approved ? ":white_check_mark:" : ":x:";
          const label = approved ? "Approved" : "Rejected";
          await respondToAction(pluginCtx, pluginToken, responseUrl, {
            text: `Handoff ${label} by ${userId}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `${emoji} *Handoff ${label}* by <@${userId}>`,
                },
              },
            ],
          });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle handoff action", {
            err,
            handoffId: actionValue,
          });
        }
        return;
      }
      // --- Discussion loop buttons ---
      if (
        actionId === "discussion_continue" ||
        actionId === "discussion_stop"
      ) {
        try {
          const discAction =
            actionId === "discussion_continue" ? "continue" : "stop";
          await handleDiscussionAction(
            pluginCtx,
            pluginToken,
            companyId,
            actionValue,
            discAction,
            userId,
          );
          const emoji =
            discAction === "continue" ? ":arrow_forward:" : ":stop_button:";
          const label = discAction === "continue" ? "Resumed" : "Stopped";
          await respondToAction(pluginCtx, pluginToken, responseUrl, {
            text: `Discussion ${label} by ${userId}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `${emoji} *Discussion ${label}* by <@${userId}>`,
                },
              },
            ],
          });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle discussion action", {
            err,
            discussionId: actionValue,
          });
        }
        return;
      }
      // --- Command step approval buttons (Phase 4) ---
      if (
        actionId === "command_step_approve" ||
        actionId === "command_step_reject"
      ) {
        const approved = actionId === "command_step_approve";
        const emoji = approved ? ":white_check_mark:" : ":x:";
        const label = approved ? "Approved" : "Rejected";
        await respondToAction(pluginCtx, pluginToken, responseUrl, {
          text: `Step ${label} by ${userId}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${emoji} *Step ${label}* by <@${userId}>`,
              },
            },
          ],
        });
        return;
      }
    }
  },
  onValidateConfig: validateSlackConfig,
  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;

// Start the RPC host unconditionally. The SDK's runWorker(plugin, import.meta.url)
// helper gates on a path match between argv[1] and the module URL, which fails
// when the host spawns the worker via a symlinked install dir (the symlink target
// resolves but argv[1] stays as the symlink path). startWorkerRpcHost bypasses
// that check; safe because this file is only ever loaded as the worker entrypoint.
if (!process.env.VITEST) {
  startWorkerRpcHost({ plugin });
}
