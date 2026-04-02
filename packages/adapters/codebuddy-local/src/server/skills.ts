import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterSkillContext, AdapterSkillSnapshot } from "@penclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  removeMaintainerOnlySkillSymlinks,
  resolvePaperclipDesiredSkillNames,
} from "@penclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function resolveCodeBuddyHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredCodeBuddyHome = asString(env.CODEBUDDY_HOME);
  if (configuredCodeBuddyHome) return path.resolve(configuredCodeBuddyHome);

  const configuredHome = asString(env.HOME);
  const processCodeBuddyHome =
    typeof process.env.CODEBUDDY_HOME === "string" && process.env.CODEBUDDY_HOME.trim().length > 0
      ? process.env.CODEBUDDY_HOME.trim()
      : "";
  const processHome =
    typeof process.env.HOME === "string" && process.env.HOME.trim().length > 0
      ? process.env.HOME.trim()
      : "";
  return path.resolve(processCodeBuddyHome || path.join(configuredHome || processHome || os.homedir(), ".codebuddy"));
}

export function resolveCodeBuddySkillsHome(config: Record<string, unknown>) {
  return path.join(resolveCodeBuddyHome(config), "skills");
}

type EnsureCodeBuddySkillsInjectedOptions = {
  config?: Record<string, unknown>;
  skillsDir?: string | null;
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames?: string[];
  skillsHome?: string;
  linkSkill?: (source: string, target: string) => Promise<void>;
};

export async function ensureCodeBuddySkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCodeBuddySkillsInjectedOptions = {},
) {
  const config = options.config ?? {};
  const skillsEntries = options.skillsEntries
    ?? (options.skillsDir
      ? (await fs.readdir(options.skillsDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({
            key: entry.name,
            runtimeName: entry.name,
            source: path.join(options.skillsDir!, entry.name),
          }))
      : await readPaperclipRuntimeSkillEntries(config, __moduleDir));
  if (skillsEntries.length === 0) return;

  const desiredNames = options.desiredSkillNames ?? resolvePaperclipDesiredSkillNames(config, skillsEntries);
  const desiredSet = new Set(desiredNames);
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? resolveCodeBuddySkillsHome(config);
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare CodeBuddy skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }

  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only CodeBuddy skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  const linkSkill = options.linkSkill ?? ((source: string, target: string) => fs.symlink(source, target));
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} CodeBuddy skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject CodeBuddy skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildCodeBuddySkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveCodeBuddySkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "codebuddy_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.codebuddy/skills",
    missingDetail: "Configured but not currently linked into the CodeBuddy skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listCodeBuddySkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildCodeBuddySkillSnapshot(ctx.config);
}

export async function syncCodeBuddySkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const skillsHome = resolveCodeBuddySkillsHome(ctx.config);
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

  return buildCodeBuddySkillSnapshot(ctx.config);
}
