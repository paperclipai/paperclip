import fs from "node:fs/promises";
import path from "node:path";
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
  resolvePaperclipDesiredSkillNames,
  asString as adapterAsString,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the .skills/ directory inside the agent's workspace.
 * Falls back to a temp-like path if no workspace is configured.
 */
function resolveSkillsHome(config: Record<string, unknown>): string {
  const cwd =
    typeof config.cwd === "string" && config.cwd.trim()
      ? config.cwd.trim()
      : null;
  // Use the workspace context if available (set by heartbeat before sync)
  const wsCtx = parseObject(config.paperclipWorkspace);
  const wsCwd = typeof wsCtx.cwd === "string" && wsCtx.cwd.trim() ? wsCtx.cwd.trim() : null;
  const agentHome = typeof wsCtx.agentHome === "string" && wsCtx.agentHome.trim() ? wsCtx.agentHome.trim() : null;
  const base = wsCwd || agentHome || cwd || "/tmp/paperclip-skills";
  return path.join(base, ".skills");
}

async function buildOpenrouterSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "openrouter_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: ".skills/ (agent workspace)",
    missingDetail: "Configured but not yet linked. Will be synced on next run.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listOpenrouterSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOpenrouterSkillSnapshot(ctx.config);
}

export async function syncOpenrouterSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const skillsHome = resolveSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  // Create symlinks for desired skills
  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  // Remove symlinks for non-desired skills
  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildOpenrouterSkillSnapshot(ctx.config);
}
