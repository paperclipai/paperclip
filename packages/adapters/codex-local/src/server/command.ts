import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

const CODEX_COMMAND_ENV_KEYS = ["PAPERCLIP_CODEX_COMMAND", "CODEX_COMMAND"] as const;

export function resolveCodexCommand(configInput: unknown): string {
  const config = parseObject(configInput);
  const fromConfig = asString(config.command, "").trim();
  if (fromConfig) return fromConfig;

  for (const key of CODEX_COMMAND_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "codex";
}
