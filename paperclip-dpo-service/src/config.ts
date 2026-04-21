import { z } from "zod";

const Schema = z.object({
  DPO_PORT: z.coerce.number().default(4711),
  DPO_BIND: z.string().default("0.0.0.0"),
  DPO_SHARED_KEY: z.string().min(32, "DPO_SHARED_KEY must be at least 32 chars"),
  DPO_MAPPING_DB: z.string(),
  DPO_AUDIT_DIR: z.string(),
  DPO_CLASSIFIER_URL: z.string().default("http://localhost:1234"),
  DPO_CLASSIFIER_MODEL: z.string().default("gemma-4-26b"),
  DPO_CLASSIFIER_TIMEOUT_MS: z.coerce.number().default(30000),
  DPO_TELEGRAM_BOT_TOKEN: z.string().optional(),
  DPO_TELEGRAM_CHAT_ID: z.string().optional(),
});

export interface ServiceConfig {
  port: number;
  bind: string;
  sharedKey: string;
  mappingDbPath: string;
  auditDir: string;
  classifier: { url: string; model: string; timeoutMs: number };
  telegram?: { botToken: string; chatId: string };
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): ServiceConfig {
  const parsed = Schema.parse(env);
  const telegram = parsed.DPO_TELEGRAM_BOT_TOKEN && parsed.DPO_TELEGRAM_CHAT_ID
    ? { botToken: parsed.DPO_TELEGRAM_BOT_TOKEN, chatId: parsed.DPO_TELEGRAM_CHAT_ID }
    : undefined;
  return {
    port: parsed.DPO_PORT,
    bind: parsed.DPO_BIND,
    sharedKey: parsed.DPO_SHARED_KEY,
    mappingDbPath: parsed.DPO_MAPPING_DB,
    auditDir: parsed.DPO_AUDIT_DIR,
    classifier: {
      url: parsed.DPO_CLASSIFIER_URL,
      model: parsed.DPO_CLASSIFIER_MODEL,
      timeoutMs: parsed.DPO_CLASSIFIER_TIMEOUT_MS,
    },
    telegram,
  };
}
