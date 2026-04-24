import fs from "node:fs/promises";
import path from "node:path";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";

/**
 * Discover project-local Claude skills under `<cwd>/.claude/skills/`.
 *
 * Each immediate subdirectory that contains a `SKILL.md` file is treated as a
 * skill, matching Claude Code's native project-skill convention. Entries are
 * returned in stable (alphabetical) order so the prompt bundle cache key stays
 * deterministic across runs.
 *
 * Returns an empty array when `cwd` is missing, the `.claude/skills/` directory
 * does not exist, or it cannot be read.
 */
export async function readProjectWorkspaceSkills(
  cwd: string | null | undefined,
): Promise<PaperclipSkillEntry[]> {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return [];
  }

  const skillsDir = path.resolve(cwd, ".claude", "skills");
  let names: string[];
  try {
    names = await fs.readdir(skillsDir);
  } catch {
    return [];
  }

  const entries: PaperclipSkillEntry[] = [];
  for (const name of names) {
    if (!name || name.startsWith(".")) continue;

    const candidatePath = path.join(skillsDir, name);

    // Resolve symlinks to real directories so we don't accept dangling links.
    let isDirectory = false;
    try {
      const stat = await fs.stat(candidatePath);
      isDirectory = stat.isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;

    const skillManifest = path.join(candidatePath, "SKILL.md");
    try {
      await fs.access(skillManifest);
    } catch {
      // Not a skill directory (missing SKILL.md) — skip silently.
      continue;
    }

    entries.push({
      key: `project/${name}`,
      runtimeName: name,
      source: candidatePath,
    });
  }

  entries.sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
  return entries;
}
