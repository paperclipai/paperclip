import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Telegram Bot API types (subset needed for ingress)
// ---------------------------------------------------------------------------

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  message_thread_id?: number;
  reply_to_message?: TelegramMessage;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
  description?: string;
}

interface TelegramGetMeResponse {
  ok: boolean;
  result: TelegramUser;
}

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

interface IngressConfig {
  botTokenSecretRef: string;
  targetCompanyId: string;
  directorAgentId: string;
  directorDisplayName: string;
  targetProjectId?: string;
  targetGoalId?: string;
}

function parseConfig(raw: Record<string, unknown>): IngressConfig | null {
  if (typeof raw.botTokenSecretRef !== "string" || !raw.botTokenSecretRef) return null;
  if (typeof raw.targetCompanyId !== "string" || !raw.targetCompanyId) return null;
  if (typeof raw.directorAgentId !== "string" || !raw.directorAgentId) return null;
  return {
    botTokenSecretRef: raw.botTokenSecretRef,
    targetCompanyId: raw.targetCompanyId,
    directorAgentId: raw.directorAgentId,
    directorDisplayName:
      typeof raw.directorDisplayName === "string" && raw.directorDisplayName
        ? raw.directorDisplayName
        : "Director",
    targetProjectId:
      typeof raw.targetProjectId === "string" && raw.targetProjectId
        ? raw.targetProjectId
        : undefined,
    targetGoalId:
      typeof raw.targetGoalId === "string" && raw.targetGoalId
        ? raw.targetGoalId
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEGRAM_API = "https://api.telegram.org";
const STATE_KEY_OFFSET = "telegram-update-offset";
const STATE_KEY_BOT_USERNAME = "telegram-bot-username";
const CONV_STATE_NAMESPACE = "conversations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Telegram message deep link when possible. */
function telegramDeepLink(chat: TelegramChat, messageId: number): string | null {
  if (chat.username) {
    return `https://t.me/${chat.username}/${messageId}`;
  }
  // For supergroups, the chat ID is negative and typically -100<groupId>.
  // Deep links use the positive portion: https://t.me/c/<groupId>/<messageId>
  if (chat.type === "supergroup" || chat.type === "channel") {
    const positiveId = String(chat.id).replace(/^-100/, "");
    return `https://t.me/c/${positiveId}/${messageId}`;
  }
  return null;
}

/** Format a Telegram user as a display string. */
function formatSender(user: TelegramUser | undefined): string {
  if (!user) return "unknown";
  const parts = [user.first_name];
  if (user.last_name) parts.push(user.last_name);
  if (user.username) parts.push(`(@${user.username})`);
  return parts.join(" ");
}

/** Format chat identity for display. */
function formatChat(chat: TelegramChat): string {
  if (chat.type === "private") return "Private chat";
  const name = chat.title ?? chat.username ?? String(chat.id);
  return `${name} (${chat.type})`;
}

/**
 * Determine if a message is "directed" at the bot.
 * - Private messages: always directed.
 * - Group messages: directed if the bot is @-mentioned in entities.
 */
function isDirectedAtBot(
  msg: TelegramMessage,
  botUsername: string,
): boolean {
  // Private chats — every message is directed
  if (msg.chat.type === "private") return true;

  // Check text entities for @mention of the bot
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const text = msg.text ?? msg.caption ?? "";
  const lowerBot = botUsername.toLowerCase();

  for (const entity of entities) {
    if (entity.type === "mention") {
      // Extract the @username from the text
      const mention = text.slice(entity.offset, entity.offset + entity.length);
      if (mention.toLowerCase() === `@${lowerBot}`) return true;
    }
    if (entity.type === "text_mention" && entity.user?.username) {
      if (entity.user.username.toLowerCase() === lowerBot) return true;
    }
  }

  return false;
}

/**
 * Derive a conversation key for state persistence.
 *
 * Strategy (per DSPA-904 spec):
 *   key = (chatId, messageThreadId || reply-root || first-directed-message)
 *
 * - Private chat: `priv:<chatId>` — one issue per private conversation
 * - Group with topic (message_thread_id): `topic:<chatId>:<threadId>`
 * - Group reply: `reply:<chatId>:<reply_to_message_id>` — chains resolved via state lookup
 * - Group standalone: `msg:<chatId>:<message_id>` — starts a new conversation
 */
function deriveConversationKey(msg: TelegramMessage): string {
  const chatId = msg.chat.id;
  if (msg.chat.type === "private") {
    return `priv:${chatId}`;
  }
  if (msg.message_thread_id) {
    return `topic:${chatId}:${msg.message_thread_id}`;
  }
  if (msg.reply_to_message) {
    return `reply:${chatId}:${msg.reply_to_message.message_id}`;
  }
  return `msg:${chatId}:${msg.message_id}`;
}

/**
 * Build the Paperclip comment body for an ingress message.
 * Includes @Director mention, sender, chat identity, message info, and text.
 */
function buildCommentBody(
  msg: TelegramMessage,
  config: IngressConfig,
): string {
  const mention = `[@${config.directorDisplayName}](agent://${config.directorAgentId})`;
  const sender = formatSender(msg.from);
  const chatInfo = formatChat(msg.chat);
  const text = msg.text ?? msg.caption ?? "(no text content)";
  const deepLink = telegramDeepLink(msg.chat, msg.message_id);
  const msgIdDisplay = deepLink
    ? `[${msg.message_id}](${deepLink})`
    : String(msg.message_id);

  const lines: string[] = [
    `${mention} **Telegram from ${sender}:**`,
    "",
    `**Chat:** ${chatInfo}`,
  ];

  if (msg.message_thread_id) {
    lines.push(`**Thread:** ${msg.message_thread_id}`);
  }

  lines.push(`**Message ID:** ${msgIdDisplay}`);

  if (msg.reply_to_message) {
    const replyLink = telegramDeepLink(msg.chat, msg.reply_to_message.message_id);
    const replyDisplay = replyLink
      ? `[${msg.reply_to_message.message_id}](${replyLink})`
      : String(msg.reply_to_message.message_id);
    const replyPreview = (msg.reply_to_message.text ?? "").slice(0, 100);
    lines.push(`**Reply to:** ${replyDisplay}${replyPreview ? ` — "${replyPreview}"` : ""}`);
  }

  lines.push("", `> ${text.split("\n").join("\n> ")}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core polling logic
// ---------------------------------------------------------------------------

async function resolveBotUsername(
  ctx: PluginContext,
  botToken: string,
): Promise<string | null> {
  // Check cached username first
  const cached = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEY_BOT_USERNAME,
  });
  if (typeof cached === "string" && cached) return cached;

  // Fetch from Telegram API
  const resp = await ctx.http.fetch(`${TELEGRAM_API}/bot${botToken}/getMe`);
  if (!resp.ok) {
    ctx.logger.error("Failed to call getMe", { status: resp.status });
    return null;
  }
  const data = (await resp.json()) as TelegramGetMeResponse;
  if (!data.ok || !data.result.username) return null;

  // Cache it
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEY_BOT_USERNAME },
    data.result.username,
  );
  return data.result.username;
}

/**
 * Resolve an existing Paperclip issue ID for a conversation key.
 * Handles reply-chain propagation: if the direct key has no mapping,
 * tries the reply-to message's mapping.
 */
async function resolveConversationIssue(
  ctx: PluginContext,
  msg: TelegramMessage,
  convKey: string,
): Promise<string | null> {
  // Direct lookup for the derived key
  const direct = await ctx.state.get({
    scopeKind: "instance",
    namespace: CONV_STATE_NAMESPACE,
    stateKey: convKey,
  });
  if (typeof direct === "string" && direct) return direct;

  // For reply-type keys, also check the message being replied to.
  // This propagates conversation mapping through reply chains.
  if (msg.reply_to_message) {
    const replyKey = `msg:${msg.chat.id}:${msg.reply_to_message.message_id}`;
    const replyMapping = await ctx.state.get({
      scopeKind: "instance",
      namespace: CONV_STATE_NAMESPACE,
      stateKey: replyKey,
    });
    if (typeof replyMapping === "string" && replyMapping) return replyMapping;

    // Also try topic key if the reply-to had a thread
    if (msg.reply_to_message.message_thread_id) {
      const topicKey = `topic:${msg.chat.id}:${msg.reply_to_message.message_thread_id}`;
      const topicMapping = await ctx.state.get({
        scopeKind: "instance",
        namespace: CONV_STATE_NAMESPACE,
        stateKey: topicKey,
      });
      if (typeof topicMapping === "string" && topicMapping) return topicMapping;
    }
  }

  return null;
}

/** Store conversation-to-issue mapping in state. */
async function storeConversationMapping(
  ctx: PluginContext,
  convKey: string,
  issueId: string,
  msg: TelegramMessage,
): Promise<void> {
  // Map the conversation key
  await ctx.state.set(
    { scopeKind: "instance", namespace: CONV_STATE_NAMESPACE, stateKey: convKey },
    issueId,
  );
  // Also map by this message's ID so future replies can find it
  const msgKey = `msg:${msg.chat.id}:${msg.message_id}`;
  if (msgKey !== convKey) {
    await ctx.state.set(
      { scopeKind: "instance", namespace: CONV_STATE_NAMESPACE, stateKey: msgKey },
      issueId,
    );
  }
}

async function pollTelegram(ctx: PluginContext, job: PluginJobContext): Promise<void> {
  const rawConfig = await ctx.config.get();
  const config = parseConfig(rawConfig);
  if (!config) {
    ctx.logger.warn("telegram-ingress: missing or invalid config, skipping poll");
    return;
  }

  const botToken = await ctx.secrets.resolve(config.botTokenSecretRef);
  if (!botToken) {
    ctx.logger.error("telegram-ingress: failed to resolve bot token secret");
    return;
  }

  // Resolve bot username (needed for mention detection in groups)
  const botUsername = await resolveBotUsername(ctx, botToken);
  if (!botUsername) {
    ctx.logger.error("telegram-ingress: could not determine bot username via getMe");
    return;
  }

  // Read the update offset cursor
  const rawOffset = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEY_OFFSET,
  });
  let offset = typeof rawOffset === "number" ? rawOffset : 0;

  // Fetch new updates from Telegram
  const resp = await ctx.http.fetch(
    `${TELEGRAM_API}/bot${botToken}/getUpdates`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset, limit: 100, timeout: 0 }),
    },
  );
  if (!resp.ok) {
    ctx.logger.error("telegram-ingress: getUpdates failed", {
      status: resp.status,
    });
    return;
  }

  const data = (await resp.json()) as TelegramGetUpdatesResponse;
  if (!data.ok) {
    ctx.logger.error("telegram-ingress: Telegram API error", {
      description: data.description,
    });
    return;
  }

  if (!data.result.length) {
    ctx.logger.debug("telegram-ingress: no new updates");
    return;
  }

  let processed = 0;

  for (const update of data.result) {
    // Always advance the cursor past this update, even if we skip it
    offset = update.update_id + 1;

    // Only process messages (not edited_message, callback_query, etc.)
    const msg = update.message;
    if (!msg) continue;

    // Skip messages without text content
    if (!msg.text && !msg.caption) continue;

    // Skip messages not directed at the bot
    if (!isDirectedAtBot(msg, botUsername)) continue;

    // Derive conversation key and resolve existing issue
    const convKey = deriveConversationKey(msg);
    const existingIssueId = await resolveConversationIssue(ctx, msg, convKey);

    if (existingIssueId) {
      // Append comment to existing conversation issue
      const body = buildCommentBody(msg, config);
      await ctx.issues.createComment(
        existingIssueId,
        body,
        config.targetCompanyId,
      );
      // Also map this message ID for future reply-chain lookups
      await storeConversationMapping(ctx, convKey, existingIssueId, msg);

      ctx.logger.info("telegram-ingress: appended comment to existing issue", {
        issueId: existingIssueId,
        convKey,
        messageId: msg.message_id,
      });
    } else {
      // Create a new issue for this conversation
      const sender = formatSender(msg.from);
      const chatInfo = formatChat(msg.chat);
      const text = msg.text ?? msg.caption ?? "(no text)";

      const issue = await ctx.issues.create({
        companyId: config.targetCompanyId,
        projectId: config.targetProjectId,
        goalId: config.targetGoalId,
        title: `Telegram: ${sender} in ${chatInfo}`.slice(0, 200),
        description: [
          `Ingress conversation from Telegram.`,
          "",
          `**Sender:** ${sender}`,
          `**Chat:** ${chatInfo}`,
          `**Started:** ${new Date(msg.date * 1000).toISOString()}`,
          "",
          `> ${text.split("\n").join("\n> ")}`,
        ].join("\n"),
      });

      // Store conversation mapping
      await storeConversationMapping(ctx, convKey, issue.id, msg);

      // Post the first comment with @Director mention to trigger a wake
      const body = buildCommentBody(msg, config);
      await ctx.issues.createComment(issue.id, body, config.targetCompanyId);

      ctx.logger.info("telegram-ingress: created new issue for conversation", {
        issueId: issue.id,
        convKey,
        messageId: msg.message_id,
      });
    }

    processed++;
  }

  // Persist the updated cursor
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEY_OFFSET },
    offset,
  );

  if (processed > 0) {
    ctx.logger.info("telegram-ingress: poll complete", {
      updatesReceived: data.result.length,
      directedProcessed: processed,
      newOffset: offset,
      runId: job.runId,
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("telegram-ingress: plugin starting");

    ctx.jobs.register("poll-telegram", async (job: PluginJobContext) => {
      await pollTelegram(ctx, job);
    });
  },

  async onHealth() {
    return { status: "ok", message: "telegram-ingress ready" };
  },

  async onValidateConfig(config: unknown) {
    const cfg = config as Record<string, unknown>;
    const errors: string[] = [];
    if (!cfg.botTokenSecretRef || typeof cfg.botTokenSecretRef !== "string") {
      errors.push("botTokenSecretRef is required");
    }
    if (!cfg.targetCompanyId || typeof cfg.targetCompanyId !== "string") {
      errors.push("targetCompanyId is required");
    }
    if (!cfg.directorAgentId || typeof cfg.directorAgentId !== "string") {
      errors.push("directorAgentId is required");
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
