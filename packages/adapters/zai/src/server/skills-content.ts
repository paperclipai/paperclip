import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const MAX_SKILL_BODY_CHARS = 12_000;
const MAX_TOTAL_INJECTION_CHARS = 60_000;

export interface ZaiSkillInjection {
  /** Combined markdown text to prepend to the system prompt. Empty when no skills are desired. */
  systemPromptAddendum: string;
  /** Names of skills successfully injected. */
  injectedKeys: string[];
  /** Names of skills that were desired but not found / unreadable. */
  skippedKeys: string[];
  /** Per-skill warnings worth surfacing in logs. */
  warnings: string[];
}

function stripFrontmatter(markdown: string): string {
  // Front-matter (YAML between --- ---) is config metadata; strip it from the
  // injected content so the model isn't distracted by required:/version: keys.
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized;
  return normalized.slice(closing + 5).replace(/^\n+/, "");
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: text.slice(0, max) + "\n\n[…content truncated to fit context budget…]",
    truncated: true,
  };
}

async function readSkillMarkdown(entry: PaperclipSkillEntry): Promise<string | null> {
  // Each skill is a directory; the file is SKILL.md per Paperclip convention.
  const skillFile = path.join(entry.source, "SKILL.md");
  try {
    return await fs.readFile(skillFile, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve and load the markdown content of every "desired" skill for this run.
 * Returns a single markdown block ready to be prepended to the system prompt.
 *
 * The returned addendum is wrapped in a header so the model knows what the
 * content is and how to use it; it also sets a hard char cap so a misconfigured
 * agent with 50 desired skills can't blow out the context window.
 */
export async function buildZaiSkillInjection(
  config: Record<string, unknown>,
): Promise<ZaiSkillInjection> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  if (availableEntries.length === 0) {
    return { systemPromptAddendum: "", injectedKeys: [], skippedKeys: [], warnings: [] };
  }

  const desiredKeys = resolvePaperclipDesiredSkillNames(config, availableEntries);
  if (desiredKeys.length === 0) {
    return { systemPromptAddendum: "", injectedKeys: [], skippedKeys: [], warnings: [] };
  }

  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const sections: string[] = [];
  const injectedKeys: string[] = [];
  const skippedKeys: string[] = [];
  const warnings: string[] = [];
  let totalChars = 0;

  for (const key of desiredKeys) {
    const entry = availableByKey.get(key);
    if (!entry) {
      skippedKeys.push(key);
      warnings.push(`Skill "${key}" is desired but not available locally — cannot inject.`);
      continue;
    }

    const raw = await readSkillMarkdown(entry);
    if (raw === null) {
      skippedKeys.push(key);
      warnings.push(`Skill "${key}" SKILL.md unreadable at ${entry.source} — cannot inject.`);
      continue;
    }

    const body = stripFrontmatter(raw).trim();
    if (body.length === 0) {
      skippedKeys.push(key);
      warnings.push(`Skill "${key}" has empty SKILL.md body — cannot inject.`);
      continue;
    }

    const { text: limited, truncated } = truncate(body, MAX_SKILL_BODY_CHARS);
    if (truncated) warnings.push(`Skill "${key}" content truncated to ${MAX_SKILL_BODY_CHARS} chars.`);

    const section = `### Skill: ${entry.runtimeName ?? entry.key}\n\n${limited}`;
    if (totalChars + section.length > MAX_TOTAL_INJECTION_CHARS) {
      warnings.push(
        `Skipping skill "${key}" — total skill injection would exceed ${MAX_TOTAL_INJECTION_CHARS} chars.`,
      );
      skippedKeys.push(key);
      continue;
    }

    sections.push(section);
    injectedKeys.push(key);
    totalChars += section.length;
  }

  if (sections.length === 0) {
    return { systemPromptAddendum: "", injectedKeys, skippedKeys, warnings };
  }

  const header =
    "You have been granted the following Paperclip skill bundles. Each is a markdown document " +
    "describing a capability you can use. Apply them where relevant; do not announce the skill " +
    "frontmatter, just use the knowledge.";
  const systemPromptAddendum = `${header}\n\n${sections.join("\n\n---\n\n")}`;

  return { systemPromptAddendum, injectedKeys, skippedKeys, warnings };
}
