import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterSkillContext, AdapterSkillEntry, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import { parseHermesProfileConfig, profileHome } from "./config.js";

function configuredDesired(config: Record<string, unknown>, available: AdapterSkillEntry[]): string[] {
  const raw = config.desiredSkills ?? config.skills;
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) return raw as string[];
  return available.filter((entry) => entry.required).map((entry) => entry.key);
}

async function walkSkillFiles(root: string): Promise<string[]> {
  async function walk(dir: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await walk(full)));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(full);
      }
    }
    return results;
  }
  return walk(root);
}

function skillNameFromPath(profileSkillsRoot: string, skillFile: string): { key: string; runtimeName: string } {
  const rel = path.relative(profileSkillsRoot, path.dirname(skillFile));
  const parts = rel.split(path.sep).filter(Boolean);
  const runtimeName = parts.at(-1) ?? rel;
  return { key: `hermes-profile/${parts.join("/")}`, runtimeName };
}

export async function listHermesProfileSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const config = parseHermesProfileConfig(ctx.config);
  const skillsRoot = path.join(profileHome(config.profile), "skills");
  const skillFiles = await walkSkillFiles(skillsRoot);
  const entries: AdapterSkillEntry[] = skillFiles.sort().map((skillFile) => {
    const { key, runtimeName } = skillNameFromPath(skillsRoot, skillFile);
    return {
      key,
      runtimeName,
      desired: false,
      managed: false,
      state: "installed",
      origin: "user_installed",
      originLabel: `Hermes profile ${config.profile}`,
      locationLabel: path.relative(profileHome(config.profile), skillFile),
      readOnly: true,
      sourcePath: skillFile,
      targetPath: null,
      detail: "Profile-local Hermes skill; adapter exposes inventory read-only.",
    };
  });

  const desiredSkills = configuredDesired(ctx.config, entries);
  const desiredSet = new Set(desiredSkills);
  for (const entry of entries) {
    entry.desired = desiredSet.has(entry.key) || desiredSet.has(entry.runtimeName ?? "");
    if (entry.desired) entry.state = "configured";
  }

  return {
    adapterType: "hermes_profile",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings: ["syncSkills is read-only for hermes_profile: profile-local skills are not mutated by Paperclip."],
  };
}

export async function syncHermesProfileSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[] = [],
): Promise<AdapterSkillSnapshot> {
  const snapshot = await listHermesProfileSkills({ ...ctx, config: { ...ctx.config, desiredSkills } });
  return {
    ...snapshot,
    desiredSkills,
    warnings: ["hermes_profile skill sync is read-only; no profile skill files were modified."],
  };
}
