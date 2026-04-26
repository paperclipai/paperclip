import fs from "node:fs/promises";
import os from "node:os";
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
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveCursorSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".cursor", "skills");
}

async function buildCursorSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveCursorSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "cursor",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.cursor/skills",
    missingDetail: "Configured but not currently linked into the Cursor skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listCursorSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildCursorSkillSnapshot(ctx.config);
}

export async function syncCursorSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const skillsHome = resolveCursorSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  // NOTE: we intentionally do not unlink aliases for skills that this agent
  // no longer desires. The Cursor skills home (~/.cursor/skills) is global to
  // the host and shared across every local cursor agent on the machine, so a
  // symlink that is stale for this agent may still be the only alias backing
  // another agent's `installed` state. Cross-agent cleanup must happen from a
  // caller that knows the full union of desired skills; per-agent sync must
  // stay additive here.

  return buildCursorSkillSnapshot(ctx.config);
}

export function resolveCursorDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
