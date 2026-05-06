import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterSkillContext, AdapterSkillEntry, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import { parseHermesProfileConfig } from "./config.js";

function resolveProfileBase(config: Record<string, unknown>, profile: string): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : null;
  const hermesBase = configuredHome ? path.join(configuredHome, ".hermes") : path.join(os.homedir(), ".hermes");
  return path.join(hermesBase, "profiles", profile);
}

interface RuntimeSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  required?: boolean;
  requiredReason?: string | null;
}

interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "directory" | "file";
}

function asRuntimeSkillEntry(value: unknown): RuntimeSkillEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const key = typeof entry.key === "string" ? entry.key.trim() : "";
  const runtimeName = typeof entry.runtimeName === "string" ? entry.runtimeName.trim() : "";
  const source = typeof entry.source === "string" ? entry.source.trim() : "";
  if (!key || !runtimeName || !source) return null;
  return {
    key,
    runtimeName,
    source,
    required: entry.required === true,
    requiredReason: typeof entry.requiredReason === "string" && entry.requiredReason.trim() ? entry.requiredReason.trim() : null,
  };
}

function runtimeSkillEntries(config: Record<string, unknown>): RuntimeSkillEntry[] {
  return Array.isArray(config.paperclipRuntimeSkills)
    ? config.paperclipRuntimeSkills.map(asRuntimeSkillEntry).filter((entry): entry is RuntimeSkillEntry => Boolean(entry))
    : [];
}

function configuredDesired(config: Record<string, unknown>, available: RuntimeSkillEntry[]): string[] {
  const raw = config.paperclipSkillSync;
  const desiredFromPreference = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).desiredSkills
    : undefined;
  const desired = Array.isArray(desiredFromPreference)
    ? desiredFromPreference
    : Array.isArray(config.desiredSkills)
      ? config.desiredSkills
      : Array.isArray(config.skills)
        ? config.skills
        : null;
  if (desired?.every((item) => typeof item === "string")) {
    return Array.from(new Set([...available.filter((entry) => entry.required).map((entry) => entry.key), ...desired.map((item) => item.trim()).filter(Boolean)]));
  }
  return Array.from(new Set(available.filter((entry) => entry.required).map((entry) => entry.key)));
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
        results.push(...await walk(full));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(full);
      }
    }
    return results;
  }
  return walk(root);
}

function profileSkillNameFromPath(profileSkillsRoot: string, skillFile: string): { key: string; runtimeName: string } {
  const rel = path.relative(profileSkillsRoot, path.dirname(skillFile));
  const parts = rel.split(path.sep).filter(Boolean);
  const runtimeName = parts.at(-1) ?? rel;
  return { key: `hermes-profile/${parts.join("/")}`, runtimeName };
}

async function installedSkillTargets(skillsRoot: string): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const full = path.join(skillsRoot, entry.name);
    if (entry.isSymbolicLink()) {
      const linkedPath = await fs.readlink(full).catch(() => null);
      out.set(entry.name, { kind: "symlink", targetPath: linkedPath ? path.resolve(path.dirname(full), linkedPath) : null });
    } else if (entry.isDirectory()) {
      out.set(entry.name, { kind: "directory", targetPath: full });
    } else if (entry.isFile()) {
      out.set(entry.name, { kind: "file", targetPath: full });
    }
  }
  return out;
}

async function ensureSymlink(source: string, target: string): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target);
    return "created";
  }
  if (!existing.isSymbolicLink()) return "skipped";
  const linkedPath = await fs.readlink(target).catch(() => null);
  const resolved = linkedPath ? path.resolve(path.dirname(target), linkedPath) : null;
  if (resolved === source) return "skipped";
  if (resolved && await fs.stat(resolved).then(() => true).catch(() => false)) return "skipped";
  await fs.unlink(target);
  await fs.symlink(source, target);
  return "repaired";
}

async function removeManagedSymlinks(skillsRoot: string, allowedRuntimeNames: Iterable<string>, availableSources: Set<string>): Promise<string[]> {
  const allowed = new Set(allowedRuntimeNames);
  const removed: string[] = [];
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (allowed.has(entry.name) || !entry.isSymbolicLink()) continue;
    const target = path.join(skillsRoot, entry.name);
    const linkedPath = await fs.readlink(target).catch(() => null);
    const resolved = linkedPath ? path.resolve(path.dirname(target), linkedPath) : null;
    if (!resolved || !availableSources.has(resolved)) continue;
    await fs.unlink(target);
    removed.push(entry.name);
  }
  return removed;
}

