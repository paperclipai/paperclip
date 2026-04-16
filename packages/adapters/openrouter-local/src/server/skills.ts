import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AdapterSkillContext, AdapterSkillEntry, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildOpenRouterSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);

  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: entry.required ? "paperclip_required" : "company_managed",
    originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be injected into the agent's context on the next run."
      : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));

  const warnings: string[] = [];
  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: undefined,
      targetPath: undefined,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));

  return {
    adapterType: "openrouter_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listOpenRouterSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOpenRouterSkillSnapshot(ctx.config);
}

export async function syncOpenRouterSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildOpenRouterSkillSnapshot(ctx.config);
}
