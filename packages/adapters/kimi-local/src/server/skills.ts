import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";

const KIMI_BUILTIN_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/**
 * Resolve which skills should be enabled for Kimi.
 * Kimi has built-in tools, so we filter to only include skills that aren't built-in.
 */
export function resolveKimiDesiredSkillNames(
  config: Record<string, unknown>,
  entries: PaperclipSkillEntry[],
): string[] {
  // If config has explicit skills, use those
  const configSkills = config.skills;
  if (Array.isArray(configSkills)) {
    return configSkills.filter((s): s is string => typeof s === "string");
  }

  // Otherwise, include all non-built-in skills
  return entries
    .filter((entry) => !KIMI_BUILTIN_TOOLS.has(entry.key))
    .map((entry) => entry.key);
}

function buildKimiSkillSnapshot(config: Record<string, unknown>): AdapterSkillSnapshot {
  // Kimi skills are passed via --skills-dir flags, not synced to a directory
  // So we return a minimal snapshot with available skills
  const desiredSkills = resolveKimiDesiredSkillNames(config, []);

  const entries: AdapterSkillEntry[] = Array.from(KIMI_BUILTIN_TOOLS).map((key) => ({
    key,
    runtimeName: null,
    desired: false, // Built-in tools are always available, not "desired"
    managed: false, // Built-in tools are not managed by Paperclip
    state: "available",
    origin: "external_unknown",
    originLabel: "Kimi built-in tool",
    readOnly: true,
    sourcePath: null,
    targetPath: null,
  }));

  return {
    adapterType: "kimi_local",
    supported: false, // Kimi doesn't support Paperclip skill sync in the traditional sense
    mode: "unsupported",
    desiredSkills,
    entries,
    warnings: [],
  };
}

/**
 * List available skills for Kimi.
 */
export async function listKimiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildKimiSkillSnapshot(ctx.config);
}

/**
 * Sync skills to Kimi's skill directories.
 * Kimi uses --skills-dir flags, so this is a no-op that returns the snapshot.
 */
export async function syncKimiSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // Kimi skills are loaded via CLI args, no filesystem sync needed
  return buildKimiSkillSnapshot(ctx.config);
}

function getBuiltinToolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    read: "Read file contents",
    bash: "Execute shell commands",
    edit: "Edit existing files",
    write: "Write new files",
    grep: "Search file contents",
    find: "Find files by pattern",
    ls: "List directory contents",
  };
  return descriptions[name] || "Kimi built-in tool";
}
