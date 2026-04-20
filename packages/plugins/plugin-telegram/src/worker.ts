import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, DEFAULT_CONFIG, METRIC_NAMES, ACP_SPAWN_EVENT, ACP_OUTPUT_EVENT } from "./constants.js";
import { sendMessage, escapeMarkdownV2, setMyCommands, answerCallbackQuery } from "./telegram-api.js";
import type { SendMessageOptions } from "./telegram-api.js";
import { handleCommand, resolveCompanyId, getTopicForProject, BOT_COMMANDS } from "./commands.js";
import { handleCommandsCommand, tryCustomCommand } from "./command-registry.js";
import { formatIssueCreated, formatIssueDone, formatApprovalCreated, formatAgentError } from "./formatters.js";
import { EscalationManager } from "./escalation.js";
import { handleMediaMessage } from "./media-pipeline.js";
import { handleRegisterWatch, checkWatches } from "./watch-registry.js";
import { getSessions, setupAcpOutputListener, routeMessageToAgent } from "./acp-bridge.js";
import type {
  TelegramUpdate,
  TelegramCallbackQuery,
  TelegramMessage,
  IssueEventPayload,
  AgentRunEventPayload,
  AcpOutputEvent,
  EscalateToolParams,
  EscalationEvent,
  MessageMapping,
  RegisterWatchParams,
} from "./types.js";

type TelegramConfig = typeof DEFAULT_CONFIG;

let currentContext: PluginContext | null = null;
const escalationManager = new EscalationManager();

async function getConfig(ctx: PluginContext): Promise<TelegramConfig> {
  const raw = (await ctx.config.get()) as Partial<TelegramConfig> | null;
  return { ...DEFAULT_CONFIG, ...raw };
}

async function getBotToken(ctx: PluginContext, config: TelegramConfig): Promise<string> {
  if (!config.telegramBotTokenRef) {
    throw new Error("Telegram bot token secret reference is not configured.");
  }
  return ctx.secrets.resolve(config.telegramBotTokenRef);
}

// ---------------------------------------------------------------------------
// Outbound notification helpers
// ---------------------------------------------------------------------------

async function notifyChat(
  ctx: PluginContext,
  token: string,
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
  projectName?: string,
): Promise<void> {
  const config = await getConfig(ctx);
  let threadId: number | undefined;
  if (config.topicRouting && projectName) {
    threadId = await getTopicForProject(ctx, chatId, projectName);
  }
  await sendMessage(ctx, token, chatId, text, { ...options, messageThreadId: threadId });
}

// ---------------------------------------------------------------------------
// Inbound webhook processing
// ---------------------------------------------------------------------------

async function processUpdate(
  ctx: PluginContext,
  token: string,
  update: TelegramUpdate,
  config: TelegramConfig,
): Promise<void> {
  // Callback queries (inline button presses)
  if (update.callback_query) {
    await handleCallbackQuery(ctx, token, update.callback_query, config);
    return;
  }

  const msg = update.message ?? update.edited_message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const text = (msg.text ?? "").trim();
  const threadId = msg.message_thread_id;

  // Bot commands
  if (text.startsWith("/") && config.enableCommands) {
    const match = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)/s);
    if (match) {
      const [, cmd, args] = match;
      // Custom commands routing
      if (cmd === "commands") {
        const companyId = await resolveCompanyId(ctx, chatId);
        await handleCommandsCommand(ctx, token, chatId, args, threadId, companyId);
        return;
      }
      // Try custom command first, then fall back to built-in
      const companyId = await resolveCompanyId(ctx, chatId);
      const handled = await tryCustomCommand(ctx, token, chatId, cmd, args, threadId, companyId);
      if (!handled) {
        await handleCommand(ctx, token, chatId, cmd, args, threadId, config.paperclipBaseUrl);
      }
      return;
    }
  }

  // Media messages
  if (msg.photo || msg.voice || msg.audio || msg.video_note || msg.document) {
    const companyId = await resolveCompanyId(ctx, chatId);
    const handled = await handleMediaMessage(
      ctx,
      token,
      msg,
      {
        briefAgentId: config.briefAgentId,
        briefAgentChatIds: config.briefAgentChatIds,
        transcriptionApiKeyRef: config.transcriptionApiKeyRef,
      },
      companyId,
    );
    if (handled) return;
  }

  // Inbound text routing to active sessions or issue comments
  if (text && config.enableInbound) {
    await routeInboundMessage(ctx, token, chatId, text, msg, threadId);
  }
}

