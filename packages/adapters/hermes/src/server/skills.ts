import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_MANAGED_SKILLS_MANIFEST = ".paperclip-managed-skills.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function envString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (
    value &&
    typeof value === "object" &&
    "value" in value &&
    typeof (value as { value?: unknown }).value === "string" &&
    (value as { value: string }).value.trim().length > 0
  ) {
    return (value as { value: string }).value.trim();
  }
  return null;
}

function configEnv(config: Record<string, unknown>): Record<string, unknown> {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  return env;
}

function extractProfileFromArgs(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i];
    if (typeof raw !== "string") continue;
    const arg = raw.trim();
    if (!arg) continue;

    const profilePairMatch = arg.match(/^(--profile|-p)\s+(.+)$/);
    if (profilePairMatch) return profilePairMatch[2].trim() || null;

    if (arg === "--profile" || arg === "-p") {
      const next = value[i + 1];
      return typeof next === "string" && next.trim().length > 0 ? next.trim() : null;
    }

    if (arg.startsWith("--profile=") || arg.startsWith("-p=")) {
      const [, profile = ""] = arg.split("=", 2);
      return profile.trim() || null;
    }
  }

  return null;
}

export function resolveHermesSkillsHome(config: Record<string, unknown>): string {
  const env = configEnv(config);
  const configuredHermesHome = envString(env.HERMES_HOME);
  const configuredHome = envString(env.HOME);
  const hermesHome = configuredHermesHome
    ? path.resolve(configuredHermesHome)
    : path.join(configuredHome ? path.resolve(configuredHome) : os.homedir(), ".hermes");
  const profile = extractProfileFromArgs(config.extraArgs);
  return profile
    ? path.join(hermesHome, "profiles", profile, "skills")
    : path.join(hermesHome, "skills");
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

interface ManagedSkillManifestEntry {
  key: string;
  runtimeName: string;
  hermesName: string;
  source: string;
  target: string;
  copiedAt: string;
}

interface ManagedSkillManifest {
  version: 1;
  managedBy: "paperclip";
  skills: Record<string, ManagedSkillManifestEntry>;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Strip quotes
    if (typeof val === "string" && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter as SkillFrontmatter;
}

function isSafeHermesSkillName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
}

async function readSkillDeclaredName(source: string, fallback: string): Promise<string> {
  try {
    const content = await fs.readFile(path.join(source, "SKILL.md"), "utf8");
    const frontmatter = parseSkillFrontmatter(content);
    const name = asString(frontmatter.name);
    if (name && isSafeHermesSkillName(name)) return name;
  } catch {
    // Fall back to Paperclip's runtime name below.
  }
  return fallback;
}

async function scanHermesSkills(
  skillsHome: string,
): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];

  try {
    const categories = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(skillsHome, cat.name);

      // Check if the category directory itself has a SKILL.md (top-level skill)
      const topLevelSkillMd = path.join(catPath, "SKILL.md");
      if (await fs.stat(topLevelSkillMd).catch(() => null)) {
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, path.join(skillsHome, cat.name)));
      }

      // Scan for sub-skills
      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          const key = item.name;
          entries.push(await buildSkillEntry(key, skillMd, path.join(skillsHome, cat.name, item.name)));
        }
      }
    }
  } catch {
    // ~/.hermes/skills/ doesn't exist — no skills available
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  locationPath: string,
): Promise<AdapterSkillEntry> {
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontmatter(content);
    description = fm.description ?? null;
  } catch {
    // ignore
  }

  return {
    key,
    runtimeName: key,
    desired: true, // Hermes loads all available skills
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: locationPath,
    readOnly: true, // Hermes manages its own skills — Paperclip can't toggle them
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

function emptyManagedSkillManifest(): ManagedSkillManifest {
  return {
    version: 1,
    managedBy: "paperclip",
    skills: {},
  };
}

async function readManagedSkillManifest(skillsHome: string): Promise<ManagedSkillManifest> {
  const manifestPath = path.join(skillsHome, PAPERCLIP_MANAGED_SKILLS_MANIFEST);
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      (parsed as { managedBy?: unknown }).managedBy !== "paperclip" ||
      typeof (parsed as { skills?: unknown }).skills !== "object" ||
      (parsed as { skills?: unknown }).skills === null ||
      Array.isArray((parsed as { skills?: unknown }).skills)
    ) {
      return emptyManagedSkillManifest();
    }
    return parsed as ManagedSkillManifest;
  } catch {
    return emptyManagedSkillManifest();
  }
}

