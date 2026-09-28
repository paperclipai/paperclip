import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildMuseSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "muse_local",
    availableEntries,
    desiredSkills,
    configuredDetail: "Will be copied into `.agents/skills` in the execution workspace on the next run.",
  });
}

export async function listMuseSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildMuseSkillSnapshot(ctx.config);
}

export async function syncMuseSkills(ctx: AdapterSkillContext, _desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  return buildMuseSkillSnapshot(ctx.config);
}
