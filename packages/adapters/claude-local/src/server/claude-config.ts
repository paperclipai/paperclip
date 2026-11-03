import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterEnvironmentCheck,
  AdapterRuntimeMcpServer,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetUsesManagedHome,
  maybeRunSandboxInstallCommand,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetShellOptions,
} from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { classifyThrownErrorClass, logSandboxProbeDiagnostic } from "./probe-diagnostics.js";
import { selectManagedPluginMarketplaces, writeManagedPluginMarketplaces } from "./managed-plugin-marketplaces.js";
import { ensureManagedProfileSkillInstructions } from "./managed-profile-instructions.js";

const SEEDED_SHARED_FILES = ["settings.json", "CLAUDE.md"] as const;

interface SeedFile {
  name: string;
  sourcePath: string;
  contents: Buffer;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function readJsonObject(candidate: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(candidate, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileMetadata(
  rootDir: string,
  options: { excludeHiddenPaths?: boolean } = {},
): Promise<Array<{ path: string; size: number; contentHash: string }>> {
  const files: Array<{ path: string; size: number; contentHash: string }> = [];
  const candidates: Array<{ candidate: string; relativePath: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const relativePath = path.relative(rootDir, candidate);
      const rootEntry = relativePath.split(path.sep, 1)[0] ?? "";
      if (options.excludeHiddenPaths && rootEntry.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) candidates.push({ candidate, relativePath });
    }
  };
  if (await pathExists(rootDir)) await visit(rootDir);
  for (let offset = 0; offset < candidates.length; offset += 8) {
    await Promise.all(candidates.slice(offset, offset + 8).map(async ({ candidate, relativePath }) => {
      const stat = await fs.stat(candidate, { bigint: true });
      const cached = fileHashCache.get(candidate);
      const signature = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      let contentHash = cached?.signature === signature ? cached.contentHash : null;
      if (contentHash === null) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(candidate)) hash.update(chunk);
        contentHash = hash.digest("hex");
        fileHashCache.set(candidate, { signature, contentHash });
        if (fileHashCache.size > MAX_FILE_HASH_CACHE_ENTRIES) {
          const oldest = fileHashCache.keys().next().value;
          if (oldest) fileHashCache.delete(oldest);
        }
      } else {
        fileHashCache.delete(candidate);
        fileHashCache.set(candidate, { signature, contentHash });
      }
      files.push({
        path: relativePath,
        size: Number(stat.size),
        contentHash,
      });
    }));
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

const MAX_FILE_HASH_CACHE_ENTRIES = 20_000;
const fileHashCache = new Map<string, { signature: string; contentHash: string }>();

async function copyTreeWithoutSymlinks(sourceDir: string, targetDir: string): Promise<void> {
  if (!(await pathExists(sourceDir))) return;
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    filter: async (candidate) => path.resolve(candidate) === path.resolve(sourceDir) ||
      !(await fs.lstat(candidate)).isSymbolicLink(),
  });
}

async function copyManagedClaudeSkills(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  skillFiles: Array<{ path: string; targetPath?: string }>,
): Promise<void> {
  await fs.mkdir(targetSkillsDir, { recursive: true, mode: 0o700 });
  const skillDirs = new Map<string, string>();
  for (const entry of skillFiles) {
    if (path.basename(entry.path).toLowerCase() !== "skill.md") continue;
    const sourceSkillDir = path.dirname(entry.path);
    const targetSkillDir = path.dirname(entry.targetPath ?? entry.path);
    if (sourceSkillDir === "." || targetSkillDir === ".") continue;
    const existingSource = skillDirs.get(targetSkillDir);
    if (existingSource && existingSource !== sourceSkillDir) {
      throw new Error(`Claude profile contains multiple skills that map to the same name: ${targetSkillDir}`);
    }
    skillDirs.set(targetSkillDir, sourceSkillDir);
  }
  for (const [targetSkillDir, sourceSkillDir] of skillDirs) {
    const targetDirectory = path.join(targetSkillsDir, targetSkillDir);
    const targetExists = await fs.lstat(targetDirectory).then(() => true).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    // Paperclip's task-selected skills already occupy this name in the managed
    // config. Keep that link and avoid replacing it with a personal skill.
    if (targetExists) continue;
    await copyTreeWithoutSymlinks(path.join(sourceSkillsDir, sourceSkillDir), targetDirectory);
  }
}

