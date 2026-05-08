import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDefaultInboxTelegramNotifierState,
  decideInboxTelegramNotification,
  formatInboxTelegramMessage,
  normalizeInboxBadgeSnapshot,
  type InboxBadgeSnapshot,
  type InboxTelegramNotifierState,
} from "../server/src/services/inbox-telegram-notifier.ts";

const API_BASE = process.env.PAPERCLIP_API_BASE ?? "http://127.0.0.1:3100/api";
const COMPANY_ID = requireEnv("PAPERCLIP_COMPANY_ID");
const TELEGRAM_BOT_TOKEN = requireEnv("PAPERCLIP_TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = requireEnv("PAPERCLIP_TELEGRAM_CHAT_ID");
const COMPANY_LABEL = process.env.PAPERCLIP_COMPANY_LABEL ?? COMPANY_ID;
const INBOX_URL = process.env.PAPERCLIP_INBOX_URL ?? null;
const DEFAULT_STATE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.runtime/paperclip-inbox-telegram-state.json",
);
const STATE_FILE = process.env.PAPERCLIP_INBOX_STATE_FILE ?? DEFAULT_STATE_FILE;
const observedAt = new Date().toISOString();

const response = await fetchJson<InboxBadgeSnapshot>(`${API_BASE}/companies/${COMPANY_ID}/sidebar-badges`);
const snapshot = normalizeInboxBadgeSnapshot(response);
const previousState = await readState(STATE_FILE);
const decision = decideInboxTelegramNotification({
  previousState,
  snapshot,
  observedAt,
});

let telegramMessageId: number | null = null;
let message: string | null = null;
if (decision.shouldNotify) {
  message = formatInboxTelegramMessage(snapshot, {
    companyLabel: COMPANY_LABEL,
    inboxUrl: INBOX_URL,
    observedAt,
  });
  telegramMessageId = await sendTelegramMessage({
    botToken: TELEGRAM_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID,
    text: message,
  });
}

await writeState(STATE_FILE, decision.nextState);

console.log(
  JSON.stringify(
    {
      ok: true,
      apiBase: API_BASE,
      companyId: COMPANY_ID,
      stateFile: STATE_FILE,
      observedAt,
      snapshot,
      shouldNotify: decision.shouldNotify,
      reason: decision.reason,
      telegramMessageId,
      message,
    },
    null,
    2,
  ),
);

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function sendTelegramMessage(params: {
  botToken: string;
  chatId: string;
  text: string;
}): Promise<number | null> {
  const response = await fetch(`https://api.telegram.org/bot${params.botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      chat_id: params.chatId,
      text: params.text,
      disable_web_page_preview: true,
    }),
  });

  const data = (await response.json()) as {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
  };

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${response.statusText} ${data.description ?? "unknown error"}`);
  }

  return data.result?.message_id ?? null;
}

async function readState(stateFile: string): Promise<InboxTelegramNotifierState> {
  try {
    const raw = await readFile(stateFile, "utf8");
    return {
      ...createDefaultInboxTelegramNotifierState(),
      ...(JSON.parse(raw) as Partial<InboxTelegramNotifierState>),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return createDefaultInboxTelegramNotifierState();
    }
    throw error;
  }
}

async function writeState(stateFile: string, state: InboxTelegramNotifierState): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
