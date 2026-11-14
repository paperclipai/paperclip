import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Kimchi keeps its config under ~/.config/kimchi/ (harness settings,
 * models.json) but exposes no skills-dir contract Paperclip can manage: no
 * --skills-dir-style flag, and no documented skills directory under that
 * config root in v0.0.7. listSkills/syncSkills are therefore reporting-only
 * (mode "unsupported"): desired Paperclip skills are tracked in Paperclip but
 * never delivered to the agent, and sync never writes into a config root the
 * adapter does not own.
 */
async function buildKimchiSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "kimchi_local",
    availableEntries,
    desiredSkills,
    mode: "unsupported",
    configuredDetail:
      "Kimchi does not expose a skills directory Paperclip can manage; desired skills are tracked in Paperclip but not delivered to the agent.",
  });
}

export async function listKimchiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildKimchiSkillSnapshot(ctx.config);
}

export async function syncKimchiSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildKimchiSkillSnapshot(ctx.config);
}
