/**
 * Default skill assignments per agent role.
 *
 * When a CEO agent hires a new agent without specifying explicit `desiredSkills`,
 * this mapping provides sensible defaults based on the hire's role.
 *
 * Skill keys that don't exist in the company library are silently filtered out
 * by `resolveRequestedSkillKeys` — stale or missing keys are safe.
 */

const ROLE_SKILL_DEFAULTS: Record<string, string[]> = {
  cto: ["paperclip-create-agent", "paperclip-manage-skills"],
  engineer: ["code-review", "git-workflow"],
  designer: ["design-review"],
  pm: ["issue-triage"],
  qa: ["test-automation"],
  devops: ["deploy-ops"],
  researcher: ["web-research"],
  // ceo, cfo, cmo, general — no defaults
};

/**
 * Returns the default skill keys for a given agent role.
 * Returns an empty array for roles without configured defaults.
 */
export function getDefaultSkillsForRole(role: string): string[] {
  return ROLE_SKILL_DEFAULTS[role] ?? [];
}
