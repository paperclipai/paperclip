import { Telegraf } from "telegraf";
import { loadConfig } from "./config.js";
import { CodeStore } from "./state/code-store.js";
import { ReplyStore } from "./state/reply-store.js";
import { PaperclipClient } from "./api/paperclip-client.js";
import { startInternalServer } from "./internal-server.js";
import { loginCommand } from "./commands/login.js";
import { makeTaskCommand } from "./commands/task.js";
import { issueCommand } from "./commands/issue.js";
import { approveCommand, denyCommand } from "./commands/approve.js";
import { replyHandler } from "./commands/reply.js";
import type { CommandDeps, CommandHandler, IncomingMessageContext } from "./commands/types.js";
import { NotifierApi } from "./notifier/api.js";
import { NotifierDedup } from "./notifier/dedup.js";
import { NotifierPoller } from "./notifier/poller.js";

function ctxFromTelegraf(tCtx: import("telegraf").Context): IncomingMessageContext | null {
  const msg = tCtx.message;
  if (!msg || !("text" in msg) || typeof msg.text !== "string") return null;
  const chatId = String(tCtx.chat?.id ?? "");
  if (!chatId) return null;
  const replyTo =
    "reply_to_message" in msg && msg.reply_to_message
      ? msg.reply_to_message.message_id
      : null;
  return {
    chatId,
    tgUserId: tCtx.from?.id != null ? String(tCtx.from.id) : null,
    tgUsername: tCtx.from?.username ?? null,
    text: msg.text,
    replyToMessageId: replyTo,
    reply: async (text: string) => {
      await tCtx.reply(text);
    },
  };
}

async function runHandler(
  tCtx: import("telegraf").Context,
  handler: CommandHandler,
  deps: CommandDeps,
): Promise<void> {
  const ctx = ctxFromTelegraf(tCtx);
  if (!ctx) return;
  await handler(ctx, deps);
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const codeStore = new CodeStore();
  const replyStore = new ReplyStore();
  const client = new PaperclipClient({
    baseUrl: config.paperclipApiUrl,
    apiKey: config.paperclipBotApiKey,
    companyId: config.paperclipCompanyId,
  });
  const deps: CommandDeps = { client, codeStore, replyStore };

  const internal = await startInternalServer({
    codeStore,
    secret: config.internalSecret,
    port: config.internalPort,
    logger: { info: (m) => console.log(m), error: (m, e) => console.error(m, e) },
  });

  const bot = new Telegraf(config.telegramBotToken);
  const taskCommand = makeTaskCommand({ ceoAgentId: config.ceoAgentId });

  bot.command("login", (tCtx) => runHandler(tCtx, loginCommand, deps));
  bot.command("task", (tCtx) => runHandler(tCtx, taskCommand, deps));
  bot.command("issue", (tCtx) => runHandler(tCtx, issueCommand, deps));
  bot.command("approve", (tCtx) => runHandler(tCtx, approveCommand, deps));
  bot.command("deny", (tCtx) => runHandler(tCtx, denyCommand, deps));

  bot.on("text", (tCtx, next) => {
    const msg = tCtx.message;
    if (msg && "text" in msg && typeof msg.text === "string" && msg.text.startsWith("/")) {
      return next();
    }
    return runHandler(tCtx, replyHandler, deps);
  });

  bot.catch((err: unknown) => {
    console.error("telegraf error", err);
  });

  let notifier: NotifierPoller | null = null;
  if (config.notifier) {
    const notifierApi = new NotifierApi({
      baseUrl: config.paperclipApiUrl,
      apiKey: config.paperclipBotApiKey,
      companyId: config.paperclipCompanyId,
    });
    const dedup = new NotifierDedup({ filePath: config.notifier.dedupFilePath });
    notifier = new NotifierPoller({
      api: notifierApi,
      dedup,
      replyStore,
      send: async (chatId, text) => {
        const msg = await bot.telegram.sendMessage(chatId, text);
        return { message_id: msg.message_id };
      },
      dinarUserId: config.notifier.dinarUserId,
      dinarChatId: config.notifier.dinarChatId,
      intervalMs: config.notifier.intervalMs,
      logger: {
        info: (m, c) => console.log("[notifier]", m, c ?? ""),
        warn: (m, c) => console.warn("[notifier]", m, c ?? ""),
        error: (m, c) => console.error("[notifier]", m, c ?? ""),
      },
    });
  }

  process.once("SIGINT", () => {
    notifier?.stop();
    bot.stop("SIGINT");
    void internal.close();
  });
  process.once("SIGTERM", () => {
    notifier?.stop();
    bot.stop("SIGTERM");
    void internal.close();
  });

  await bot.launch();
  if (notifier) {
    await notifier.start();
    console.log("paperclip telegram-bot notifier started");
  } else {
    console.log("paperclip telegram-bot notifier disabled (DINAR_USER_ID / DINAR_TG_CHAT_ID unset)");
  }
  console.log("paperclip telegram-bot started");
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error("fatal", err);
    process.exit(1);
  });
}
