import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPaperclipRuntimeSkillEntries } from "@paperclipai/adapter-utils/server-utils";
import type { RuntimeSkill } from "./tools.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Extract the `description` value from SKILL.md YAML frontmatter. */
export function parseSkillDescription(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return "";
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const field = /^description:\s*(.*)$/.exec(line);
    if (!field) continue;
    const inline = field[1].trim();
    if (inline && !/^[>|][+-]?$/.test(inline)) {
      return inline.replace(/^["']|["']$/g, "").trim();
    }
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const next = lines[cursor];
      if (next.trim() && !/^\s/.test(next)) break;
      block.push(next.trim());
    }
    return block.filter(Boolean).join(" ").trim();
  }
  return "";
}

export async function loadRuntimeSkills(config: Record<string, unknown>): Promise<RuntimeSkill[]> {
  const entries = await readPaperclipRuntimeSkillEntries(config, __moduleDir).catch(() => []);
  const skills: RuntimeSkill[] = [];
  for (const entry of entries) {
    if (entry.sourceStatus === "missing") continue;
    let description = "";
    try {
      description = parseSkillDescription(await fs.readFile(path.join(entry.source, "SKILL.md"), "utf8"));
    } catch {
      continue;
    }
    skills.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      source: entry.source,
      description,
    });
  }
  return skills;
}
