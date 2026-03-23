import os from "node:os";
import path from "node:path";

/**
 * Kiro skills home directory.
 *
 * Always returns ~/.kiro/skills/ — Kiro only scans top-level subdirectories
 * for SKILL.md files and does not recurse into nested directories.
 * Cross-company isolation is handled by the `<companyPrefix>--<skillName>`
 * directory naming convention, not by subdirectory nesting.
 */
export function kiroSkillsHome(): string {
  return path.join(os.homedir(), ".kiro", "skills");
}
