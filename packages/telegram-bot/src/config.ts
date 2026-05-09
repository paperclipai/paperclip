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
  /**
   * UUID of the CEO Weekly Board Digest routine. When set, the notifier
   * forwards the digest comment from each `routine_execution` issue (status
   * `in_review`/`done`) to the same chat as the other 4 event types — in
   * production that's the `-1003986807361` board group via
   * `DINAR_TG_CHAT_ID`. Unset → 5th event type silently disabled.
   */
  weeklyDigestRoutineId?: string;
};

export const DEFAULT_CEO_AGENT_ID = "262a08ea-c041-4af7-a310-e2a0fedc8348";
export const DEFAULT_NOTIFIER_INTERVAL_MS = 30_000;
// Production routine ID for the CEO Weekly Board Digest (THE-365 / THE-397).
// Hardcoded so a service restart picks up THE-397 without requiring the
// EnvironmentFile (`/etc/paperclip/telegram-bot.env`, root-owned) to be
// edited. Override with `CEO_WEEKLY_DIGEST_ROUTINE_ID` in staging/test.
// Set `CEO_WEEKLY_DIGEST_ROUTINE_ID=disabled` to opt out of the 5th event.
export const DEFAULT_WEEKLY_DIGEST_ROUTINE_ID = "9e2f3eea-b5e1-4677-8981-ea27f8ea1288";

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
    weeklyDigestRoutineId: resolveWeeklyDigestRoutineId(env.CEO_WEEKLY_DIGEST_ROUTINE_ID),
  };
}

function resolveWeeklyDigestRoutineId(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (v === undefined || v.length === 0) return DEFAULT_WEEKLY_DIGEST_ROUTINE_ID;
  if (v.toLowerCase() === "disabled") return undefined;
  return v;
}