function buildSnapshot(input: {
  profile: string;
  skillsRoot: string;
  available: RuntimeSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  profileEntries: AdapterSkillEntry[];
  warnings?: string[];
}): AdapterSkillSnapshot {
  const availableByKey = new Map(input.available.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(input.desiredSkills);
  const entries: AdapterSkillEntry[] = [];
  const managedRuntimeNames = new Set<string>();

  for (const available of input.available) {
    const installed = input.installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AdapterSkillEntry["state"] = desired ? "missing" : "available";
    let managed = false;
    let detail: string | null = desired ? "Will be linked into this Hermes profile's skills directory." : null;
    if (installed?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = "Paperclip-managed skill linked into this Hermes profile.";
      managedRuntimeNames.add(available.runtimeName);
    } else if (installed) {
      state = "external";
      detail = desired
        ? "A profile-local skill with this runtime name already exists; Paperclip will not overwrite it."
        : "Profile-local skill with same runtime name; not managed by Paperclip.";
    }
    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      desired,
      managed,
      required: Boolean(available.required),
      requiredReason: available.requiredReason ?? null,
      state,
      origin: available.required ? "paperclip_required" : "company_managed",
      originLabel: available.required ? "Required by Paperclip" : "Managed by Paperclip",
      locationLabel: `Hermes profile ${input.profile}`,
      readOnly: false,
      sourcePath: available.source,
      targetPath: path.join(input.skillsRoot, available.runtimeName),
      detail,
    });
  }

  for (const desiredSkill of input.desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the runtime skills directory.",
    });
  }

  for (const entry of input.profileEntries) {
    if (entry.runtimeName && managedRuntimeNames.has(entry.runtimeName)) continue;
    entries.push(entry);
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));
  return {
    adapterType: "hermes_profile",
    supported: true,
    mode: "persistent",
    desiredSkills: input.desiredSkills,
    entries,
    warnings: input.warnings ?? [],
  };
}

async function profileLocalSkillEntries(profileBase: string, profile: string, skillsRoot: string, managedSources: Set<string>): Promise<AdapterSkillEntry[]> {
  const skillFiles = await walkSkillFiles(skillsRoot);
  return skillFiles.sort().flatMap((skillFile) => {
    const skillDir = path.dirname(skillFile);
    const { key, runtimeName } = profileSkillNameFromPath(skillsRoot, skillFile);
    if (managedSources.has(skillDir)) return [];
    return [{
      key,
      runtimeName,
      desired: false,
      managed: false,
      state: "installed" as const,
      origin: "user_installed" as const,
      originLabel: `Hermes profile ${profile}`,
      locationLabel: path.relative(profileBase, skillFile),
      readOnly: true,
      sourcePath: skillFile,
      targetPath: null,
      detail: "Profile-local Hermes skill.",
    }];
  });
}

export async function listHermesProfileSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const config = parseHermesProfileConfig(ctx.config);
  const profileBase = resolveProfileBase(ctx.config, config.profile);
  const skillsRoot = path.join(profileBase, "skills");
  const available = runtimeSkillEntries(ctx.config);
  const desiredSkills = configuredDesired(ctx.config, available);
  const installed = await installedSkillTargets(skillsRoot);
  const managedSources = new Set(available.map((entry) => entry.source));
  const profileEntries = await profileLocalSkillEntries(profileBase, config.profile, skillsRoot, managedSources);
  return buildSnapshot({ profile: config.profile, skillsRoot, available, desiredSkills, installed, profileEntries });
}

export async function syncHermesProfileSkills(ctx: AdapterSkillContext, desiredSkills: string[] = []): Promise<AdapterSkillSnapshot> {
  const config = parseHermesProfileConfig(ctx.config);
  const profileBase = resolveProfileBase(ctx.config, config.profile);
  const skillsRoot = path.join(profileBase, "skills");
  const available = runtimeSkillEntries(ctx.config);
  const canonicalDesired = configuredDesired({ ...ctx.config, paperclipSkillSync: { desiredSkills } }, available);
  const desiredSet = new Set(canonicalDesired);
  const warnings: string[] = [];

  await fs.mkdir(skillsRoot, { recursive: true });
  for (const entry of available) {
    if (!desiredSet.has(entry.key)) continue;
    const target = path.join(skillsRoot, entry.runtimeName);
    const result = await ensureSymlink(entry.source, target);
    if (result === "skipped") {
      const existing = (await installedSkillTargets(skillsRoot)).get(entry.runtimeName);
      if (existing?.targetPath !== entry.source) {
        warnings.push(`Skill "${entry.key}" was not linked because ${entry.runtimeName} already exists in the profile.`);
      }
    }
  }
  const availableSources = new Set(available.map((entry) => entry.source));
  await removeManagedSymlinks(skillsRoot, available.filter((entry) => desiredSet.has(entry.key)).map((entry) => entry.runtimeName), availableSources);

  const installed = await installedSkillTargets(skillsRoot);
  const profileEntries = await profileLocalSkillEntries(profileBase, config.profile, skillsRoot, availableSources);
  return buildSnapshot({ profile: config.profile, skillsRoot, available, desiredSkills: canonicalDesired, installed, profileEntries, warnings });
}
