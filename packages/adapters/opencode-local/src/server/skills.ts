import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  ensurePaperclipSkillSymlink,
  listPaperclipSkillEntries,
  readPaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveOpenCodeSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".claude", "skills");
}

function resolveDesiredSkillNames(config: Record<string, unknown>, availableSkillNames: string[]) {
  const preference = readPaperclipSkillSyncPreference(config);
  return preference.explicit ? preference.desiredSkills : availableSkillNames;
}

async function readInstalledSkillTargets(skillsHome: string) {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, { targetPath: string | null; kind: "symlink" | "directory" | "file" }>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    if (entry.isSymbolicLink()) {
      const linkedPath = await fs.readlink(fullPath).catch(() => null);
      out.set(entry.name, {
        targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
        kind: "symlink",
      });
      continue;
    }
    if (entry.isDirectory()) {
      out.set(entry.name, { targetPath: fullPath, kind: "directory" });
      continue;
    }
    out.set(entry.name, { targetPath: fullPath, kind: "file" });
  }
  return out;
}

async function buildOpenCodeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await listPaperclipSkillEntries(__moduleDir);
  const availableByName = new Map(availableEntries.map((entry) => [entry.name, entry]));
  const desiredSkills = resolveDesiredSkillNames(
    config,
    availableEntries.map((entry) => entry.name),
  );
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveOpenCodeSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [
    "OpenCode currently uses the shared Claude skills home (~/.claude/skills).",
  ];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.name) ?? null;
    const desired = desiredSet.has(available.name);
    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = "Installed in the shared Claude/OpenCode skills home.";
    } else if (installedEntry) {
      state = "external";
      detail = desired
        ? "Skill name is occupied by an external installation in the shared skills home."
        : "Installed outside Paperclip management in the shared skills home.";
    } else if (desired) {
      state = "missing";
      detail = "Configured but not currently linked into the shared Claude/OpenCode skills home.";
    }

    entries.push({
      name: available.name,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.name),
      detail,
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByName.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      name: desiredSkill,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: path.join(skillsHome, desiredSkill),
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableByName.has(name)) continue;
    entries.push({
      name,
      desired: false,
      managed: false,
      state: "external",
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: "Installed outside Paperclip management in the shared skills home.",
    });
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  return {
    adapterType: "opencode_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listOpenCodeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx.config);
}

export async function syncOpenCodeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await listPaperclipSkillEntries(__moduleDir);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveOpenCodeSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByName = new Map(availableEntries.map((entry) => [entry.name, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.name)) continue;
    const target = path.join(skillsHome, available.name);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByName.get(name);
    if (!available) continue;
    if (desiredSet.has(name)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildOpenCodeSkillSnapshot(ctx.config);
}

export function resolveOpenCodeDesiredSkillNames(
  config: Record<string, unknown>,
  availableSkillNames: string[],
) {
  return resolveDesiredSkillNames(config, availableSkillNames);
}
