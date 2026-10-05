import fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveHermesHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  return configuredHome ? path.resolve(configuredHome) : os.homedir();
}

interface ManagedSkillSource {
  cliRoot: string;
  payload: string;
  suffix: string;
  identity: string;
}

function managedSkillSource(source: string, runtimeName: string, skillKey: string): ManagedSkillSource | null {
  const skill = path.resolve(source);
  const skills = path.dirname(skill);
  const pkg = path.dirname(skills);
  const scope = path.dirname(pkg);
  const modules = path.dirname(scope);
  const packaged = path.basename(scope) === "@paperclipai" && path.basename(modules) === "node_modules";
  const payload = packaged ? path.dirname(modules) : pkg;
  const sourceRoot = path.dirname(payload);
  const installs = path.dirname(sourceRoot);
  const cliRoot = path.dirname(installs);
  if (
    path.basename(skill) !== runtimeName || path.basename(skills) !== "skills"
    || !["npm", "git"].includes(path.basename(sourceRoot))
    || path.basename(installs) !== "installs" || path.basename(cliRoot) !== "cli"
    || (!packaged && (path.basename(sourceRoot) !== "git" || skillKey !== `paperclipai/paperclip/${runtimeName}`))
  ) return null;
  // The repository's root runtime skills are shipped in @paperclipai/server.
  const identity = path.join("@paperclipai", packaged ? path.basename(pkg) : "server", "skills", runtimeName);
  return { cliRoot, payload, suffix: path.relative(payload, skill), identity };
}

async function readOwnedInstallFile(file: string): Promise<string | null> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null;
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const stat = await handle.stat();
    const after = await fs.lstat(file);
    if (
      !stat.isFile() || stat.nlink !== 1
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1
      || (typeof process.getuid === "function" && after.uid !== process.getuid())
      || before.dev !== stat.dev || before.ino !== stat.ino
      || after.dev !== stat.dev || after.ino !== stat.ino
    ) return null;
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

// A retained manifest entry still proves ownership after its payload is removed.
// Resolve the existing prefix so a symlink in that prefix cannot escape the store.
async function canonicalPath(candidate: string): Promise<string> {
  let prefix = path.resolve(candidate);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await fs.realpath(prefix), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(prefix) === prefix) throw error;
      const existing = await fs.lstat(prefix).catch((statError: NodeJS.ErrnoException) => {
        if (statError.code !== "ENOENT") throw statError;
        return null;
      });
      if (existing?.isSymbolicLink()) throw error;
      missing.unshift(path.basename(prefix));
      prefix = path.dirname(prefix);
    }
  }
}

async function isRetainedManagedSkill(source: string, previous: string, runtimeName: string, skillKey: string): Promise<boolean> {
  const next = managedSkillSource(source, runtimeName, skillKey);
  const old = managedSkillSource(previous, runtimeName, skillKey);
  if (!next || !old || next.identity !== old.identity) return false;
  try {
    const cliRoot = await fs.realpath(next.cliRoot);
    if (await fs.realpath(old.cliRoot) !== cliRoot) return false;
    for (const directory of [next.cliRoot, path.join(next.cliRoot, "installs")]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return false;
    }
    if (await readOwnedInstallFile(path.join(cliRoot, ".managed-install")) !== "paperclipai managed install store v1\n") return false;
    const raw = await readOwnedInstallFile(path.join(cliRoot, "install.json"));
    if (!raw) return false;
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.previous)) return false;
    const registered = new Set<string>();
    for (const value of [manifest, ...manifest.previous]) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      if (typeof record.payloadPath !== "string" || !path.isAbsolute(record.payloadPath)) return false;
      const payload = await canonicalPath(record.payloadPath);
      const parts = path.relative(cliRoot, payload).split(path.sep);
      if (parts.length !== 3 || parts[0] !== "installs" || !["npm", "git"].includes(parts[1] ?? "")
        || record.source !== parts[1] || !/^[A-Za-z0-9._-]+$/.test(parts[2] ?? "")) return false;
      registered.add(payload);
    }
    for (const entry of [next, old]) {
      const payloadStat = await fs.lstat(entry.payload).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (payloadStat && (!payloadStat.isDirectory() || payloadStat.isSymbolicLink())) return false;
      const payload = await canonicalPath(entry.payload);
      if (!registered.has(payload)) return false;
      const skill = entry === next ? source : previous;
      if (await canonicalPath(skill) !== path.join(payload, entry.suffix)) return false;
    }
    return (await fs.stat(source)).isDirectory();
  } catch {
    return false;
  }
}

async function ensureHermesSkillLink(source: string, target: string, runtimeName: string, skillKey: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    const linked = await fs.readlink(target);
    const previous = path.resolve(path.dirname(target), linked);
    if (previous !== path.resolve(source)) {
      if (!await isRetainedManagedSkill(source, previous, runtimeName, skillKey)) return;
      const temporary = `${target}.tmp-${randomUUID()}`;
      try {
        await fs.symlink(path.resolve(source), temporary);
        const current = await fs.lstat(target);
        if (!current.isSymbolicLink() || current.dev !== existing.dev || current.ino !== existing.ino
          || await fs.readlink(target) !== linked) return;
        await fs.rename(temporary, target);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      return;
    }
  }
  await ensurePaperclipSkillSymlink(source, target);
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
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
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, cat.name));
      }

      // Scan for sub-skills
      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          const key = item.name;
          entries.push(await buildSkillEntry(key, skillMd, `${cat.name}/${item.name}`));
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
  categoryPath: string,
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
    locationLabel: `~/.hermes/skills/${categoryPath}`,
    readOnly: true, // Hermes manages its own skills — Paperclip can't toggle them
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const home = resolveHermesHome(config);
  const hermesSkillsHome = path.join(home, ".hermes", "skills");

  // 1. Scan Paperclip-managed skills (bundled with the adapter)
  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  // 2. Scan Hermes's own skills from ~/.hermes/skills/
  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome);
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));

  // 3. Merge: Paperclip skills first (ephemeral), then Hermes skills
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  // Paperclip-managed skills
  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Will be available on the next run via Hermes skill loading."
        : null,
    });
  }

  // Hermes-installed skills (read-only, always loaded)
  for (const entry of hermesSkillEntries) {
    // Skip if Paperclip already manages a skill with the same key
    if (availableByKey.has(entry.key)) continue;
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
        "Cannot find this skill in Paperclip or ~/.hermes/skills/.",
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

export async function reconcileHermesPaperclipSkills(
  config: Record<string, unknown>,
  requestedDesiredSkills?: string[],
): Promise<string[]> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = requestedDesiredSkills
    ? Array.from(new Set([
        ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
        ...requestedDesiredSkills,
      ]))
    : resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = path.join(resolveHermesHome(config), ".hermes", "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key) || isPaperclipSkillSourceMissing(entry)) continue;
    const target = path.join(skillsHome, entry.runtimeName);
    await ensureHermesSkillLink(entry.source, target, entry.runtimeName, entry.key);
    const linkedSource = await fs.readlink(target).catch(() => null);
    const resolvedSource = linkedSource
      ? path.resolve(path.dirname(target), linkedSource)
      : null;
    if (resolvedSource !== path.resolve(entry.source)) {
      throw new Error(
        `Cannot reconcile Hermes skill "${entry.key}" because ${target} is occupied by another installation.`,
      );
    }
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return desiredSkills;
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  await reconcileHermesPaperclipSkills(ctx.config, desiredSkills);
  return buildHermesSkillSnapshot(ctx.config);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string[] {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
