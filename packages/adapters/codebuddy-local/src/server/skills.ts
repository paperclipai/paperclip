import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildCodeBuddySkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "codebuddy_local",
    availableEntries,
    desiredSkills,
    configuredDetail:
      "Will be copied into `.codebuddy/skills` and `.claude/skills` in the execution workspace on the next run.",
  });
}

export async function listCodeBuddySkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildCodeBuddySkillSnapshot(ctx.config);
}

export async function syncCodeBuddySkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildCodeBuddySkillSnapshot(ctx.config);
}