const managedSkillImportLocks = new Map<string, Promise<void>>();

async function withManagedSkillImportLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = managedSkillImportLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  managedSkillImportLocks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (managedSkillImportLocks.get(key) === queued) managedSkillImportLocks.delete(key);
  }
}

function managedSkillImportManifestPath(stateDir: string, configDir: string): string {
  const targetHash = createHash("sha256").update(path.resolve(configDir)).digest("hex").slice(0, 24);
  return path.join(stateDir, "managed-plugin-cache", "skill-imports", `${targetHash}.json`);
}

interface ManagedSkillImportState {
  contentHash: string;
  complete: boolean;
}

async function writeManagedSkillImportManifest(
  manifestPath: string,
  skills: Map<string, ManagedSkillImportState>,
): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const tempPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify({
      version: 2,
      skills: Object.fromEntries([...skills].sort(([left], [right]) => left.localeCompare(right))),
    }), { mode: 0o600 });
    await fs.rename(tempPath, manifestPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function assertManagedSkillPathHasNoSymlinks(rootDir: string, relativeDir: string): Promise<boolean> {
  let current = rootDir;
  for (const segment of relativeDir.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Managed Claude skill path contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function managedSkillPathExists(rootDir: string, relativeDir: string): Promise<boolean> {
  let current = rootDir;
  for (const segment of relativeDir.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function syncManagedClaudeSkills(input: {
  sourceSkillsDir: string;
  targetSkillsDir: string;
  stateDir: string;
  configDir: string;
  skillDirectories: string[];
  skillFiles: Array<{ path: string; contentHash: string }>;
}): Promise<void> {
  const manifestPath = managedSkillImportManifestPath(input.stateDir, input.configDir);
  await withManagedSkillImportLock(path.resolve(input.targetSkillsDir), async () => {
    const manifest = await readJsonObject(manifestPath);
    const ownedSkills = new Map<string, ManagedSkillImportState>();
    const isSafeRelativeDirectory = (directory: string) => {
      const normalized = path.normalize(directory);
      return normalized !== "." && normalized !== ".." && !path.isAbsolute(normalized) &&
        !normalized.startsWith(`..${path.sep}`);
    };
    if (manifest?.skills && typeof manifest.skills === "object" && !Array.isArray(manifest.skills)) {
      for (const [directory, hash] of Object.entries(manifest.skills)) {
        if (!isSafeRelativeDirectory(directory)) continue;
        if (typeof hash === "string") {
          // The previous format saved its hash before copying; refresh once to
          // recover any import interrupted while upgrading from that format.
          ownedSkills.set(path.normalize(directory), { contentHash: hash, complete: false });
        } else if (hash && typeof hash === "object" && !Array.isArray(hash) &&
          typeof hash.contentHash === "string" && typeof hash.complete === "boolean") {
          ownedSkills.set(path.normalize(directory), { contentHash: hash.contentHash, complete: hash.complete });
        }
      }
    } else if (Array.isArray(manifest?.directories)) {
      // Upgrade the original ownership-only manifest; an empty hash forces one refresh.
      for (const directory of manifest.directories) {
        if (typeof directory === "string" && isSafeRelativeDirectory(directory)) {
          ownedSkills.set(path.normalize(directory), { contentHash: "", complete: false });
        }
      }
    }
    const desiredSkills = new Map<string, ManagedSkillImportState>();
    const skillDirectories = [...new Set(input.skillDirectories.map((directory) => path.normalize(directory)))]
      .filter(isSafeRelativeDirectory)
      .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right));
    for (const directory of skillDirectories) {
      const files = input.skillFiles.filter((file) => file.path.startsWith(`${directory}${path.sep}`));
      if (files.length === 0) continue;
      const hash = createHash("sha256");
      for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
        hash.update(path.relative(directory, file.path)).update("\0").update(file.contentHash).update("\n");
      }
      desiredSkills.set(directory, { contentHash: hash.digest("hex"), complete: true });
    }
    const persistOwnership = () => writeManagedSkillImportManifest(manifestPath, ownedSkills);

    const targetRootExists = await fs.lstat(input.targetSkillsDir).then((stat) => {
      if (stat.isSymbolicLink()) {
        throw new Error(`Managed Claude skills directory is a symbolic link: ${input.targetSkillsDir}`);
      }
      return true;
    }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (!targetRootExists && desiredSkills.size > 0) {
      await fs.mkdir(input.targetSkillsDir, { recursive: true, mode: 0o700 });
    }

    for (const directory of [...ownedSkills.keys()]) {
      if (desiredSkills.has(directory)) continue;
      if (targetRootExists && await assertManagedSkillPathHasNoSymlinks(input.targetSkillsDir, directory)) {
        await fs.rm(path.join(input.targetSkillsDir, directory), { recursive: true, force: true });
      }
      ownedSkills.delete(directory);
      await persistOwnership();
    }

    for (const [directory, desiredState] of desiredSkills) {
      const sourceDirectory = path.join(input.sourceSkillsDir, directory);
      const targetDirectory = path.join(input.targetSkillsDir, directory);
      const ownedState = ownedSkills.get(directory);
      const wasImported = ownedState !== undefined;
      if (!wasImported) {
        // Keep agent-owned and task-selected skills that Paperclip did not create.
        if (await managedSkillPathExists(input.targetSkillsDir, directory)) continue;
        ownedSkills.set(directory, { ...desiredState, complete: false });
      } else {
        const targetExists = await assertManagedSkillPathHasNoSymlinks(input.targetSkillsDir, directory);
        if (targetExists && ownedState.complete && ownedState.contentHash === desiredState.contentHash) continue;
        if (targetExists) await fs.rm(targetDirectory, { recursive: true, force: true });
        ownedSkills.set(directory, { ...desiredState, complete: false });
      }
      await persistOwnership();
      await copyTreeWithoutSymlinks(sourceDirectory, targetDirectory);
      ownedSkills.set(directory, desiredState);
      await persistOwnership();
    }
  });
}

interface ManagedClaudePluginInstall {
  id: string;
  cacheRelativePath: string;
  metadata: Record<string, unknown>;
}

async function resolveManagedClaudePluginInstalls(
  installed: Record<string, unknown> | null,
  cacheRoot: string,
): Promise<ManagedClaudePluginInstall[]> {
  const plugins = installed?.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];
  // Windows paths can refer to the same directory through an 8.3 short name,
  // a junction, or its long name. Compare canonical existing paths so a valid
  // install record is not discarded before we copy it into the managed cache.
  const canonicalCacheRoot = await fs.realpath(cacheRoot).catch(() => null);
  if (!canonicalCacheRoot) return [];
  const result: ManagedClaudePluginInstall[] = [];
  for (const [id, records] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(records)) continue;
    for (const value of records) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.installPath !== "string" || typeof record.version !== "string") continue;
      const canonicalInstallPath = await fs.realpath(path.resolve(record.installPath)).catch(() => null);
      if (!canonicalInstallPath) continue;
      const relative = path.relative(canonicalCacheRoot, canonicalInstallPath);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const metadata: Record<string, unknown> = {
        scope: "user",
        installPath: relative,
        version: record.version,
      };
      for (const key of ["installedAt", "lastUpdated", "gitCommitSha"]) {
        if (typeof record[key] === "string") metadata[key] = record[key];
      }
      result.push({ id, cacheRelativePath: relative, metadata });
    }
  }
  return result.sort((left, right) => `${left.id}\0${left.cacheRelativePath}`.localeCompare(`${right.id}\0${right.cacheRelativePath}`));
}