async function routeInboundMessage(
  ctx: PluginContext,
  token: string,
  chatId: string,
  text: string,
  msg: TelegramMessage,
  threadId?: number,
): Promise<void> {
  // Check for active agent sessions in this thread
  const sessions = await getSessions(ctx, chatId, threadId);
  const activeSessions = sessions.filter((s) => s.status === "active");

  if (activeSessions.length > 0) {
    const target = activeSessions.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    )[0];

    if (target.transport === "native") {
      try {
        const companyId = await resolveCompanyId(ctx, chatId);
        await ctx.agents.sessions.sendMessage(target.sessionId, companyId, {
          prompt: text,
          reason: "telegram_inbound",
        });
      } catch (err) {
        ctx.logger.error("Failed to route to native session", { error: String(err) });
      }
    } else {
      const companyId = await resolveCompanyId(ctx, chatId);
      ctx.events.emit(ACP_SPAWN_EVENT, companyId, {
        type: "message",
        sessionId: target.sessionId,
        chatId,
        threadId,
        text,
      });
    }
    await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
    return;
  }

  // Check if this is a reply to a notification (escalation or issue)
  if (msg.reply_to_message) {
    const replyMsgId = msg.reply_to_message.message_id;
    const mapping = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: `msg_${chatId}_${replyMsgId}`,
    })) as MessageMapping | null;

    if (mapping?.entityType === "escalation") {
      await escalationManager.respond(ctx, token, mapping.entityId, {
        escalationId: mapping.entityId,
        responderId: `telegram:${msg.from?.username ?? msg.from?.id ?? chatId}`,
        responseText: text,
        action: "reply_to_customer",
      });
      return;
    }

    if (mapping?.entityType === "issue" && mapping?.entityId) {
      try {
        await ctx.issues.createComment(
          mapping.entityId,
          `[Telegram] ${msg.from?.username ?? "Unknown"}: ${text}`,
          mapping.companyId,
        );
        await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
      } catch (err) {
        ctx.logger.error("Failed to route reply to issue comment", { error: String(err) });
      }
      return;
    }
  }
}

