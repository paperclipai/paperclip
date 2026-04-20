/**
 * Skill key and slug normalization utilities.
 *
 * Consolidates the duplicated normalization logic from company-portability
 * and company-skills into a single source of truth.
 */

import { normalizeAgentUrlKey } from "@paperclipai/shared";

/**
 * Normalize a single skill slug segment using the same rules as agent URL keys.
 *
 * Returns `null` for empty or invalid input.
 */
export function normalizeSkillSlug(value: string | null | undefined): string | null {
  return value ? (normalizeAgentUrlKey(value) ?? null) : null;
}

/**
 * Normalize a compound skill key (e.g. `"org/skill-name"`).
 *
 * Each `/`-delimited segment is normalized independently via
 * `normalizeSkillSlug`. Returns `null` when no valid segments remain.
 */
export function normalizeSkillKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const segments = value
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("/") : null;
}
