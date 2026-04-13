import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginEvent,
  PluginWebhookInput,
  PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TelegramConfig {
  botToken: string;
  personalChatId: string;
  companyId: string;
  personalAssistantAgentId: string;
  ceoAgentId: string;
  groqApiKey?: string;
  notifyChatId?: string;
  enableNotifications: boolean;
}

interface ActiveAgent {
  agentId: string;
  name: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; username?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
  voice?: { file_id: string; duration: number };
  audio?: { file_id: string; duration: number };
}

// ─── Agent Registry ───────────────────────────────────────────────────────────

// Команды переключения агентов. Ключи — lowercase команды.
const AGENT_COMMANDS: Record<string, ActiveAgent> = {
  "/pa":        { agentId: "6fbe7253-4746-4b0b-b371-3218e9c03ea6", name: "Personal Assistant" },
  "/assistant": { agentId: "6fbe7253-4746-4b0b-b371-3218e9c03ea6", name: "Personal Assistant" },
  "/ceo":       { agentId: "76cf0ea1-d736-4245-8959-388faa5513ad", name: "Holding CEO" },
  "/cto":       { agentId: "a2673ab4-58fa-4404-a111-b2bc9d3e7fda", name: "Arty CTO" },
  "/hftcto":    { agentId: "03b7cb3e-f06b-4a76-be5d-952801dfccc0", name: "HFT CTO" },
  "/cfo":       { agentId: "849e1879-6aa2-437e-8a9e-3ebc24baa2a7", name: "CFO" },
  "/coo":       { agentId: "9e620991-4085-4c91-8af9-591c22c16333", name: "Arty COO" },
  "/pm":        { agentId: "e759dbe1-31c1-4764-9604-02b312da8023", name: "Arty PM" },
  "/hftpm":     { agentId: "318040b3-080e-4486-8355-ec4f511e923f", name: "HFT PM" },
  "/hftrisk":   { agentId: "ac29e660-d0e2-43dc-a9eb-675ef1bde81a", name: "HFT Risk" },
  "/cbo":       { agentId: "3862b770-d5a4-45df-b406-a9bfd3eb45a4", name: "Arty CBO" },
};

const HELP_TEXT = `🤖 <b>ARTI Holding Bot</b>

Отправьте текст или голосовое сообщение — ответит активный агент.

<b>Переключить агента:</b>
/pa — Personal Assistant (по умолчанию для вас)
/ceo — Holding CEO
/cto — Arty CTO
/hftcto — HFT CTO
/cfo — CFO
/coo — COO
/cbo — CBO
/pm — Arty PM
/hftpm — HFT PM
/hftrisk — HFT Risk

<b>Утилиты:</b>
/status — текущий агент
/help — это сообщение`;

// ─── Module state ─────────────────────────────────────────────────────────────

let currentContext: PluginContext | undefined;

// ─── Config ───────────────────────────────────────────────────────────────────

async function getConfig(ctx: PluginContext): Promise<TelegramConfig> {
  const raw = (await ctx.config.get()) as Record<string, unknown>;
  return {
    botToken: (raw.botToken as string) ?? "",
    personalChatId: (raw.personalChatId as string) ?? "",
    companyId:
      (raw.companyId as string) ?? "752d12a0-c30a-45c0-ad18-a285ae5acf7a",
    personalAssistantAgentId:
      (raw.personalAssistantAgentId as string) ??
      "6fbe7253-4746-4b0b-b371-3218e9c03ea6",
    ceoAgentId:
      (raw.ceoAgentId as string) ?? "76cf0ea1-d736-4245-8959-388faa5513ad",
    groqApiKey: (raw.groqApiKey as string | undefined),
    notifyChatId: (raw.notifyChatId as string | undefined) || undefined,
    enableNotifications: (raw.enableNotifications as boolean) ?? true,
  };
}

// ─── Telegram API ─────────────────────────────────────────────────────────────

async function tgApi(
  ctx: PluginContext,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const resp = await ctx.http.fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    },
  );
  return resp.json();
}

