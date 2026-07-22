import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "./config/home.js";

export const INSTALL_MANIFEST_VERSION = 1;
export const MANAGED_SHIM_MARKER = "paperclipai managed install shim";
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
    currentPath: path.join(cliRoot, "current"),
    shimPath: path.join(homeDir, ".local", "bin", "paperclipai"),
  };
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
    if (!existing.includes(MANAGED_SHIM_MARKER)) {
      throw new Error(`Refusing to replace existing non-managed command ${paths.shimPath}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function writeManagedShim(paths = resolveInstallStorePaths()): void {
  assertManagedShimWritable(paths);
  const homeDir = path.dirname(path.dirname(path.dirname(paths.shimPath)));
  const localDir = path.dirname(path.dirname(paths.shimPath));
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(localDir, { mode: 0o755 });
  fs.mkdirSync(path.dirname(paths.shimPath), { mode: 0o755 });
  assertManagedShimWritable(paths);
  const contents = `#!/bin/sh\n# ${MANAGED_SHIM_MARKER}\nset -eu\nPAPERCLIP_HOME="\${PAPERCLIP_HOME:-\$HOME/.paperclip}"\nexec node "\$PAPERCLIP_HOME/cli/current/node_modules/paperclipai/dist/index.js" "\$@"\n`;
  writeFileAtomic(paths.shimPath, contents, 0o755);
}

export function removeManagedShim(paths = resolveInstallStorePaths()): boolean {
  try {
    const contents = fs.readFileSync(paths.shimPath, "utf8");
    if (!contents.includes(MANAGED_SHIM_MARKER)) return false;
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
    return executableRealPath.startsWith(`${payloadRealPath}${path.sep}`) && fs.existsSync(paths.currentPath);
  } catch {
    return false;
  }
}
