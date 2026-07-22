import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "./config/home.js";

export const INSTALL_MANIFEST_VERSION = 1;
export const MANAGED_SHIM_MARKER = "paperclipai managed install shim v1";
export const MANAGED_STORE_MARKER = "paperclipai managed install store v1\n";
export const PATH_BLOCK_START = "# >>> paperclipai managed PATH >>>";
export const PATH_BLOCK_END = "# <<< paperclipai managed PATH <<<";

export type InstallSource = "npm" | "git";
export type InstallChannel = "latest" | "canary" | "pinned";

export type InstallRecord = {
  source: InstallSource;
  version: string;
  channel: InstallChannel;
  payloadPath: string;
  repo?: string;
  ref?: string;
  sha?: string;
  installedAt: string;
};

export type InstallManifest = InstallRecord & {
  schemaVersion: typeof INSTALL_MANIFEST_VERSION;
  previous: InstallRecord[];
};

export type InstallStorePaths = {
  paperclipHome: string;
  cliRoot: string;
  installsRoot: string;
  manifestPath: string;
  markerPath: string;
  lockPath: string;
  currentPath: string;
  shimPath: string;
};

function ensurePrivateDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory install-store path ${directoryPath}.`);
  }
  fs.chmodSync(directoryPath, 0o700);
}

function assertOwnedByCurrentUser(stat: fs.Stats, targetPath: string): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid()) {
    throw new Error(`Refusing to modify path not owned by the current user: ${targetPath}.`);
  }
}

function writeFileAtomic(filePath: string, contents: string, mode: number): void {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    fs.writeFileSync(temporaryPath, contents, { mode, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function resolveInstallStorePaths(options: {
  paperclipHome?: string;
  homeDir?: string;
} = {}): InstallStorePaths {
  const paperclipHome = path.resolve(options.paperclipHome ?? resolvePaperclipHomeDir());
  const homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? path.dirname(paperclipHome));
  const cliRoot = path.join(paperclipHome, "cli");
  return {
    paperclipHome,
    cliRoot,
    installsRoot: path.join(cliRoot, "installs"),
    manifestPath: path.join(cliRoot, "install.json"),
    markerPath: path.join(cliRoot, ".managed-install"),
    lockPath: path.join(cliRoot, ".install.lock"),
    currentPath: path.join(cliRoot, "current"),
    shimPath: path.join(homeDir, ".local", "bin", "paperclipai"),
  };
}

export function initializeInstallStore(paths = resolveInstallStorePaths()): void {
  ensurePrivateDirectory(paths.cliRoot);
  ensurePrivateDirectory(paths.installsRoot);
  try {
    const markerStat = fs.lstatSync(paths.markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink > 1) {
      throw new Error(`Refusing to use unsafe install-store marker ${paths.markerPath}.`);
    }
    assertOwnedByCurrentUser(markerStat, paths.markerPath);
    if (fs.readFileSync(paths.markerPath, "utf8") !== MANAGED_STORE_MARKER) {
      throw new Error(`Refusing to use unrecognized install store ${paths.cliRoot}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      fs.writeFileSync(paths.markerPath, MANAGED_STORE_MARKER, { mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if (
        (writeError as NodeJS.ErrnoException).code !== "EEXIST" ||
        fs.readFileSync(paths.markerPath, "utf8") !== MANAGED_STORE_MARKER
      ) {
        throw writeError;
      }
    }
  }
}

