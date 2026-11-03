export type ClaudeProfileImportMode = "off" | "copy" | "cache";

function plain(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "type" in value && value.type === "plain" &&
    "value" in value && typeof value.value === "string") return value.value;
  return undefined;
}

/** Typed agent choices win; legacy environment bindings remain supported. */
export function resolveClaudeRuntimeSettings(
  config: Record<string, unknown>,
  env: Record<string, unknown> = {},
  defaults: { retentionEnabled?: boolean; retentionDays?: number } = {},
) {
  const mode = config.profileImportMode ?? plain(env.PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE) ?? "off";
  if (typeof mode !== "string" || !["off", "copy", "cache"].includes(mode.trim().toLowerCase())) {
    throw new Error("Claude profile import mode must be off, copy, or cache");
  }
  if (config.profileSourceDir !== undefined && typeof config.profileSourceDir !== "string") {
    throw new Error("Claude profile source directory must be a string");
  }
  if (config.transcriptRetentionEnabled !== undefined && typeof config.transcriptRetentionEnabled !== "boolean") {
    throw new Error("Claude transcript retention must be a boolean");
  }
  const envRetention = plain(env.PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED);
  const rawDays = config.transcriptRetentionDays ?? plain(env.PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DAYS);
  const days = rawDays === undefined ? defaults.retentionDays ?? 7 : Number(rawDays);
  if (!Number.isInteger(days) || days < 1) throw new Error("Claude transcript retention days must be a positive integer");
  return {
    profileImportMode: mode.trim().toLowerCase() as ClaudeProfileImportMode,
    profileSourceDir: (config.profileSourceDir as string | undefined ?? plain(env.PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR) ?? "").trim(),
    transcriptRetentionEnabled: config.transcriptRetentionEnabled as boolean | undefined ??
      (envRetention === undefined ? defaults.retentionEnabled ?? false : envRetention === "true"),
    transcriptRetentionDays: days,
  };
}