async function handleCallbackQuery(
  ctx: PluginContext,
  token: string,
  query: TelegramCallbackQuery,
  config: TelegramConfig,
): Promise<void> {
  const data = query.data ?? "";
  const actor = query.from?.username ?? String(query.from?.id) ?? "unknown";
  const callbackQueryId = query.id;
  const chatId = query.message?.chat?.id ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;

  // Approval buttons
  if (data.startsWith("approve_") || data.startsWith("reject_")) {
    const [action, approvalId] = data.split("_", 2);
    if (approvalId) {
      try {
        const baseUrl = config.paperclipBaseUrl;
        const endpoint = action === "approve" ? "approve" : "reject";
        await ctx.http.fetch(`${baseUrl}/api/approvals/${approvalId}/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
        });
        await answerCallbackQuery(ctx, token, callbackQueryId, `${action === "approve" ? "Approved" : "Rejected"}!`);
      } catch (err) {
        await answerCallbackQuery(ctx, token, callbackQueryId, `Failed: ${String(err)}`);
      }
    }
    return;
  }

  // Escalation buttons
  if (data.startsWith("esc_")) {
    const parts = data.split("_");
    const action = parts[1]; // suggested, reply, override, dismiss
    const escalationId = parts.slice(2).join("_");
    await escalationManager.handleCallback(ctx, token, action, escalationId, actor, callbackQueryId, chatId, messageId);
    await answerCallbackQuery(ctx, token, callbackQueryId, "Processing...");
    return;
  }

  // Command approval buttons
  if (data.startsWith("cmd_approve_") || data.startsWith("cmd_reject_")) {
    await answerCallbackQuery(ctx, token, callbackQueryId, "Noted");
    return;
  }

  await answerCallbackQuery(ctx, token, callbackQueryId, "Unknown action");
}

// ---------------------------------------------------------------------------
// Event handlers (Paperclip → Telegram notifications)
// ---------------------------------------------------------------------------

function subscribeToEvents(ctx: PluginContext, token: string, config: TelegramConfig): void {
  if (config.notifyOnIssueCreated) {
    ctx.events.on("issue.created", async (event) => {
      const chatId = config.defaultChatId;
      if (!chatId) return;
      const { text, options } = formatIssueCreated(event);
      const projectName = (event.payload as IssueEventPayload)?.projectName;
      await notifyChat(ctx, token, chatId, text, options, projectName);
      // Store message mapping for reply routing
    });
  }

  if (config.notifyOnIssueDone) {
    ctx.events.on("issue.updated", async (event) => {
      const p = event.payload as IssueEventPayload;
      if (p?.status !== "done") return;
      const chatId = config.defaultChatId;
      if (!chatId) return;
      const { text, options } = formatIssueDone(event);
      await notifyChat(ctx, token, chatId, text, options);
    });
  }

  if (config.notifyOnApprovalCreated) {
    ctx.events.on("approval.created", async (event) => {
      const chatId = config.approvalsChatId || config.defaultChatId;
      if (!chatId) return;
      const { text, options } = formatApprovalCreated(event);
      const msgId = await sendMessage(ctx, token, chatId, text, options);
      if (msgId && event.entityId) {
        await ctx.state.set({ scopeKind: "instance", stateKey: `msg_${chatId}_${msgId}` }, {
          entityId: event.entityId,
          entityType: "approval",
          companyId: event.companyId,
          eventType: "approval.created",
        } satisfies MessageMapping);
      }
    });
  }

  if (config.notifyOnAgentError) {
    ctx.events.on("agent.run.failed", async (event) => {
      const chatId = config.errorsChatId || config.defaultChatId;
      if (!chatId) return;
      const { text, options } = formatAgentError(event);
      await sendMessage(ctx, token, chatId, text, options);
    });
  }

  // Escalation events (custom plugin event)
  ctx.events.on("plugin.paperclip-plugin-telegram.escalation", async (event) => {
    const chatId = config.escalationChatId || config.defaultChatId;
    if (!chatId) return;
    await escalationManager.create(ctx, token, event.payload as EscalationEvent, chatId);
    await ctx.metrics.write(METRIC_NAMES.escalationsCreated, 1);
  });

  // ACP output events — relay agent output to Telegram
  ctx.events.on(ACP_OUTPUT_EVENT, async (event) => {
    const payload = event.payload as AcpOutputEvent;
    if (!payload?.chatId || !payload?.text) return;
    await sendMessage(ctx, token, payload.chatId, escapeMarkdownV2(payload.text), {
      parseMode: "MarkdownV2",
      messageThreadId: payload.threadId ? Number(payload.threadId) : undefined,
    });
  });
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function registerToolHandlers(ctx: PluginContext, token: string, config: TelegramConfig): void {
  ctx.tools.register(
    "escalate_to_human",
    {
      displayName: "Escalate to Human",
      description: "Escalate a conversation to a human when you cannot handle it confidently",
      parametersSchema: { type: "object" },
    },
    async (params) => {
      const p = params as EscalateToolParams;
      const chatId = config.escalationChatId || config.defaultChatId;
      if (!chatId) return { error: "No escalation chat configured" };

      const event: EscalationEvent = {
        escalationId: `esc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        agentId: p.agentId ?? "unknown",
        companyId: p.companyId ?? "",
        reason: p.reason ?? "explicit_request",
        context: {
          agentReasoning: p.reasoning ?? "",
          suggestedReply: p.suggestedReply ?? "",
          suggestedActions: p.suggestedActions ?? [],
          confidenceScore: p.confidenceScore ?? null,
        },
        originChatId: p.chatId,
        originThreadId: p.threadId,
        originMessageId: p.messageId,
        timeout: {
          durationMs: config.escalationTimeoutMs,
          defaultAction: config.escalationDefaultAction,
        },
        transport: p.transport ?? "native",
        sessionId: p.sessionId,
      };

      await escalationManager.create(ctx, token, event, chatId);
      return { content: JSON.stringify({ status: "escalated", escalationId: event.escalationId }) };
    },
  );

  ctx.tools.register(
    "register_watch",
    {
      displayName: "Register Watch",
      description: "Register a proactive watch that monitors entities and sends suggestions",
      parametersSchema: { type: "object" },
    },
    async (params) => {
      const p = params as RegisterWatchParams;
      const companyId = p.companyId ?? "";
      return await handleRegisterWatch(ctx, p, companyId);
    },
  );
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

function registerJobHandlers(ctx: PluginContext, token: string, config: TelegramConfig): void {
  ctx.jobs.register("telegram-daily-digest", async () => {
    if (!config.dailyDigestEnabled || !config.defaultChatId) return;

    try {
      const companies = await ctx.companies.list();
      for (const company of companies) {
        const agents = await ctx.agents.list({ companyId: company.id });
        const issues = await ctx.issues.list({ companyId: company.id, limit: 20 });
        const active = agents.filter((a) => a.status === "active" || a.status === "running");
        const done = issues.filter((i) => i.status === "done");
        const inProgress = issues.filter((i) => i.status === "in_progress");

        const lines = [
          escapeMarkdownV2("\ud83d\udcca") + ` *Daily Digest: ${escapeMarkdownV2(company.name)}*`,
          "",
          `${escapeMarkdownV2("\ud83e\udd16")} Agents: *${active.length}* active of ${escapeMarkdownV2(String(agents.length))}`,
          `${escapeMarkdownV2("\ud83d\udccb")} Issues: *${escapeMarkdownV2(String(inProgress.length))}* in progress, *${escapeMarkdownV2(String(done.length))}* done`,
        ];

        if (inProgress.length > 0) {
          lines.push("", `${escapeMarkdownV2("\ud83d\udd04")} *In Progress:*`);
          for (const issue of inProgress.slice(0, 5)) {
            const id = issue.identifier ?? issue.id;
            lines.push(`  ${escapeMarkdownV2("-")} ${escapeMarkdownV2(id)}: ${escapeMarkdownV2(issue.title)}`);
          }
        }

        await sendMessage(ctx, token, config.defaultChatId, lines.join("\n"), {
          parseMode: "MarkdownV2",
        });
      }
    } catch (err) {
      ctx.logger.error("Daily digest failed", { error: String(err) });
    }
  });

  ctx.jobs.register("check-escalation-timeouts", async () => {
    await escalationManager.checkTimeouts(ctx, token);
  });

  ctx.jobs.register("check-watches", async () => {
    await checkWatches(ctx, token, {
      maxSuggestionsPerHourPerCompany: config.maxSuggestionsPerHourPerCompany,
      watchDeduplicationWindowMs: config.watchDeduplicationWindowMs,
    });
  });
}

// ---------------------------------------------------------------------------
// Webhook route handler
// ---------------------------------------------------------------------------

function registerWebhookRoute(ctx: PluginContext, token: string, config: TelegramConfig): void {
  // The plugin host delivers inbound webhook POSTs as events
  ctx.events.on("plugin.paperclip-plugin-telegram.webhook", async (event) => {
    try {
      await processUpdate(ctx, token, event.payload as TelegramUpdate, config);
    } catch (err) {
      ctx.logger.error("Webhook processing error", { error: String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    ctx.logger.info("Telegram plugin initializing", { pluginId: PLUGIN_ID });

    const config = await getConfig(ctx);
    let token: string;
    try {
      token = await getBotToken(ctx, config);
    } catch (err) {
      ctx.logger.error("Failed to resolve bot token", { error: String(err) });
      return;
    }

    // Register bot commands with Telegram
    await setMyCommands(ctx, token, BOT_COMMANDS);

    // Wire up event subscriptions, tools, jobs, webhook
    subscribeToEvents(ctx, token, config);
    registerToolHandlers(ctx, token, config);
    registerJobHandlers(ctx, token, config);
    registerWebhookRoute(ctx, token, config);

    ctx.logger.info("Telegram plugin setup complete");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) {
      return { status: "degraded", message: "Plugin context not initialized" };
    }
    try {
      const config = await getConfig(ctx);
      if (!config.telegramBotTokenRef) {
        return { status: "degraded", message: "Telegram bot token not configured" };
      }
      if (!config.defaultChatId) {
        return { status: "degraded", message: "Default chat ID not configured" };
      }
      return { status: "ok", message: "Telegram plugin active" };
    } catch (err) {
      return {
        status: "degraded",
        message: `Config error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  async onValidateConfig(config) {
    const c = config as Partial<TelegramConfig>;
    const errors: string[] = [];
    if (!c.telegramBotTokenRef) errors.push("telegramBotTokenRef is required");
    if (!c.defaultChatId) errors.push("defaultChatId is required");
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true };
  },
});

runWorker(plugin, import.meta.url);
