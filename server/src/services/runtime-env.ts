import { parseObject } from "../adapters/utils.js";

function isPaperclipRuntimeEnvKey(key: string) {
  return key.startsWith("PAPERCLIP_");
}

export function stripPaperclipRuntimeEnvBindings(envValue: unknown): Record<string, unknown> | null {
  const record = parseObject(envValue);
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => !isPaperclipRuntimeEnvKey(key)),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
}

export function stripPaperclipRuntimeEnvFromAdapterConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(config, "env")) return config;
  return {
    ...config,
    env: stripPaperclipRuntimeEnvBindings(config.env) ?? {},
  };
}