async function sendMsg(
  ctx: PluginContext,
  token: string,
  chatId: string | number,
  html: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  // Telegram limit: 4096 chars per message
  const MAX = 4000;
  const chunks: string[] = [];
  for (let i = 0; i < html.length; i += MAX) chunks.push(html.slice(i, i + MAX));

  for (const chunk of chunks) {
    await tgApi(ctx, token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      ...extra,
    }).catch((err) => ctx.logger.error("sendMessage failed", { error: String(err) }));
  }
}

async function sendPlainMsg(
  ctx: PluginContext,
  token: string,
  chatId: string | number,
  text: string,
): Promise<void> {
  const MAX = 4000;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));

  for (const chunk of chunks) {
    await tgApi(ctx, token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
    }).catch((err) => ctx.logger.error("sendMessage failed", { error: String(err) }));
  }
}

async function sendTyping(
  ctx: PluginContext,
  token: string,
  chatId: string | number,
): Promise<void> {
  await tgApi(ctx, token, "sendChatAction", {
    chat_id: chatId,
    action: "typing",
  }).catch(() => {});
}

// ─── Plugin State (active agent per chat) ────────────────────────────────────

async function getActiveAgent(
  ctx: PluginContext,
  chatId: string,
  config: TelegramConfig,
): Promise<ActiveAgent> {
  const stored = (await ctx.state.get({
    scopeKind: "instance",
    namespace: "active-agents",
    stateKey: chatId,
  })) as ActiveAgent | null;

  if (stored?.agentId) return stored;

  // Default: личный чат → PA, остальные → CEO
  return chatId === config.personalChatId
    ? { agentId: config.personalAssistantAgentId, name: "Personal Assistant" }
    : { agentId: config.ceoAgentId, name: "Holding CEO" };
}

async function setActiveAgent(
  ctx: PluginContext,
  chatId: string,
  agent: ActiveAgent,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", namespace: "active-agents", stateKey: chatId },
    agent,
  );
}

async function claimUpdate(
  ctx: PluginContext,
  updateId: number,
): Promise<boolean> {
  const stateKey = String(updateId);
  const existing = await ctx.state.get({
    scopeKind: "instance",
    namespace: "telegram-updates",
    stateKey,
  });

  if (existing) return false;

  await ctx.state.set(
    { scopeKind: "instance", namespace: "telegram-updates", stateKey },
    { status: "accepted", acceptedAt: new Date().toISOString() },
  );
  return true;
}

function runInBackground(
  ctx: PluginContext,
  label: string,
  task: () => Promise<void>,
): void {
  void task().catch((err) => {
    ctx.logger.error(label, { error: String(err) });
  });
}

// ─── Output filtering ─────────────────────────────────────────────────────────
//
// The agent stdout contains multiple kinds of noise:
//
// 1. Claude CLI JSON stream events (one JSON object per line):
//      {"type":"system","subtype":"init",...}
//      {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."},...}
//
// 2. Raw tool_result dumps — API responses printed as escaped JSON strings:
//      [{"id":"31d16...","companyId":"752d12a0...","body":\"...\",...}]
//      "stdout":"[{\"id\":\"...
//
// 3. Skill documentation leaked into stdout (SKILL.md content).
//
// Strategy: extract only natural-language text; discard everything else.

// JSON event types that carry no user-visible text
const JSON_NOISE_TYPES = new Set([
  "system", "tool_use", "tool_result", "tool_result_error",
  "message_start", "message_delta", "message_stop",
  "content_block_start", "content_block_stop",
  "ping", "error",
]);