/**
 * Copies enabled plugin payloads and plain skills from an explicitly configured
 * profile into persistent per-agent cache state. Credentials, MCP settings,
 * hooks outside plugins, and marketplace credentials are deliberately excluded.
 */
export async function prepareManagedClaudePluginRuntime(input: {
  env: NodeJS.ProcessEnv;
  companyId: string;
  agentId: string;
  runId?: string;
  configDir: string;
  sourceDir?: string;
  autoDiscoverSource?: boolean;
  importMode?: "copy" | "cache";
  excludedSkillNames?: readonly string[];
}): Promise<{ pluginRoot: string | null; skillCount: number; profileIdentity?: string }> {
  const importMode = input.importMode ?? "cache";
  const stateDir = resolveManagedClaudeRuntimeStateDir(input.env, input.companyId, input.agentId);
  if (!input.configDir.trim()) throw new Error("Managed Claude config directory is missing");
  const configuredSource = input.sourceDir !== undefined
    ? nonEmpty(input.sourceDir)
    : nonEmpty(input.env.PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR);
  const source = configuredSource ?? (input.autoDiscoverSource ? resolveSharedClaudeConfigDir(input.env) : undefined);
  if (!source) {
    if (importMode === "cache" && input.autoDiscoverSource) {
      await syncManagedClaudeSkills({
        sourceSkillsDir: path.join(input.configDir, "skills"),
        targetSkillsDir: path.join(input.configDir, "skills"),
        stateDir,
        configDir: input.configDir,
        skillDirectories: [],
        skillFiles: [],
      });
    }
    return { pluginRoot: null, skillCount: 0 };
  }
  const sourceDir = path.resolve(source);
  if (sourceDir === path.resolve(input.configDir)) {
    throw new Error("Claude plugin source and managed run config must be separate directories");
  }
  if (!(await pathExists(sourceDir))) {
    if (!configuredSource && input.autoDiscoverSource) {
      if (importMode === "cache") {
        await syncManagedClaudeSkills({
          sourceSkillsDir: path.join(sourceDir, "skills"),
          targetSkillsDir: path.join(input.configDir, "skills"),
          stateDir,
          configDir: input.configDir,
          skillDirectories: [],
          skillFiles: [],
        });
      }
      return { pluginRoot: null, skillCount: 0 };
    }
    throw new Error(`Configured Claude plugin source directory does not exist: ${sourceDir}`);
  }

  const sourceCacheRoot = path.join(sourceDir, "plugins", "cache");
  const sourceSkillsRoot = path.join(sourceDir, "skills");
  const [settings, installed, skills, knownMarketplaces] = await Promise.all([
    readJsonObject(path.join(sourceDir, "settings.json")),
    readJsonObject(path.join(sourceDir, "plugins", "installed_plugins.json")),
    fileMetadata(sourceSkillsRoot, { excludeHiddenPaths: true }),
    readJsonObject(path.join(sourceDir, "plugins", "known_marketplaces.json")),
  ]);
  const rawEnabledPlugins = settings?.enabledPlugins;
  const enabledPlugins = rawEnabledPlugins && typeof rawEnabledPlugins === "object" && !Array.isArray(rawEnabledPlugins)
    ? Object.fromEntries(Object.entries(rawEnabledPlugins as Record<string, unknown>)
      .filter(([id, enabled]) => id.trim().length > 0 && typeof enabled === "boolean")
      .sort(([left], [right]) => left.localeCompare(right))) as Record<string, boolean>
    : {};
  const candidateInstalls = (await resolveManagedClaudePluginInstalls(installed, sourceCacheRoot))
    .filter((install) => enabledPlugins[install.id] === true);
  const installSnapshots: Array<{ install: ManagedClaudePluginInstall; files: Array<{ path: string; size: number; contentHash: string }> }> = [];
  for (const install of candidateInstalls) {
    installSnapshots.push({
      install,
      files: await fileMetadata(path.join(sourceCacheRoot, install.cacheRelativePath)),
    });
  }
  const installs = installSnapshots.filter(({ files }) => files.length > 0).map(({ install }) => install);
  const marketplaces = selectManagedPluginMarketplaces(knownMarketplaces, installs.map(({ id }) => id));
  const excludedSkillNames = new Set(
    (input.excludedSkillNames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const skillFiles = skills.filter((entry) =>
    path.basename(entry.path).toLowerCase() === "skill.md" &&
    !excludedSkillNames.has(path.basename(path.dirname(entry.path)).toLowerCase()),
  );
  const skillDirectoryTargets = new Map<string, {
    targetDirectory: string;
    sourceDirectory: string;
    isSynced: boolean;
  }>();
  for (const entry of skillFiles) {
    const sourceDirectory = path.dirname(entry.path);
    const segments = sourceDirectory.split(path.sep);
    // Claude.ai account skills are stored in a private bundle folder below
    // `skills/synced`, but Claude Code's normal personal-skill discovery only
    // recognizes `skills/<skill-name>/SKILL.md`. Import the leaf skill folder
    // so managed runs can use the copied skill without requiring account sync.
    const isSynced = segments[0]?.toLowerCase() === "synced" && segments.length >= 3;
    const targetDirectory = isSynced
      ? path.join(...segments.slice(2))
      : sourceDirectory;
    const targetKey = targetDirectory.toLowerCase();
    const existing = skillDirectoryTargets.get(targetKey);
    if (existing && existing.sourceDirectory !== sourceDirectory) {
      // Prefer the ordinary personal skill over a same-named account-synced
      // copy. Other collisions keep the first path from the sorted profile
      // snapshot, so duplicate profile entries cannot prevent a run starting.
      if (existing.isSynced && !isSynced) {
        skillDirectoryTargets.set(targetKey, { targetDirectory, sourceDirectory, isSynced });
      }
      continue;
    }
    skillDirectoryTargets.set(targetKey, { targetDirectory, sourceDirectory, isSynced });
  }
  const selectedSkillDirectories = new Set(
    [...skillDirectoryTargets.values()].map(({ targetDirectory }) => targetDirectory),
  );
  const managedSkillFiles = skills.flatMap((entry) => {
    for (const { targetDirectory, sourceDirectory } of skillDirectoryTargets.values()) {
      if (!entry.path.startsWith(`${sourceDirectory}${path.sep}`)) continue;
      return [{
        ...entry,
        targetPath: path.join(targetDirectory, path.relative(sourceDirectory, entry.path)),
      }];
    }
    return [];
  });
  if (importMode === "copy" && !input.runId) {
    throw new Error("Claude profile copy mode requires a run ID");
  }
  const profileIdentity = createHash("sha256").update(JSON.stringify({
    pluginRegistryLayoutVersion: 2,
    skillLayoutVersion: 2,
    marketplaceLayoutVersion: 1,
    marketplaces,
    enabledPlugins,
    installs: installSnapshots
      .filter(({ files }) => files.length > 0)
      .map(({ install, files }) => ({ id: install.id, cacheRelativePath: install.cacheRelativePath, metadata: install.metadata, files })),
    excludedSkillNames: [...excludedSkillNames].sort(),
    skills,
  })).digest("hex").slice(0, 24);
  const snapshotKey = importMode === "copy"
    ? input.runId!.replace(/[^a-zA-Z0-9_-]/g, "_")
    : profileIdentity;
  // Copy mode stages this run under its already-private config directory. Cache
  // mode stores immutable content-addressed snapshots in per-agent state.
  const snapshotRoot = importMode === "copy"
    ? path.join(input.configDir, ".paperclip-profile-import")
    : path.join(stateDir, "managed-plugin-cache");
  const snapshotDir = path.join(snapshotRoot, snapshotKey);
  if ((installs.length > 0 || skillFiles.length > 0) && !(await pathExists(snapshotDir))) {
    await fs.mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    const stagingDir = await fs.mkdtemp(path.join(snapshotRoot, ".tmp-"));
    try {
      const rewrittenPlugins: Record<string, Array<Record<string, unknown>>> = {};
      for (const install of installs) {
        const sourceInstallDir = path.join(sourceCacheRoot, install.cacheRelativePath);
        const targetInstallDir = path.join(stagingDir, "plugins", "cache", install.cacheRelativePath);
        await copyTreeWithoutSymlinks(sourceInstallDir, targetInstallDir);
        const metadata = { ...install.metadata, installPath: path.join(snapshotDir, "plugins", "cache", install.cacheRelativePath) };
        (rewrittenPlugins[install.id] ??= []).push(metadata);
      }
      if (Object.keys(rewrittenPlugins).length > 0) {
        await fs.writeFile(path.join(stagingDir, "plugins", "installed_plugins.json"), JSON.stringify({
          version: installed?.version ?? 2,
          plugins: rewrittenPlugins,
        }, null, 2), { mode: 0o600 });
        await writeManagedPluginMarketplaces(stagingDir, snapshotDir, marketplaces);
      }
      if (skillFiles.length > 0) {
        await copyManagedClaudeSkills(sourceSkillsRoot, path.join(stagingDir, "skills"), managedSkillFiles);
      }
      try {
        await fs.rename(stagingDir, snapshotDir);
      } catch (error) {
        if (!isAlreadyExistsError(error) && !(await pathExists(snapshotDir))) throw error;
        await fs.rm(stagingDir, { recursive: true, force: true });
      }
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  await fs.mkdir(input.configDir, { recursive: true, mode: 0o700 });
  if (installs.length > 0) {
    const settingsPath = path.join(input.configDir, "settings.json");
    const existingSettings = await readJsonObject(settingsPath);
    await fs.writeFile(settingsPath, JSON.stringify({
      ...existingSettings,
      enabledPlugins: {
        ...(
          existingSettings?.enabledPlugins &&
          typeof existingSettings.enabledPlugins === "object" &&
          !Array.isArray(existingSettings.enabledPlugins)
            ? existingSettings.enabledPlugins as Record<string, unknown>
            : {}
        ),
        ...enabledPlugins,
      },
    }, null, 2), { mode: 0o600 });
  }
  if (importMode === "cache") {
    await syncManagedClaudeSkills({
      sourceSkillsDir: path.join(snapshotDir, "skills"),
      targetSkillsDir: path.join(input.configDir, "skills"),
      stateDir,
      configDir: input.configDir,
      skillDirectories: [...selectedSkillDirectories],
      skillFiles: managedSkillFiles.map((entry) => ({
        path: entry.targetPath ?? entry.path,
        contentHash: entry.contentHash,
      })),
    });
  } else if (skillFiles.length > 0) {
    await copyManagedClaudeSkills(
      path.join(snapshotDir, "skills"),
      path.join(input.configDir, "skills"),
      managedSkillFiles.map((entry) => ({ path: entry.targetPath ?? entry.path })),
    );
  }
  if (installs.length > 0 || selectedSkillDirectories.size > 0) {
    await ensureManagedProfileSkillInstructions(input.configDir);
  }
  return { pluginRoot: installs.length > 0 ? path.join(snapshotDir, "plugins") : null, skillCount: selectedSkillDirectories.size, profileIdentity };
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function sanitizeRemoteClaudeSettings(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  const settings = { ...(parsed as Record<string, unknown>) };
  settings.permissions = { defaultMode: "default" };
  delete settings.hooks;
  delete settings.mcpServers;
  delete settings.permissionMode;
  delete settings.skipDangerousModePermissionPrompt;
  return JSON.stringify(settings);
}

async function collectSeedFiles(sourceDir: string): Promise<SeedFile[]> {
  const files: SeedFile[] = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    const rawContents = await fs.readFile(sourcePath);
    const contents = name === "settings.json"
      ? Buffer.from(sanitizeRemoteClaudeSettings(rawContents.toString("utf8")), "utf8")
      : rawContents;
    files.push({ name, sourcePath, contents });
  }
  return files;
}

async function buildSeedSnapshotKey(files: SeedFile[]): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: SeedFile[];
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.writeFile(path.join(stagingDir, file.name), file.contents);
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

export function resolveManagedClaudeRuntimeStateDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.join(instanceRoot, "companies", companyId, "agents", agentId, "claude-runtime");
}

export async function writePaperclipClaudeMcpConfig(input: {
  stateDir: string;
  runId: string;
  servers: AdapterRuntimeMcpServer[];
}): Promise<string> {
  const configDir = path.join(input.stateDir, "runs", input.runId, "mcp");
  const configPath = path.join(configDir, "mcp-config.json");
  const usedNames = new Set<string>();
  const mcpServers: Record<string, unknown> = {};
  for (const server of input.servers) {
    let name = server.name;
    if (usedNames.has(name)) name = `${name}-${server.connectionId.slice(0, 8)}`;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${server.name}-${server.connectionId.slice(0, 8)}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    mcpServers[name] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    };
  }
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return configPath;
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}

export function buildRemoteClaudeConfigMaterializationCommand(input: {
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
}): string {
  return `mkdir -p ${shellQuote(input.remoteClaudeConfigDir)} && ` +
    `if [ -d ${shellQuote(input.remoteClaudeConfigSeedDir)} ]; then ` +
    `cp -R ${shellQuote(`${input.remoteClaudeConfigSeedDir}/.`)} ${shellQuote(input.remoteClaudeConfigDir)}/; ` +
    `fi; ` +
    `for file in .credentials.json credentials.json; do ` +
    `if [ -n "\${HOME:-}" ] && [ -f "\${HOME}/.claude/\${file}" ] && [ ! -f ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}" ]; then ` +
    `cp "\${HOME}/.claude/\${file}" ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}"; ` +
    `fi; ` +
    `done`;
}

export async function materializeRemoteClaudeConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: input.remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir: input.remoteClaudeConfigSeedDir,
    }),
    input.options,
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Prepare the sandbox runtime that a Claude hello probe needs. The step
 * installs the Claude CLI in the sandbox when the CLI is absent, and it
 * materializes the Paperclip-managed Claude config directory. Both the CLI
 * Test lane and the ACP Test lane call this helper, so the two lanes probe
 * the same login state. The Claude CLI and the Claude ACP engine share the
 * same stored Claude login.
 *
 * The function mutates `env`: it sets `CLAUDE_CONFIG_DIR` to the managed
 * remote config directory when it materializes one. It returns the checks to
 * add to the Test result. An operator-provided `CLAUDE_CONFIG_DIR` wins, so
 * the function keeps it and skips the managed materialization.
 */
