import { promises as fs } from "node:fs";
import path from "node:path";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertAgentImmutable(entry: import("node:fs").Stats, entryPath: string, hostAgentUid: number): void {
  if (entry.isSymbolicLink() || entry.uid === hostAgentUid || (entry.mode & 0o022) !== 0) {
    throw new Error(`Isolated workspace sync requires agent-immutable Git metadata: ${entryPath}`);
  }
}

async function lstatIfPresent(entryPath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const GIT_SCAN_RECHECK_MS = 5_000;
const GIT_SCAN_CACHE_LIMIT = 128;
const verifiedGitDirectories = new Map<string, { dev: number; ino: number; checkedAt: number }>();
const pendingGitScans = new Map<string, Promise<void>>();

async function assertImmutableGitDirectory(gitDirectory: string, hostAgentUid: number): Promise<void> {
  // A linked worktree can point outside the workspace. Protect every component
  // of that path as well as the contents of the Git directory itself.
  let rootEntry: import("node:fs").Stats | null = null;
  for (let directory = gitDirectory; ; directory = path.dirname(directory)) {
    const entry = await fs.lstat(directory);
    assertAgentImmutable(entry, directory, hostAgentUid);
    if (!entry.isDirectory()) {
      throw new Error(`Isolated workspace sync requires a Git metadata directory: ${directory}`);
    }
    if (directory === gitDirectory) rootEntry = entry;
    if (directory === path.dirname(directory)) break;
  }

  const cacheKey = `${hostAgentUid}:${gitDirectory}`;
  const cached = verifiedGitDirectories.get(cacheKey);
  if (cached && rootEntry && cached.dev === rootEntry.dev && cached.ino === rootEntry.ino &&
      Date.now() - cached.checkedAt < GIT_SCAN_RECHECK_MS) return;

  const pendingScan = pendingGitScans.get(cacheKey);
  if (pendingScan) return await pendingScan;

  const scan = (async () => {
    const pending = [gitDirectory];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const name of await fs.readdir(directory)) {
        const entryPath = path.join(directory, name);
        const entry = await fs.lstat(entryPath);
        assertAgentImmutable(entry, entryPath, hostAgentUid);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (!entry.isFile()) {
          throw new Error(`Isolated workspace sync requires regular Git metadata: ${entryPath}`);
        }
      }
    }
    // The agent cannot alter an accepted metadata tree: every ancestor and
    // entry is agent-immutable. A short recheck window catches operator-side
    // changes while avoiding a full object walk for each small Git command.
    verifiedGitDirectories.delete(cacheKey);
    verifiedGitDirectories.set(cacheKey, { dev: rootEntry!.dev, ino: rootEntry!.ino, checkedAt: Date.now() });
    if (verifiedGitDirectories.size > GIT_SCAN_CACHE_LIMIT) {
      verifiedGitDirectories.delete(verifiedGitDirectories.keys().next().value!);
    }
  })();
  pendingGitScans.set(cacheKey, scan);
  try { await scan; } finally { if (pendingGitScans.get(cacheKey) === scan) pendingGitScans.delete(cacheKey); }
}

async function readImmutableGitPointer(pointerPath: string, prefix: string): Promise<string> {
  const pointer = (await fs.readFile(pointerPath, "utf8")).trim();
  if (!pointer.startsWith(prefix) || pointer.slice(prefix.length).includes("\n")) {
    throw new Error(`Isolated workspace sync requires a valid Git metadata pointer: ${pointerPath}`);
  }
  const target = pointer.slice(prefix.length).trim();
  if (!target) {
    throw new Error(`Isolated workspace sync requires a valid Git metadata pointer: ${pointerPath}`);
  }
  return path.resolve(path.dirname(pointerPath), target);
}

const SAFE_GIT_CONFIG_KEYS: Record<string, ReadonlySet<string>> = {
  core: new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "symlinks"]),
  extensions: new Set(["worktreeconfig", "objectformat", "refstorage"]),
  remote: new Set(["url", "fetch", "promisor", "partialclonefilter"]),
  branch: new Set(["remote", "merge", "rebase", "description"]),
  user: new Set(["name", "email"]),
};