/** Returns true if this chunk is a raw API/tool-result JSON dump. */
function isToolResultDump(text: string): boolean {
  const t = text.trim();
  // Escaped JSON (tool result printed as a string)
  const escapedQuotes = (t.match(/\\"/g) ?? []).length;
  if (escapedQuotes > 10) return true;
  // Large JSON arrays/objects starting with [ or {
  if ((t.startsWith("[{") || t.startsWith("{\"")) && t.length > 200) return true;
  // Looks like a serialised Paperclip issue/comment object
  if (t.includes('"companyId"') || t.includes('"issueId"') || t.includes('"authorAgentId"')) return true;
  // tool_use_result wrapper format
  if (t.includes('"tool_use_result"') || t.includes('"stdout":"[{')) return true;
  return false;
}

function extractHumanText(chunk: string): string {
  const trimmed = chunk.trim();
  if (!trimmed) return "";

  // Reject tool-result dumps immediately
  if (isToolResultDump(trimmed)) return "";

  // Fast path: single-line JSON event (Claude CLI stream)
  if (trimmed.startsWith("{")) {
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      return extractFromJsonEvent(event);
    } catch {
      // Not valid JSON — fall through to line-by-line
    }
  }

  // Line-by-line processing
  const lines = chunk.split(/\r?\n/);
  const parts: string[] = [];

  for (const line of lines) {
    const lt = line.trim();
    if (!lt) { parts.push(""); continue; }

    // Skip escaped JSON / tool result lines
    if (isToolResultDump(lt)) continue;

    // Try to parse as a Claude CLI JSON event
    if (lt.startsWith("{")) {
      try {
        const event = JSON.parse(lt) as Record<string, unknown>;
        const text = extractFromJsonEvent(event);
        if (text) parts.push(text);
        continue;
      } catch {
        // Not JSON — treat as plain text
      }
    }

    if (!isTechnicalTelegramNoise(line)) parts.push(line);
  }

  return parts.join("\n");
}

function extractFromJsonEvent(event: Record<string, unknown>): string {
  const type = event.type as string | undefined;
  if (!type) return "";

  if (JSON_NOISE_TYPES.has(type)) return "";

  if (type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
    return "";
  }

  if (type === "message") {
    const content = event.content;
    if (Array.isArray(content)) {
      return content
        .filter((b: unknown) => (b as Record<string, unknown>)?.type === "text")
        .map((b: unknown) => (b as Record<string, unknown>).text as string)
        .join("");
    }
  }

  return "";
}

function sanitizeAgentMessage(message: string): string {
  return message
    .split(/\r?\n/)
    .filter((line) => !isTechnicalTelegramNoise(line))
    .join("\n");
}

function isTechnicalTelegramNoise(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // JSON event lines from Claude CLI
  if (trimmed.startsWith("{") && trimmed.includes('"type"')) return true;
  // Escaped JSON / tool result dumps
  if (isToolResultDump(trimmed)) return true;
  // Very long lines are almost always API data, not prose
  if (trimmed.length > 400) return true;

  return (
    trimmed.startsWith("[paperclip]") ||
    trimmed.startsWith("Error generating content via API") ||
    trimmed.startsWith("Full report available at:") ||
    trimmed.startsWith("Warning: Metrics token unavailable") ||
    trimmed.includes("No project or prior session workspace was available") ||
    trimmed.includes("Using fallback workspace") ||
    trimmed.includes("ProjectIdRequiredError") ||
    trimmed.includes("GaxiosError") ||
    trimmed.includes("Traceback ") ||
    trimmed.includes(" at async ") ||
    trimmed.includes(" at ")
  );
}

function buildTelegramAgentPrompt(prompt: string): string {
  return [
    "Ты отвечаешь пользователю через Telegram. Дай короткий, чёткий, человекочитаемый ответ.",
    "",
    "СТРОГИЕ ПРАВИЛА — нарушение ломает интерфейс:",
    "1. Только русский язык.",
    "2. Никаких markdown-таблиц (| col | col |) — замени на обычный текст.",
    "3. Никаких API-эндпоинтов, кода, JSON, stack trace, путей к файлам, session id.",
    "4. Никаких ссылок на внутреннюю документацию или skill-файлы — отвечай своими словами.",
    "5. Не цитируй содержимое SKILL.md, AGENTS.md или других инструкций.",
    "6. Максимум 5-7 предложений. Если нужно больше — структурируй с эмодзи-буллетами (•).",
    "7. Если выполняешь задачу — скажи что сделал, одной фразой.",
    "",
    "Вопрос пользователя:",
    prompt,
  ].join("\n");
}

function normalizeTelegramReply(response: string): string {
  const cleaned = sanitizeAgentMessage(response)
    // Unescape literal \n sequences from JSON-serialized strings
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ")
    // Remove markdown table rows (| col | col |) — API docs noise
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      // Filter pipe-heavy lines that look like API/markdown tables
      if ((t.match(/\|/g) ?? []).length >= 2) return false;
      // Filter lines that are just dashes (table separators)
      if (/^[-|:\s]+$/.test(t) && t.length > 4) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!cleaned) {
    return "Пока не получил содержательный ответ от агента. Попробуйте повторить чуть позже или переключить агента командой /status.";
  }

  return cleaned;
}