export async function prepareSandboxClaudeProbeRuntime(input: {
  managedAiConnection?: boolean;
  runId: string;
  target: AdapterExecutionTarget | null;
  cwd: string;
  companyId?: string;
  env: Record<string, string>;
  installCommand: string;
  detectCommand: string;
  targetIsRemote: boolean;
  targetIsSandbox: boolean;
  helloProbeTimeoutSec: number;
}): Promise<AdapterEnvironmentCheck[]> {
  const checks: AdapterEnvironmentCheck[] = [];
  const installCheck = await maybeRunSandboxInstallCommand({
    runId: input.runId,
    target: input.target,
    adapterKey: "claude",
    installCommand: input.installCommand,
    detectCommand: input.detectCommand,
    env: input.env,
  });
  if (installCheck) checks.push(installCheck);

  const hasExplicitClaudeConfigDir = isNonEmptyString(input.env.CLAUDE_CONFIG_DIR);
  if (
    input.targetIsRemote &&
    adapterExecutionTargetUsesManagedHome(input.target) &&
    (!hasExplicitClaudeConfigDir || input.managedAiConnection)
  ) {
    let tempWorkspaceDir: string | null = null;
    let preparedRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | null = null;
    try {
      const seedDir = input.managedAiConnection ? input.env.CLAUDE_CONFIG_DIR : await prepareClaudeConfigSeed(process.env, async () => {}, input.companyId);
      const managedRemoteCwd =
        input.target?.kind === "remote" ? input.target.remoteCwd : input.cwd;
      tempWorkspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "paperclip-claude-envtest-workspace-"),
      );
      preparedRuntime = await prepareAdapterExecutionTargetRuntime({
        runId: input.runId,
        target: input.target,
        adapterKey: "claude",
        workspaceLocalDir: tempWorkspaceDir,
        workspaceRemoteDir: managedRemoteCwd,
        timeoutSec: Math.max(1, input.helloProbeTimeoutSec),
        // The probe workspace is a throwaway temp dir; never wait on copy-back retries.
        workspaceRestoreRetryDelaysMs: [],
        assets: [
          {
            key: "config-seed",
            localDir: seedDir,
            followSymlinks: true,
          },
        ],
      });
      const runtimeRootDir =
        preparedRuntime.runtimeRootDir ??
        path.posix.join(managedRemoteCwd, ".paperclip-runtime", "claude");
      const remoteClaudeConfigSeedDir =
        preparedRuntime.assetDirs["config-seed"] ??
        path.posix.join(runtimeRootDir, "config-seed");
      const remoteClaudeConfigDir = path.posix.join(runtimeRootDir, "config");
      input.env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
      await materializeRemoteClaudeConfig({
        runId: input.runId,
        target: input.target,
        remoteClaudeConfigDir,
        remoteClaudeConfigSeedDir,
        options: {
          cwd: input.cwd,
          env: input.env,
          timeoutSec: Math.max(15, input.helloProbeTimeoutSec),
          graceSec: 5,
          onLog: async () => {},
        },
      });
      checks.push({
        code: "claude_managed_config_dir",
        level: "info",
        message: "The environment probe is using Paperclip-managed Claude config materialization.",
        detail: remoteClaudeConfigDir,
      });
    } catch (err) {
      // Keep the raw error out of the Test-result check and the server log. Log
      // only the fixed context, the allowlisted classification, and a safe
      // error class name.
      logSandboxProbeDiagnostic(
        "Could not materialize Paperclip-managed Claude config for the environment probe",
        "spawn_error",
        { errorClass: classifyThrownErrorClass(err) },
      );
      checks.push({
        code: "claude_managed_config_dir_failed",
        level: "error",
        message: "Could not materialize Paperclip-managed Claude config for the environment probe.",
        hint: "Retry the Test. If the failure repeats, check the server log for the redacted diagnostic.",
      });
    } finally {
      await preparedRuntime?.restoreWorkspace().catch(() => undefined);
      if (tempWorkspaceDir) {
        await fs.rm(tempWorkspaceDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  return checks;
}