export function assertManagedInstallStore(paths = resolveInstallStorePaths()): InstallManifest {
  const cliStat = fs.lstatSync(paths.cliRoot);
  if (!cliStat.isDirectory() || cliStat.isSymbolicLink()) {
    throw new Error(`Refusing to remove unsafe install-store path ${paths.cliRoot}.`);
  }
  assertOwnedByCurrentUser(cliStat, paths.cliRoot);
  let markerStat: fs.Stats;
  try {
    markerStat = fs.lstatSync(paths.markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Refusing to remove unverified install store ${paths.cliRoot}.`);
    }
    throw error;
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink > 1) {
    throw new Error(`Refusing to remove unverified install store ${paths.cliRoot}.`);
  }
  assertOwnedByCurrentUser(markerStat, paths.markerPath);
  if (fs.readFileSync(paths.markerPath, "utf8") !== MANAGED_STORE_MARKER) {
    throw new Error(`Refusing to remove unverified install store ${paths.cliRoot}.`);
  }
  const manifest = readInstallManifest(paths);
  if (!manifest) throw new Error(`Refusing to remove install store without a manifest at ${paths.cliRoot}.`);
  const relativePayload = path.relative(paths.installsRoot, path.resolve(manifest.payloadPath));
  if (!relativePayload || relativePayload.startsWith("..") || path.isAbsolute(relativePayload)) {
    throw new Error(`Refusing to remove install store with an invalid manifest at ${paths.cliRoot}.`);
  }
  return manifest;
}

export async function withInstallStoreLock<T>(
  callback: () => Promise<T>,
  paths = resolveInstallStorePaths(),
  options: { initialize?: boolean } = {},
): Promise<T> {
  if (options.initialize !== false) initializeInstallStore(paths);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const acquire = (): void => {
    const temporaryPath = `${paths.lockPath}.${token}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${token}\n`, { mode: 0o600, flag: "wx" });
      try {
        fs.linkSync(temporaryPath, paths.lockPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const owner = fs.readFileSync(paths.lockPath, "utf8").trim();
      const ownerPid = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
      const ownerLabel = Number.isInteger(ownerPid) && ownerPid > 0 ? ` (pid ${ownerPid})` : "";
      throw new Error(
        `Another managed install is already running${ownerLabel}. ` +
        `If no install process is active, remove the stale lock at ${paths.lockPath} and retry.`,
      );
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  };

  acquire();
  try {
    return await callback();
  } finally {
    try {
      if (fs.readFileSync(paths.lockPath, "utf8").trim() === token) {
        fs.rmSync(paths.lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function payloadPathFor(
  paths: InstallStorePaths,
  source: InstallSource,
  identifier: string,
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(identifier)) {
    throw new Error(`Invalid install payload identifier '${identifier}'.`);
  }
  return path.join(paths.installsRoot, source, identifier);
}

export function readInstallManifest(paths = resolveInstallStorePaths()): InstallManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8")) as InstallManifest;
    if (
      value.schemaVersion !== INSTALL_MANIFEST_VERSION ||
      (value.source !== "npm" && value.source !== "git") ||
      !Array.isArray(value.previous) ||
      typeof value.payloadPath !== "string"
    ) {
      throw new Error("unsupported manifest shape");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read managed install manifest at ${paths.manifestPath}: ${String(error)}`);
  }
}

export function writeInstallManifestAtomic(
  manifest: InstallManifest,
  paths = resolveInstallStorePaths(),
): void {
  ensurePrivateDirectory(paths.cliRoot);
  const temporaryPath = `${paths.manifestPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, paths.manifestPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function assertPayloadPath(payloadPath: string, paths: InstallStorePaths): void {
  const relative = path.relative(paths.installsRoot, path.resolve(payloadPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to activate payload outside ${paths.installsRoot}.`);
  }
  const stat = fs.lstatSync(payloadPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to activate non-directory payload ${payloadPath}.`);
  }
  const installsRealPath = fs.realpathSync(paths.installsRoot);
  const payloadRealPath = fs.realpathSync(payloadPath);
  if (!payloadRealPath.startsWith(`${installsRealPath}${path.sep}`)) {
    throw new Error(`Refusing to activate payload that resolves outside ${paths.installsRoot}.`);
  }
}

export function flipCurrentAtomic(
  payloadPath: string,
  paths = resolveInstallStorePaths(),
  hooks: { beforeRename?: () => void } = {},
): void {
  assertPayloadPath(payloadPath, paths);
  ensurePrivateDirectory(paths.cliRoot);
  try {
    const currentStat = fs.lstatSync(paths.currentPath);
    if (!currentStat.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink ${paths.currentPath}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporaryLink = path.join(
    paths.cliRoot,
    `.current-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const relativeTarget = path.relative(paths.cliRoot, payloadPath);
  try {
    fs.symlinkSync(relativeTarget, temporaryLink, "dir");
    hooks.beforeRename?.();
    fs.renameSync(temporaryLink, paths.currentPath);
  } finally {
    fs.rmSync(temporaryLink, { force: true });
  }
}

export function buildNextManifest(
  record: InstallRecord,
  current: InstallManifest | null,
): InstallManifest {
  const candidates: InstallRecord[] = current
    ? [
        {
          source: current.source,
          version: current.version,
          channel: current.channel,
          payloadPath: current.payloadPath,
          repo: current.repo,
          ref: current.ref,
          sha: current.sha,
          installedAt: current.installedAt,
        },
        ...current.previous,
      ]
    : [];
  const previous = candidates
    .filter((candidate) => path.resolve(candidate.payloadPath) !== path.resolve(record.payloadPath))
    .filter(
      (candidate, index, all) =>
        all.findIndex((other) => path.resolve(other.payloadPath) === path.resolve(candidate.payloadPath)) ===
        index,
    )
    .slice(0, 2);

  return { schemaVersion: INSTALL_MANIFEST_VERSION, ...record, previous };
}

export function pruneInstallPayloads(
  manifest: InstallManifest,
  paths = resolveInstallStorePaths(),
): string[] {
  const retained = new Set(
    [manifest, ...manifest.previous].map((record) => path.resolve(record.payloadPath)),
  );
  const removed: string[] = [];
  for (const source of ["npm", "git"] as const) {
    const sourceRoot = path.join(paths.installsRoot, source);
    if (!fs.existsSync(sourceRoot)) continue;
    const sourceStat = fs.lstatSync(sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`Refusing to prune unsafe install-store path ${sourceRoot}.`);
    }
    for (const entry of fs.readdirSync(sourceRoot)) {
      if (entry.startsWith(".")) continue;
      const candidate = path.join(sourceRoot, entry);
      if (!retained.has(path.resolve(candidate))) {
        fs.rmSync(candidate, { recursive: true, force: true });
        removed.push(candidate);
      }
    }
  }
  return removed;
}