// ─── Agent Session ────────────────────────────────────────────────────────────

async function askAgent(
  ctx: PluginContext,
  agentId: string,
  companyId: string,
  prompt: string,
): Promise<string> {
  ctx.logger.info("Routing to agent", { agentId, chars: prompt.length });

  const session = await ctx.agents.sessions.create(agentId, companyId, {
    reason: "Telegram",
  });

  ctx.logger.info("Session created", { sessionId: session.sessionId });

  // AgentSessionEvent fields:
  //   eventType: "chunk" | "status" | "done" | "error"
  //   stream:    "stdout" | "stderr" | "system" | null  ← stream TYPE, not content
  //   message:   string | null                          ← actual text content
  //
  // IMPORTANT: sendMessage() returns the runId IMMEDIATELY (fire-and-forget).
  // Events arrive LATER as async notifications. We must wait for the "done"
  // or "error" event BEFORE calling close(), otherwise close() deletes the
  // callback and we miss all events.
  const streamChunks: string[] = [];
  let eventCount = 0;

  let doneResolve!: () => void;
  const donePromise = new Promise<void>((resolve) => { doneResolve = resolve; });

  // Fire sendMessage (non-blocking: returns runId, events follow async)
  ctx.agents.sessions
    .sendMessage(session.sessionId, companyId, {
      prompt: buildTelegramAgentPrompt(prompt),
      reason: "Telegram message",
      onEvent: (event) => {
        eventCount++;
        ctx.logger.info("Agent event", {
          eventType: event.eventType,
          streamType: event.stream,
          messageLen: event.message?.length ?? 0,
        });

        // "chunk" events carry output text in .message
        // extractHumanText strips Claude CLI JSON events and keeps only
        // human-readable assistant text (content_block_delta / plain text).
        if (event.eventType === "chunk" && event.stream === "stdout" && event.message) {
          const message = extractHumanText(event.message);
          if (message.trim()) streamChunks.push(message);
        }

        // "done" event — agent completed
        if (event.eventType === "done") {
          if (event.message && streamChunks.length === 0) {
            const message = sanitizeAgentMessage(event.message);
            if (message.trim()) streamChunks.push(message);
          }
          doneResolve();
        }

        // "error" event — agent failed
        if (event.eventType === "error") {
          doneResolve();
        }
      },
    })
    .catch((err) => {
      ctx.logger.error("sendMessage error", { error: String(err) });
      doneResolve();
    });

  // Wait for done event or 5-minute timeout
  const TIMEOUT_MS = 5 * 60 * 1000;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>(
    (resolve) => { timeoutHandle = setTimeout(resolve, TIMEOUT_MS); },
  );

  await Promise.race([donePromise, timeoutPromise]);
  clearTimeout(timeoutHandle);

  // Now safe to close (done event already received or timed out)
  await ctx.agents.sessions.close(session.sessionId, companyId).catch(() => {});

  ctx.logger.info("Agent response collected", {
    eventCount,
    streamChunks: streamChunks.length,
  });

  const response = streamChunks.join("");
  return normalizeTelegramReply(response);
}

// ─── Voice Transcription (Groq Whisper) ──────────────────────────────────────

async function downloadTgFile(
  ctx: PluginContext,
  token: string,
  fileId: string,
): Promise<ArrayBuffer> {
  const info = (await tgApi(ctx, token, "getFile", { file_id: fileId })) as {
    result: { file_path: string };
  };
  const url = `https://api.telegram.org/file/bot${token}/${info.result.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Telegram file download failed: ${resp.status} ${resp.statusText}`);
  }
  return resp.arrayBuffer();
}