async function writeManagedSkillManifest(skillsHome: string, manifest: ManagedSkillManifest): Promise<void> {
  await fs.mkdir(skillsHome, { recursive: true });
  await fs.writeFile(
    path.join(skillsHome, PAPERCLIP_MANAGED_SKILLS_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function copyDirectory(source: string, target: string): Promise<void> {
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(target);
  const relativeTarget = path.relative(sourceRoot, targetRoot);
  const relativeSource = path.relative(targetRoot, sourceRoot);
  if (
    !relativeTarget ||
    (!relativeTarget.startsWith("..") && !path.isAbsolute(relativeTarget)) ||
    !relativeSource ||
    (!relativeSource.startsWith("..") && !path.isAbsolute(relativeSource))
  ) {
    throw new Error("Refusing to copy a skill into itself, an ancestor, or one of its descendants.");
  }

  const sourceStat = await fs.lstat(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error("Paperclip skills must be real directories.");
  }

  const tempRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;

  async function copyEntry(sourcePath: string, targetPath: string): Promise<void> {
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      await fs.mkdir(targetPath, { recursive: true });
      const entries = await fs.readdir(sourcePath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        await copyEntry(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, stat.mode).catch(() => {});
  }

  try {
    await copyEntry(sourceRoot, tempRoot);
    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.rename(tempRoot, targetRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function isManifestManaged(
  manifest: ManagedSkillManifest,
  runtimeName: string,
  source: string,
  target: string,
): boolean {
  const entry = manifest.skills[runtimeName];
  return entry?.source === path.resolve(source) && entry.target === path.resolve(target);
}

function manifestManagedTargets(manifest: ManagedSkillManifest): Set<string> {
  return new Set(
    Object.values(manifest.skills).map((entry) => path.resolve(entry.target)),
  );
}

async function isSafeManagedTarget(
  manifest: ManagedSkillManifest,
  target: string,
): Promise<boolean> {
  const resolvedTarget = path.resolve(target);
  for (const entry of Object.values(manifest.skills)) {
    if (path.resolve(entry.target) === resolvedTarget) return true;
  }
  return !(await fs.stat(target).then(() => true).catch(() => false));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const hermesSkillsHome = resolveHermesSkillsHome(config);
  const manifest = await readManagedSkillManifest(hermesSkillsHome);

  // 1. Scan Paperclip-managed skills (bundled with the adapter)
  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  // 2. Scan Hermes's own skills from ~/.hermes/skills/
  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome);
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));
  const paperclipRuntimeNames = new Set(paperclipEntries.map((entry) => entry.runtimeName));
  const managedTargets = manifestManagedTargets(manifest);

  // 3. Merge: Paperclip skills first, then Hermes skills
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  // Paperclip-managed skills
  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    const hermesName = await readSkillDeclaredName(entry.source, entry.runtimeName);
    const targetPath = path.join(hermesSkillsHome, hermesName);
    const managed = isManifestManaged(manifest, entry.runtimeName, entry.source, targetPath);
    const targetExists = await fs.stat(path.join(targetPath, "SKILL.md")).then(() => true).catch(() => false);
    const state = managed && targetExists
      ? desired
        ? "installed"
        : "stale"
      : desired
        ? "missing"
        : "available";
    entries.push({
      key: entry.key,
      runtimeName: hermesName,
      desired,
      managed: true,
      state,
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath,
      detail: state === "installed"
        ? "Copied into the Hermes profile skills directory under the SKILL.md name."
        : state === "stale"
          ? "Copied into the Hermes profile skills directory but no longer selected."
          : desired
            ? "Configured but not currently copied into the Hermes profile skills directory."
            : null,
    });
  }

  // Hermes-installed skills (read-only, always loaded)
  for (const entry of hermesSkillEntries) {
    // Skip Paperclip-managed copies. They are reported through the managed
    // entries above, even though Hermes also sees them as profile-local skills.
    if (
      availableByKey.has(entry.key) ||
      (typeof entry.runtimeName === "string" && paperclipRuntimeNames.has(entry.runtimeName)) ||
      (typeof entry.sourcePath === "string" &&
        managedTargets.has(path.resolve(path.dirname(entry.sourcePath))))
    ) {
      continue;
    }
    entries.push(entry);
  }

  // Check for desired skills that don't exist
  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill) || hermesKeys.has(desiredSkill)) continue;
    warnings.push(
      `Desired skill "${desiredSkill}" is not available in Paperclip or Hermes skills.`,
    );
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
      detail:
        "Cannot find this skill in Paperclip or the Hermes profile skills directory.",
    });
  }

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set(desiredSkills);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));
  const skillsHome = resolveHermesSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });

  const manifest = await readManagedSkillManifest(skillsHome);
  const nextManifest = emptyManagedSkillManifest();

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const hermesName = await readSkillDeclaredName(available.source, available.runtimeName);
    const preferredTarget = path.join(skillsHome, hermesName);
    const target = await isSafeManagedTarget(manifest, preferredTarget)
      ? preferredTarget
      : path.join(skillsHome, available.runtimeName);
    await copyDirectory(available.source, target);
    nextManifest.skills[available.runtimeName] = {
      key: available.key,
      runtimeName: available.runtimeName,
      hermesName: path.basename(target),
      source: path.resolve(available.source),
      target: path.resolve(target),
      copiedAt: new Date().toISOString(),
    };
  }

  for (const [runtimeName, manifestEntry] of Object.entries(manifest.skills)) {
    const available = availableByRuntimeName.get(runtimeName);
    const nextEntry = nextManifest.skills[runtimeName];
    if (nextEntry?.target === manifestEntry.target) continue;
    if (!available || !desiredSet.has(available.key) || nextEntry?.target !== manifestEntry.target) {
      const target = path.resolve(manifestEntry.target);
      const relative = path.relative(path.resolve(skillsHome), target);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  await writeManagedSkillManifest(skillsHome, nextManifest);
  return buildHermesSkillSnapshot(ctx.config);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
): string[] {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
