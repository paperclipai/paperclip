import fs from "node:fs/promises";
import path from "node:path";

import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const MAX_SKILL_CHARS = 20_000;
const MAX_TOTAL_SKILL_CHARS = 60_000;

export interface ResolvedGatewaySkillSection {
  key: string;
  content: string;
}

/**
 * Resolve the agent's desired Paperclip company skills and read each one's
 * SKILL.md so its content can be inlined into the hermes_gateway wake
 * prompt. Unlike hermes_local (which materializes skill files under the
 * profile's own filesystem and passes them to Hermes via `--skills`), a
 * gateway-mode Hermes process is remote and reached only over its HTTP API —
 * there is no local filesystem or CLI flag Paperclip can hand skills to, so
 * inlining the content directly into the prompt is the only delivery path
 * available.
 *
 * Fails closed: a skill that is explicitly desired but whose SKILL.md
 * cannot be read, or that would push the combined skill content past the
 * total size budget, throws rather than silently running the agent
 * without a skill it was promised.
 */
export async function resolveDesiredGatewaySkillSections(
  config: Record<string, unknown>,
  moduleDir: string,
): Promise<ResolvedGatewaySkillSection[]> {
  const available = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredNames = resolvePaperclipDesiredSkillNames(config, available);
  if (desiredNames.length === 0) return [];

  const availableByKey = new Map(available.map((entry) => [entry.key, entry]));
  const sections: ResolvedGatewaySkillSection[] = [];
  let totalChars = 0;

  for (const desired of desiredNames) {
    const entry = availableByKey.get(desired);
    if (!entry) {
      throw new Error(`Desired company skill ${JSON.stringify(desired)} is unavailable.`);
    }
    if (entry.sourceStatus === "missing") {
      throw new Error(entry.missingDetail || `Company skill source is missing: ${entry.source}`);
    }

    const skillMdPath = path.join(entry.source, "SKILL.md");
    let content: string;
    try {
      content = (await fs.readFile(skillMdPath, "utf8")).trim();
    } catch (err) {
      throw new Error(
        `Company skill ${JSON.stringify(desired)} is missing SKILL.md at ${skillMdPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!content) continue;

    if (content.length > MAX_SKILL_CHARS) {
      content = `${content.slice(0, MAX_SKILL_CHARS)}\n... [truncated ${content.length - MAX_SKILL_CHARS} chars]`;
    }
    if (totalChars + content.length > MAX_TOTAL_SKILL_CHARS) {
      // Fail closed here too: silently dropping this skill (and any after
      // it) would mean the agent runs believing it has every assigned skill
      // when it does not, exactly the failure mode this module exists to
      // prevent for missing/unreadable sources.
      throw new Error(
        `Desired company skill ${JSON.stringify(desired)} would exceed the combined skill size budget ` +
          `(${MAX_TOTAL_SKILL_CHARS} chars). Reduce the number or size of skills assigned to this agent.`,
      );
    }
    totalChars += content.length;
    sections.push({ key: entry.key, content });
  }

  return sections;
}
