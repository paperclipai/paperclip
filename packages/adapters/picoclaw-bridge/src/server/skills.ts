import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the per-agent picoclaw workspace skills directory.
 * When PAPERCLIP_AGENT_ID is set, picoclaw uses a per-agent workspace under
 * ~/.paperclip/instances/{instanceId}/workspaces/{agentId}/  rather than its
 * default ~/.picoclaw/workspace.  Skill sync manages the skills/ subdirectory
 * of that per-agent workspace.
 */
export function resolvePicoSkillsHome(agentId: string): string {
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return path.join(
    os.homedir(),
    ".paperclip",
    "instances",
    instanceId,
    "workspaces",
    agentId,
    "skills",
  );
}

async function buildPicoSkillSnapshot(
  agentId: string,
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolvePicoSkillsHome(agentId);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "picoclaw_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.paperclip/instances/default/workspaces/<agent-id>/skills",
    missingDetail: "Configured but not currently linked into the picoclaw agent workspace.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listPicoSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildPicoSkillSnapshot(ctx.agentId, ctx.config);
}

export async function syncPicoSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const skillsHome = resolvePicoSkillsHome(ctx.agentId);
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

  return buildPicoSkillSnapshot(ctx.agentId, ctx.config);
}