export function assertManagedShimWritable(paths = resolveInstallStorePaths()): void {
  const homeDir = path.dirname(path.dirname(path.dirname(paths.shimPath)));
  for (const directoryPath of [homeDir, path.join(homeDir, ".local"), path.dirname(paths.shimPath)]) {
    if (!fs.existsSync(directoryPath)) continue;
    const directoryStat = fs.lstatSync(directoryPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Refusing to use unsafe shim directory ${directoryPath}.`);
    }
    assertOwnedByCurrentUser(directoryStat, directoryPath);
  }
  try {
    const stat = fs.lstatSync(paths.shimPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-regular shim ${paths.shimPath}.`);
    }
    assertOwnedByCurrentUser(stat, paths.shimPath);
    if (stat.nlink > 1) throw new Error(`Refusing to replace multiply linked shim ${paths.shimPath}.`);
    const existing = fs.readFileSync(paths.shimPath, "utf8");
    if (!isManagedShimContents(existing)) {
      throw new Error(`Refusing to replace existing non-managed command ${paths.shimPath}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isManagedShimContents(contents: string): boolean {
  const lines = contents.split("\n");
  return (
    lines.length === 5 &&
    lines[0] === "#!/bin/sh" &&
    lines[1] === `# ${MANAGED_SHIM_MARKER}` &&
    lines[2] === "set -eu" &&
    /^exec '(?:[^']|'"'"')+' '(?:[^']|'"'"')+' "\$@"$/.test(lines[3]) &&
    lines[4] === ""
  );
}

export function writeManagedShim(paths = resolveInstallStorePaths()): void {
  assertManagedShimWritable(paths);
  const homeDir = path.dirname(path.dirname(path.dirname(paths.shimPath)));
  const localDir = path.dirname(path.dirname(paths.shimPath));
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(localDir, { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true, mode: 0o755 });
  assertManagedShimWritable(paths);
  const entrypoint = path.join(paths.currentPath, "node_modules", "paperclipai", "dist", "index.js");
  const contents = `#!/bin/sh\n# ${MANAGED_SHIM_MARKER}\nset -eu\nexec ${shellQuote(process.execPath)} ${shellQuote(entrypoint)} "\$@"\n`;
  writeFileAtomic(paths.shimPath, contents, 0o755);
}

export function removeManagedShim(paths = resolveInstallStorePaths()): boolean {
  try {
    const contents = fs.readFileSync(paths.shimPath, "utf8");
    if (!isManagedShimContents(contents)) return false;
    fs.rmSync(paths.shimPath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export function managedPathBlock(): string {
  return `${PATH_BLOCK_START}\nexport PATH="$HOME/.local/bin:$PATH"\n${PATH_BLOCK_END}`;
}

export function addManagedPathBlock(rcPath: string): boolean {
  let existing = "";
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(rcPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to modify non-regular shell rc file ${rcPath}.`);
    }
    assertOwnedByCurrentUser(stat, rcPath);
    mode = stat.mode & 0o777;
    existing = fs.readFileSync(rcPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing.includes(PATH_BLOCK_START)) return false;
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileAtomic(rcPath, `${existing}${prefix}${managedPathBlock()}\n`, mode);
  return true;
}

export function removeManagedPathBlock(rcPath: string): boolean {
  let existing: string;
  try {
    const stat = fs.lstatSync(rcPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to modify non-regular shell rc file ${rcPath}.`);
    }
    assertOwnedByCurrentUser(stat, rcPath);
    existing = fs.readFileSync(rcPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const escapedStart = PATH_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = PATH_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const next = existing.replace(new RegExp(`(?:^|\\n)${escapedStart}\\n[\\s\\S]*?${escapedEnd}\\n?`), "\n");
  if (next === existing) return false;
  writeFileAtomic(rcPath, next.replace(/^\n/, ""), fs.statSync(rcPath).mode & 0o777);
  return true;
}

export function isManagedExecutable(
  executablePath: string | undefined,
  manifest: InstallManifest,
  paths = resolveInstallStorePaths(),
): boolean {
  if (!executablePath) return false;
  try {
    const executableRealPath = fs.realpathSync(executablePath);
    const payloadRealPath = fs.realpathSync(manifest.payloadPath);
    const currentRealPath = fs.realpathSync(paths.currentPath);
    return (
      currentRealPath === payloadRealPath &&
      executableRealPath.startsWith(`${payloadRealPath}${path.sep}`)
    );
  } catch {
    return false;
  }
}
