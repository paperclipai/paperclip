import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Mirrors claude-local's passthrough skill snapshot: skills are materialized
 * into the agent's cwd via the shared Paperclip runtime skills mechanism; the
 * adapter only reports which ones are desired/configured/installed.
 */
function resolveOllamaSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  // Conventional skills home for ollama_local — not used directly by the
  // Ollama server, but kept so a parallel UI inspector can display it.
  return path.join(home, ".ollama", "paperclip", "skills");
}

async function buildSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveOllamaSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
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
      ? "Materialized into the prompt bundle on the next heartbeat."
      : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));
  const warnings: string[] = [];

  for (const desired of desiredSkills) {
    if (availableByKey.has(desired)) continue;
    warnings.push(`Desired skill "${desired}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desired,
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

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: "~/.ollama/paperclip/skills",
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: "Installed outside Paperclip management.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "ollama_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listOllamaSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}

export async function syncOllamaSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}