async function assertSafeGitConfig(gitDirectory: string, hostAgentUid: number): Promise<void> {
  for (const name of ["config", "config.worktree"]) {
    const configPath = path.join(gitDirectory, name);
    const entry = await lstatIfPresent(configPath);
    if (!entry) continue;
    assertAgentImmutable(entry, configPath, hostAgentUid);
    if (!entry.isFile()) throw new Error(`Isolated workspace sync requires regular Git metadata: ${configPath}`);
    // Even service-owned config can name a command in an agent-writable tree
    // (fsmonitor, hooksPath, filters, etc.). Accept only inert settings needed
    // to read the repository; reject includes and unknown syntax fail-closed.
    let section = "";
    for (const rawLine of (await fs.readFile(configPath, "utf8")).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const header = /^\[([a-z][a-z0-9-]*)(?:\s+"[^"]+")?\]\s*(?:[#;].*)?$/i.exec(line);
      if (header) {
        section = header[1]!.toLowerCase();
        if (!SAFE_GIT_CONFIG_KEYS[section]) {
          throw new Error(`Isolated workspace sync forbids executable or included Git config: ${configPath}`);
        }
        continue;
      }
      const setting = /^([a-z][a-z0-9-]*)\s*=/i.exec(line);
      if (!setting || !SAFE_GIT_CONFIG_KEYS[section]?.has(setting[1]!.toLowerCase())) {
        throw new Error(`Isolated workspace sync forbids executable or included Git config: ${configPath}`);
      }
    }
  }
}

async function assertSafeGitHooks(gitDirectory: string, hostAgentUid: number): Promise<void> {
  const hooksPath = path.join(gitDirectory, "hooks");
  const hooks = await lstatIfPresent(hooksPath);
  if (!hooks) return;
  assertAgentImmutable(hooks, hooksPath, hostAgentUid);
  if (!hooks.isDirectory()) throw new Error(`Isolated workspace sync requires regular Git metadata: ${hooksPath}`);
  for (const name of await fs.readdir(hooksPath)) {
    const hookPath = path.join(hooksPath, name);
    const entry = await fs.lstat(hookPath);
    assertAgentImmutable(entry, hookPath, hostAgentUid);
    if (!entry.isFile()) throw new Error(`Isolated workspace sync requires regular Git metadata: ${hookPath}`);
  }
}

async function assertIsolatedGitMetadataImmutable(source: string, hostAgentUid: number): Promise<void> {
  // Git searches upwards for .git. Inspect the repository it would discover
  // before any Git command can parse config or run core.fsmonitor/hooks.
  for (let directory = source; ; directory = path.dirname(directory)) {
    const dotGit = path.join(directory, ".git");
    const entry = await lstatIfPresent(dotGit);
    if (entry) {
      assertAgentImmutable(entry, dotGit, hostAgentUid);
      const gitDirectory = entry.isDirectory()
        ? dotGit
        : entry.isFile()
          ? await readImmutableGitPointer(dotGit, "gitdir:")
          : null;
      if (!gitDirectory) {
        throw new Error(`Isolated workspace sync requires regular Git metadata: ${dotGit}`);
      }
      await assertImmutableGitDirectory(gitDirectory, hostAgentUid);
      await assertSafeGitConfig(gitDirectory, hostAgentUid);
      await assertSafeGitHooks(gitDirectory, hostAgentUid);
      const commonDirPath = path.join(gitDirectory, "commondir");
      if (await lstatIfPresent(commonDirPath)) {
        const commonDirectory = await readImmutableGitPointer(commonDirPath, "");
        await assertImmutableGitDirectory(commonDirectory, hostAgentUid);
        await assertSafeGitConfig(commonDirectory, hostAgentUid);
        await assertSafeGitHooks(commonDirectory, hostAgentUid);
      }
      return;
    }
    if (directory === path.dirname(directory)) return;
  }
}

/** A local Git URL would let the server copy an arbitrary service-readable tree. */
export function isRemoteGitRepositoryUrl(value: string): boolean {
  const url = value.trim();
  if (url.startsWith("-")) return false;
  if (/^[^@\s/]+@[^:/\s]+:.+/.test(url)) return true; // git@host:owner/repo
  try {
    return ["https:", "http:", "ssh:", "git:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Resolve the checked host source before reading, archiving, or uploading it. */
export async function assertIsolatedWorkspaceSyncAllowed(
  sourcePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME !== "true") return sourcePath;

  const hostAgentUid = Number(env.PAPERCLIP_SECRETS_HOST_AGENT_UID);
  if (process.platform !== "linux" || !Number.isSafeInteger(hostAgentUid) || hostAgentUid <= 0 ||
      hostAgentUid === process.getuid?.()) {
    throw new Error("Isolated workspace sync requires a separate non-root host agent UID.");
  }

  let configuredRoots: unknown;
  try {
    configuredRoots = JSON.parse(env.PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON ?? "[]");
  } catch {
    throw new Error("Isolated workspace sync requires a valid allowed workspace roots configuration.");
  }
  if (!Array.isArray(configuredRoots) || configuredRoots.length === 0 ||
      configuredRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new Error("Isolated workspace sync requires absolute operator-approved workspace roots.");
  }

  const keyFilePath = env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (!keyFilePath || !path.isAbsolute(keyFilePath) || !path.isAbsolute(sourcePath)) {
    throw new Error("Isolated workspace sync requires absolute key and workspace paths.");
  }

  const secretDirectory = await fs.realpath(path.dirname(keyFilePath));
  const source = await fs.realpath(sourcePath);
  if (!(await fs.stat(source)).isDirectory()) {
    throw new Error("Isolated workspace sync requires a directory source.");
  }

  let approved = false;
  for (const configuredRoot of configuredRoots as string[]) {
    const root = await fs.realpath(configuredRoot);
    if (!(await fs.stat(root)).isDirectory() ||
        isWithin(root, secretDirectory) || isWithin(secretDirectory, root)) {
      throw new Error("Isolated workspace roots must not overlap the master-key directory.");
    }
    approved ||= isWithin(root, source);
  }
  if (!approved || isWithin(secretDirectory, source)) {
    throw new Error("Workspace source is outside the operator-approved isolated workspace roots.");
  }

  // A pathname check cannot protect a later tar -C or provider upload if the
  // agent can rename any component. Ownership matters even for a read-only
  // directory: its owner can chmod it writable after this check. Group/other
  // write also covers agent supplementary groups and POSIX ACL write masks.
  for (let directory = source; ; directory = path.dirname(directory)) {
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid === hostAgentUid ||
        (entry.mode & 0o022) !== 0) {
      throw new Error(`Isolated workspace sync requires agent-immutable directory ancestors: ${directory}`);
    }
    if (directory === path.dirname(directory)) break;
  }
  await assertIsolatedGitMetadataImmutable(source, hostAgentUid);
  return source;
}
