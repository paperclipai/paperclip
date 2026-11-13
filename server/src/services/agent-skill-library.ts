import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";

/** Agent-scoped UI membership. Runtime assignment still uses desiredSkills only. */
export function readInstalledAgentSkillKeys(config: Record<string, unknown>): string[] {
  const raw = config.paperclipSkillSync;
  const installed = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).installedSkills : undefined;
  return Array.from(new Set([
    ...(Array.isArray(installed) ? installed.flatMap((key) =>
      typeof key === "string" && key.trim() ? [key.trim()] : []) : []),
    ...readPaperclipSkillSyncPreference(config).desiredSkills,
  ]));
}
