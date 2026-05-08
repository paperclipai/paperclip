export type BotConfig = {
  telegramBotToken: string;
  paperclipApiUrl: string;
  paperclipBotApiKey: string;
  paperclipCompanyId: string;
  ceoAgentId: string;
  internalSecret: string;
  internalPort: number;
};

export const DEFAULT_CEO_AGENT_ID = "262a08ea-c041-4af7-a310-e2a0fedc8348";

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
  };
}
