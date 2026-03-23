/**
 * Skill allowlist — controls which skills an agent is permitted to mount.
 * When no allowlist is configured, all skills are allowed (open policy).
 * When configured, only listed skills are injected into the agent's prompt.
 */

export interface SkillAllowlistPolicy {
  /** If true, only skills in `allowed` are mounted */
  enabled: boolean;
  /** Glob-style or exact skill names that are permitted */
  allowed: string[];
  /** Skills that are always blocked, even if matched by allowed */
  blocked: string[];
}

export const DEFAULT_SKILL_ALLOWLIST: SkillAllowlistPolicy = {
  enabled: true,
  allowed: ["paperclipai/paperclip/paperclip"],
  blocked: [],
};

/**
 * Parse a skill allowlist from agent runtimeConfig.
 */
export function resolveSkillAllowlist(
  runtimeConfig: unknown,
): SkillAllowlistPolicy {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return DEFAULT_SKILL_ALLOWLIST;
  const rc = runtimeConfig as Record<string, unknown>;
  const raw = rc.skillAllowlist;
  if (!raw || typeof raw !== "object") return DEFAULT_SKILL_ALLOWLIST;
  const policy = raw as Record<string, unknown>;

  return {
    enabled: typeof policy.enabled === "boolean" ? policy.enabled : false,
    allowed: Array.isArray(policy.allowed)
      ? policy.allowed.filter((s): s is string => typeof s === "string")
      : [],
    blocked: Array.isArray(policy.blocked)
      ? policy.blocked.filter((s): s is string => typeof s === "string")
      : [],
  };
}

/**
 * Filter a list of skill names through the allowlist policy.
 * Returns only the skills the agent is permitted to use.
 */
export function filterSkills(
  skills: string[],
  policy: SkillAllowlistPolicy,
): string[] {
  if (!policy.enabled) {
    // Even in open mode, blocked skills are removed
    if (policy.blocked.length === 0) return skills;
    const blockedSet = new Set(policy.blocked);
    return skills.filter((s) => !blockedSet.has(s));
  }

  const allowedSet = new Set(policy.allowed);
  const blockedSet = new Set(policy.blocked);

  return skills.filter((s) => allowedSet.has(s) && !blockedSet.has(s));
}

/**
 * Compute a deterministic hash of the mounted skill set.
 * Used for change detection — if the hash differs between runs,
 * the skill set has changed and token counts may not be comparable.
 */
/**
 * Simple FNV-1a hash — browser-safe, no Node.js crypto dependency.
 */
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function computeSkillSetHash(skills: string[]): string {
  const sorted = [...skills].sort();
  const input = sorted.join("\0");
  // Double-hash with offset for 16 hex chars
  return fnv1aHash(input) + fnv1aHash(input + "\x01");
}
