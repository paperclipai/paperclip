import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  listPaperclipSkillEntries,
  readPaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function resolveDesiredSkillNames(config: Record<string, unknown>, availableSkillNames: string[]) {
  const preference = readPaperclipSkillSyncPreference(config);
  return preference.explicit ? preference.desiredSkills : availableSkillNames;
}

async function buildClaudeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await listPaperclipSkillEntries(__moduleDir);
  const availableByName = new Map(availableEntries.map((entry) => [entry.name, entry]));
  const desiredSkills = resolveDesiredSkillNames(
    config,
    availableEntries.map((entry) => entry.name),
  );
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    name: entry.name,
    desired: desiredSet.has(entry.name),
    managed: true,
    state: desiredSet.has(entry.name) ? "configured" : "available",
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.name)
      ? "Will be mounted into the ephemeral Claude skill directory on the next run."
      : null,
  }));
  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableByName.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      name: desiredSkill,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: undefined,
      targetPath: undefined,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  return {
    adapterType: "claude_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listClaudeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildClaudeSkillSnapshot(ctx.config);
}

export async function syncClaudeSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildClaudeSkillSnapshot(ctx.config);
}

export function resolveClaudeDesiredSkillNames(
  config: Record<string, unknown>,
  availableSkillNames: string[],
) {
  return resolveDesiredSkillNames(config, availableSkillNames);
}
