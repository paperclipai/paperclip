import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { crushSkillsDir } from "./command.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildCrushSkillSnapshot(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(ctx.config, availableEntries);
  const skillsHome = crushSkillsDir(ctx.companyId, ctx.agentId);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "crush_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "Paperclip agent Crush skills",
    missingDetail: "Configured but not currently linked into the Crush skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listCrushSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildCrushSkillSnapshot(ctx);
}

export async function syncCrushSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  const skillsHome = crushSkillsDir(ctx.companyId, ctx.agentId);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildCrushSkillSnapshot(ctx);
}
