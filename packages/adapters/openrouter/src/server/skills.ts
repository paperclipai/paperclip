/**
 * Skill loading for the OpenRouter adapter.
 *
 * Reads SKILL.md files from a skills directory and returns their contents
 * for injection into the system prompt.
 *
 * Discovery order for the skills root:
 *   1. agentConfig.skillsDir (per-agent override)
 *   2. PAPERCLIP_SKILLS_DIR env var (server-wide override)
 *   3. ~/.openrouter-adapter/skills (default managed root)
 *
 * v1 design: scan the root, load every subdirectory that contains a SKILL.md,
 * inject all of them. We do NOT yet integrate with Paperclip's "desired skills"
 * registry — that requires API access and is deferred to v3. For now, the
 * operator controls which skills an agent gets by what they put in the
 * skills directory.
 *
 * Failure mode: best-effort. Missing directory or unreadable files log a
 * warning and return what we have. Skill loading never fails the run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OnLog } from "./transcript.js";
import { writeRawStderr } from "./transcript.js";

export interface LoadedSkill {
  name: string;
  path: string;
  content: string;
}

export interface LoadSkillsParams {
  agentConfig: Record<string, unknown>;
  onLog: OnLog;
}

function resolveSkillsRoot(agentConfig: Record<string, unknown>): string {
  const fromConfig = typeof agentConfig.skillsDir === "string" ? agentConfig.skillsDir.trim() : "";
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.PAPERCLIP_SKILLS_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".openrouter-adapter", "skills");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadSkills(params: LoadSkillsParams): Promise<LoadedSkill[]> {
  const { agentConfig, onLog } = params;
  const root = resolveSkillsRoot(agentConfig);

  if (!(await pathExists(root))) {
    // Not an error — most agents won't have skills configured.
    return [];
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[openrouter] could not read skills root ${root}: ${reason}`);
    return [];
  }

  const loaded: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillName = entry.name;
    const skillMdPath = path.join(root, skillName, "SKILL.md");
    if (!(await pathExists(skillMdPath))) continue;
    try {
      const content = await fs.readFile(skillMdPath, "utf8");
      loaded.push({ name: skillName, path: skillMdPath, content });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] failed to read skill "${skillName}": ${reason}`);
    }
  }

  return loaded;
}

/**
 * Render loaded skills as a single block of text suitable for prepending to
 * the system prompt. Each skill is wrapped in a fenced section so the model
 * can tell where one ends and the next begins.
 */
export function renderSkillsForPrompt(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map((s) => `## Skill: ${s.name}\n\n${s.content.trim()}`);
  return [
    "# Available Skills",
    "",
    "The following skills are available to you. Read them carefully and apply them when relevant.",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}
