import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { type } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildDistillSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: type,
    availableEntries,
    desiredSkills,
    configuredDetail: "Will be copied into `.claude/skills` in the execution workspace on the next run.",
  });
}

export async function listDistillSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildDistillSkillSnapshot(ctx.config);
}

export async function syncDistillSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildDistillSkillSnapshot(ctx.config);
}