async function transcribeVoice(
  ctx: PluginContext,
  token: string,
  fileId: string,
  groqKey: string,
): Promise<string> {
  const audioBuffer = await downloadTgFile(ctx, token, fileId);

  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  form.append("model", "whisper-large-v3");
  form.append("language", "ru");
  form.append("response_format", "json");

  // Using Groq's free Whisper API (OpenAI-compatible)
  // Use native fetch here: the plugin SDK RPC fetch serializes RequestInit.body
  // as a string, which breaks multipart/form-data file uploads.
  const resp = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}` },
      body: form,
    },
  );

  const result = (await resp.json()) as { text?: string; error?: unknown };
  if (result.error) {
    ctx.logger.error("Groq transcription error", { status: resp.status, error: result.error });
    return "";
  }
  return result.text?.trim() ?? "";
}

// ─── Message Handlers ─────────────────────────────────────────────────────────

async function handleText(
  ctx: PluginContext,
  config: TelegramConfig,
  chatId: string,
  text: string,
): Promise<void> {
  await sendTyping(ctx, config.botToken, chatId);
  const agent = await getActiveAgent(ctx, chatId, config);
  const reply = await askAgent(ctx, agent.agentId, config.companyId, text);
  await sendPlainMsg(ctx, config.botToken, chatId, reply);
}

async function enqueueText(
  ctx: PluginContext,
  config: TelegramConfig,
  chatId: string,
  text: string,
): Promise<void> {
  const agent = await getActiveAgent(ctx, chatId, config);
  await sendMsg(
    ctx,
    config.botToken,
    chatId,
    `✅ Принял. Передаю задачу агенту: <b>${escapeHtml(agent.name)}</b>. Ответ пришлю сюда отдельным сообщением.`,
  );

  runInBackground(ctx, "Telegram async text handling failed", async () => {
    await sendTyping(ctx, config.botToken, chatId);
    const reply = await askAgent(ctx, agent.agentId, config.companyId, text);
    await sendPlainMsg(ctx, config.botToken, chatId, reply);
  });
}

async function handleVoice(
  ctx: PluginContext,
  config: TelegramConfig,
  chatId: string,
  fileId: string,
): Promise<void> {
  if (!config.groqApiKey) {
    await sendMsg(
      ctx,
      config.botToken,
      chatId,
      "⚠️ Голосовые не поддерживаются — настройте Groq API Key в конфиге плагина.\n\nПолучить бесплатно: https://console.groq.com",
    );
    return;
  }

  const groqApiKey = config.groqApiKey;

  await sendMsg(
    ctx,
    config.botToken,
    chatId,
    "✅ Принял голосовое. Сейчас расшифрую и передам активному агенту.",
  );

  runInBackground(ctx, "Telegram async voice handling failed", async () => {
    await sendTyping(ctx, config.botToken, chatId);

    const transcribed = await transcribeVoice(
      ctx,
      config.botToken,
      fileId,
      groqApiKey,
    ).catch((err) => {
      ctx.logger.error("Transcription failed", { error: String(err) });
      return "";
    });

    if (!transcribed) {
      await sendMsg(ctx, config.botToken, chatId, "⚠️ Не удалось распознать голос.");
      return;
    }

    // Показываем расшифровку, потом ответ агента
    await sendMsg(ctx, config.botToken, chatId, `🎙 <i>${escapeHtml(transcribed)}</i>`);
    await handleText(ctx, config, chatId, transcribed);
  });
}

async function handleCommand(
  ctx: PluginContext,
  config: TelegramConfig,
  chatId: string,
  command: string,
  args: string,
): Promise<void> {
  // Переключение агента
  if (AGENT_COMMANDS[command]) {
    const agent = AGENT_COMMANDS[command];
    await setActiveAgent(ctx, chatId, agent);
    await sendMsg(
      ctx,
      config.botToken,
      chatId,
      `✅ Переключён на: <b>${agent.name}</b>\n\nЗадавайте вопросы.`,
    );
    return;
  }

  switch (command) {
    case "/start":
    case "/help":
      await sendMsg(ctx, config.botToken, chatId, HELP_TEXT);
      break;

    case "/status": {
      const active = await getActiveAgent(ctx, chatId, config);
      await sendMsg(
        ctx,
        config.botToken,
        chatId,
        `🎯 Активный агент: <b>${active.name}</b>`,
      );
      break;
    }

    default:
      // Неизвестная команда — если есть аргументы, трактуем как вопрос
      if (args.trim()) {
        await enqueueText(ctx, config, chatId, `${command} ${args}`);
      } else {
        await sendMsg(
          ctx,
          config.botToken,
          chatId,
          `Неизвестная команда: <code>${escapeHtml(command)}</code>\n/help — список команд`,
        );
      }
  }
}

async function handleUpdate(
  ctx: PluginContext,
  config: TelegramConfig,
  update: TelegramUpdate,
): Promise<void> {
  const claimed = await claimUpdate(ctx, update.update_id);
  if (!claimed) {
    ctx.logger.info("Skipping duplicate Telegram update", { updateId: update.update_id });
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return;

  const chatId = String(message.chat.id);

  if (message.text) {
    const text = message.text.trim();
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const command =
        spaceIdx === -1 ? text : text.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);
      // Убираем @username суффикс у команды
      const baseCmd = command.split("@")[0].toLowerCase();
      await handleCommand(ctx, config, chatId, baseCmd, args);
    } else {
      await enqueueText(ctx, config, chatId, text);
    }
    return;
  }

  if (message.voice) {
    await handleVoice(ctx, config, chatId, message.voice.file_id);
    return;
  }

  if (message.audio) {
    await handleVoice(ctx, config, chatId, message.audio.file_id);
    return;
  }

  await sendMsg(
    ctx,
    config.botToken,
    chatId,
    "⚠️ Поддерживаются текстовые и голосовые сообщения.",
  );
}

// ─── Push Notifications ───────────────────────────────────────────────────────

async function handleIssueCommented(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<void> {
  const config = await getConfig(ctx);
  if (!config.enableNotifications || !config.notifyChatId) return;
  if (event.actorType !== "agent") return;

  const payload = event.payload as Record<string, unknown>;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const issue = payload.issue as Record<string, unknown> | undefined;
  if (!comment || !issue) return;

  const agentName = event.actorId ?? "Agent";
  const issueTitle = (issue.title as string) ?? "задача";
  const commentText = (comment.content as string) ?? "";

  const html = [
    `💬 <b>${escapeHtml(agentName)}</b> → <i>${escapeHtml(issueTitle)}</i>`,
    "",
    escapeHtml(commentText).slice(0, 1000),
  ].join("\n");

  await sendMsg(ctx, config.botToken, config.notifyChatId, html);
}

// ─── HTML escape ──────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx): Promise<void> {
    currentContext = ctx;
    ctx.logger.info("Telegram plugin ready");

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      try {
        await handleIssueCommented(ctx, event);
      } catch (err) {
        ctx.logger.error("Push notification failed", { error: String(err) });
      }
    });
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) return { status: "degraded", message: "Initializing..." };

    try {
      const config = await getConfig(ctx);
      if (!config.botToken) {
        return { status: "degraded", message: "Bot token not configured — set it in plugin settings" };
      }
      return {
        status: "ok",
        message: "Telegram bot ready",
        details: {
          hasGroq: !!config.groqApiKey,
          notifications: config.enableNotifications,
          notifyChatId: config.notifyChatId ?? "not set",
        },
      };
    } catch {
      return { status: "error", message: "Failed to load config" };
    }
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    if (input.endpointKey !== "telegram-update") return;

    const ctx = currentContext;
    if (!ctx) return;

    try {
      const config = await getConfig(ctx);
      if (!config.botToken) {
        ctx.logger.warn("Webhook received but bot token not configured");
        return;
      }

      const update = input.parsedBody as TelegramUpdate;
      await handleUpdate(ctx, config, update);
    } catch (err) {
      ctx?.logger.error("Telegram webhook error", { error: String(err) });
    }
  },

  async onShutdown(): Promise<void> {
    currentContext?.logger.info("Telegram plugin shutting down");
    currentContext = undefined;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
