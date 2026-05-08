export type BotConfig = {
  telegramBotToken: string;
  paperclipApiUrl: string;
  paperclipBotApiKey: string;
  paperclipCompanyId: string;
  ceoAgentId: string;
  internalSecret: string;
  internalPort: number;
  notifier: NotifierConfig | null;
};

export type NotifierConfig = {
  dinarUserId: string;
  dinarChatId: string;
  intervalMs: number;
  dedupFilePath?: string;
};

export const DEFAULT_CEO_AGENT_ID = "262a08ea-c041-4af7-a310-e2a0fedc8348";
export const DEFAULT_NOTIFIER_INTERVAL_MS = 30_000;

function required(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const internalPortRaw = env.TELEGRAM_BOT_INTERNAL_PORT?.trim() || "3110";
  const internalPort = Number.parseInt(internalPortRaw, 10);
  if (!Number.isFinite(internalPort) || internalPort <= 0) {
    throw new Error(`Invalid TELEGRAM_BOT_INTERNAL_PORT: ${internalPortRaw}`);
  }
  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN),
    paperclipApiUrl: required("PAPERCLIP_API_URL", env.PAPERCLIP_API_URL).replace(/\/$/, ""),
    paperclipBotApiKey: required("PAPERCLIP_BOT_API_KEY", env.PAPERCLIP_BOT_API_KEY),
    paperclipCompanyId: required("PAPERCLIP_COMPANY_ID", env.PAPERCLIP_COMPANY_ID),
    ceoAgentId: env.CEO_AGENT_ID?.trim() || DEFAULT_CEO_AGENT_ID,
    internalSecret: required("TELEGRAM_BOT_INTERNAL_SECRET", env.TELEGRAM_BOT_INTERNAL_SECRET),
    internalPort,
    notifier: loadNotifierConfig(env),
  };
}

function loadNotifierConfig(env: NodeJS.ProcessEnv): NotifierConfig | null {
  const dinarUserId = env.DINAR_USER_ID?.trim();
  const dinarChatId = env.DINAR_TG_CHAT_ID?.trim();
  // Both required to enable the outbound notifier; absence keeps the bot
  // inbound-only without crashing on first deploy.
  if (!dinarUserId || !dinarChatId) return null;
  const intervalRaw = env.NOTIFIER_INTERVAL_MS?.trim();
  const intervalMs = intervalRaw ? Number.parseInt(intervalRaw, 10) : DEFAULT_NOTIFIER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
    throw new Error(`Invalid NOTIFIER_INTERVAL_MS: ${intervalRaw}`);
  }
  return {
    dinarUserId,
    dinarChatId,
    intervalMs,
    dedupFilePath: env.NOTIFIER_DEDUP_FILE?.trim() || undefined,
  };
}
