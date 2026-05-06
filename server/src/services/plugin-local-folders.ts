import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  PluginLocalFolderDeclaration,
  PluginLocalFolderEntry,
  PluginLocalFolderListing,
  PluginLocalFolderProblem,
  PluginLocalFolderStatus,
} from "@paperclipai/plugin-sdk";
import { badRequest, forbidden, notFound } from "../errors.js";

export interface StoredPluginLocalFolderConfig {
  path: string;
  access?: "read" | "readWrite";
  requiredDirectories?: string[];
  requiredFiles?: string[];
  updatedAt?: string;
}

export interface PluginLocalFolderSettingsJson {
  localFolders?: Record<string, StoredPluginLocalFolderConfig>;
  [key: string]: unknown;
}

const LOCAL_FOLDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

function problem(
  code: PluginLocalFolderProblem["code"],
  message: string,
  problemPath?: string,
): PluginLocalFolderProblem {
  return { code, message, path: problemPath };
}

export function assertPluginLocalFolderKey(folderKey: string) {
  if (!LOCAL_FOLDER_KEY_PATTERN.test(folderKey)) {
    throw badRequest("folderKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens");
  }
}

export function findLocalFolderDeclaration(
  declarations: PluginLocalFolderDeclaration[] | undefined,
  folderKey: string,
) {
  return declarations?.find((declaration) => declaration.folderKey === folderKey) ?? null;
}

export function requireLocalFolderDeclaration(
  declarations: PluginLocalFolderDeclaration[] | undefined,
  folderKey: string,
) {
  assertPluginLocalFolderKey(folderKey);
  const declaration = findLocalFolderDeclaration(declarations, folderKey);
  if (!declaration) {
    throw badRequest("Local folder key is not declared by this plugin manifest");
  }
  return declaration;
}

function normalizeRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw forbidden("Local folder relative paths must stay inside the configured root");
  }
  return relativePath;
}

function validateRequiredPath(pathValue: string, label: string): string {
  try {
    return normalizeRelativePath(pathValue);
  } catch {
    throw badRequest(`${label} must contain only relative paths without traversal, empty segments, or backslashes`);
  }
}

function normalizeListRelativePath(relativePath: string | null | undefined): string | null {
  const trimmed = relativePath?.trim();
  if (!trimmed) return null;
  return normalizeRelativePath(trimmed);
}

function normalizeMaxEntries(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1000;
  return Math.max(1, Math.min(5000, Math.floor(value)));
}

function mergeFolderConfig(
  declaration: PluginLocalFolderDeclaration | null,
  stored: StoredPluginLocalFolderConfig | null,
  override?: Partial<StoredPluginLocalFolderConfig>,
): StoredPluginLocalFolderConfig | null {
  const pathValue = override?.path ?? stored?.path;
  if (!pathValue) return null;
  return {
    path: pathValue,
    access: declaration?.access ?? override?.access ?? stored?.access ?? "readWrite",
    requiredDirectories:
      declaration?.requiredDirectories ?? override?.requiredDirectories ?? stored?.requiredDirectories ?? [],
    requiredFiles:
      declaration?.requiredFiles ?? override?.requiredFiles ?? stored?.requiredFiles ?? [],
    updatedAt: stored?.updatedAt,
  };
}

export function getStoredLocalFolders(settingsJson: Record<string, unknown> | null | undefined) {
  const folders = (settingsJson as PluginLocalFolderSettingsJson | undefined)?.localFolders;
  if (!folders || typeof folders !== "object") return {};
  return folders;
}

export function setStoredLocalFolder(
  settingsJson: Record<string, unknown> | null | undefined,
  folderKey: string,
  config: StoredPluginLocalFolderConfig,
): PluginLocalFolderSettingsJson {
  return {
    ...(settingsJson ?? {}),
    localFolders: {
      ...getStoredLocalFolders(settingsJson),
      [folderKey]: {
        ...config,
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

export async function inspectPluginLocalFolder(input: {
  folderKey: string;
  declaration?: PluginLocalFolderDeclaration | null;
  storedConfig?: StoredPluginLocalFolderConfig | null;
  overrideConfig?: Partial<StoredPluginLocalFolderConfig>;
}): Promise<PluginLocalFolderStatus> {
  assertPluginLocalFolderKey(input.folderKey);
  const config = mergeFolderConfig(
    input.declaration ?? null,
    input.storedConfig ?? null,
    input.overrideConfig,
  );
  const access = config?.access ?? input.declaration?.access ?? "readWrite";
  const requiredDirectories = (config?.requiredDirectories ?? []).map((item) =>
    validateRequiredPath(item, "requiredDirectories"),
  );
  const requiredFiles = (config?.requiredFiles ?? []).map((item) =>
    validateRequiredPath(item, "requiredFiles"),
  );
  const checkedAt = new Date().toISOString();

  if (!config?.path) {
    return {
      folderKey: input.folderKey,
      configured: false,
      path: null,
      realPath: null,
      access,
      readable: false,
      writable: false,
      requiredDirectories,
      requiredFiles,
      missingDirectories: requiredDirectories,
      missingFiles: requiredFiles,
      healthy: false,
      problems: [problem("not_configured", "No local folder path is configured.")],
      checkedAt,
    };
  }

  const configuredPath = path.resolve(config.path);
  const problems: PluginLocalFolderProblem[] = [];
  const missingDirectories: string[] = [];
  const missingFiles: string[] = [];
  const markRequiredPathsMissing = () => {
    missingDirectories.push(...requiredDirectories);
    missingFiles.push(...requiredFiles);
  };
  let realPath: string | null = null;
  let readable = false;
  let writable = false;

  if (!path.isAbsolute(config.path)) {
    problems.push(problem("not_absolute", "Local folder path must be absolute.", config.path));
  }

  try {
    const stat = await fs.stat(configuredPath);
    if (!stat.isDirectory()) {
      problems.push(problem("not_directory", "Configured local folder path is not a directory.", configuredPath));
      markRequiredPathsMissing();
    } else {
      realPath = await fs.realpath(configuredPath);
      try {
        await fs.access(realPath, fsConstants.R_OK);
        readable = true;
      } catch {
        problems.push(problem("not_readable", "Configured local folder is not readable.", configuredPath));
      }

      if (access === "readWrite") {
        try {
          await fs.access(realPath, fsConstants.W_OK);
          const probePath = path.join(realPath, `.paperclip-local-folder-probe-${process.pid}-${Date.now()}`);
          await fs.writeFile(probePath, "");
          await fs.rm(probePath, { force: true });
          writable = true;
        } catch {
          problems.push(problem("not_writable", "Configured local folder is not writable.", configuredPath));
        }
      }

      for (const requiredDir of requiredDirectories) {
        const requiredStatus = await inspectChildPath(realPath, requiredDir, "directory");
        if (!requiredStatus.exists) {
          missingDirectories.push(requiredDir);
          problems.push(problem("missing_directory", "Required directory is missing.", requiredDir));
        } else if (!requiredStatus.contained) {
          problems.push(problem("symlink_escape", "Required directory escapes the configured root.", requiredDir));
        } else if (!requiredStatus.matchesKind) {
          missingDirectories.push(requiredDir);
          problems.push(problem("missing_directory", "Required path is not a directory.", requiredDir));
        }
      }

      for (const requiredFile of requiredFiles) {
        const requiredStatus = await inspectChildPath(realPath, requiredFile, "file");
        if (!requiredStatus.exists) {
          missingFiles.push(requiredFile);
          problems.push(problem("missing_file", "Required file is missing.", requiredFile));
        } else if (!requiredStatus.contained) {
          problems.push(problem("symlink_escape", "Required file escapes the configured root.", requiredFile));
        } else if (!requiredStatus.matchesKind) {
          missingFiles.push(requiredFile);
          problems.push(problem("missing_file", "Required path is not a file.", requiredFile));
        }
      }
    }
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    problems.push(problem(code === "ENOENT" ? "missing" : "not_readable", "Configured local folder cannot be inspected.", configuredPath));
    if (code === "ENOENT") {
      markRequiredPathsMissing();
    }
  }

  return {
    folderKey: input.folderKey,
    configured: true,
    path: configuredPath,
    realPath,
    access,
    readable,
    writable: access === "read" ? false : writable,
    requiredDirectories,
    requiredFiles,
    missingDirectories,
    missingFiles,
    healthy:
      problems.length === 0 &&
      readable &&
      (access === "read" || writable),
    problems,
    checkedAt,
  };
}

function isInsideRoot(rootRealPath: string, candidateRealPath: string) {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertPathInsideRoot(rootRealPath: string, candidatePath: string) {
  const candidateRealPath = await fs.realpath(candidatePath);
  if (!isInsideRoot(rootRealPath, candidateRealPath)) {
    throw forbidden("Local folder symlink escape is not allowed");
  }
  return candidateRealPath;
}

async function ensureDirectoryInsideRoot(rootRealPath: string, relativePath: string) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/");
  let currentRealPath = rootRealPath;

  for (const segment of segments) {
    const nextPath = path.join(currentRealPath, segment);
    try {
      const stat = await fs.stat(nextPath);
      if (!stat.isDirectory()) {
        throw badRequest("Required directory path exists but is not a directory");
      }
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "ENOENT") throw error;
      await fs.mkdir(nextPath);
    }

    const nextRealPath = await fs.realpath(nextPath);
    if (!isInsideRoot(rootRealPath, nextRealPath)) {
      throw forbidden("Local folder symlink escape is not allowed");
    }
    currentRealPath = nextRealPath;
  }
}

export async function preparePluginLocalFolder(input: {
  folderKey: string;
  declaration?: PluginLocalFolderDeclaration | null;
  storedConfig?: StoredPluginLocalFolderConfig | null;
  overrideConfig?: Partial<StoredPluginLocalFolderConfig>;
}) {
  assertPluginLocalFolderKey(input.folderKey);
  const config = mergeFolderConfig(
    input.declaration ?? null,
    input.storedConfig ?? null,
    input.overrideConfig,
  );
  const access = config?.access ?? input.declaration?.access ?? "readWrite";
  if (!config?.path || access !== "readWrite" || !path.isAbsolute(config.path)) return;

  const configuredPath = path.resolve(config.path);
  try {
    const stat = await fs.stat(configuredPath);
    if (!stat.isDirectory()) return;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT") return;
    try {
      await fs.mkdir(configuredPath, { recursive: true });
    } catch {
      return;
    }
  }
  const rootRealPath = await fs.realpath(configuredPath);

  for (const requiredDir of config.requiredDirectories ?? []) {
    await ensureDirectoryInsideRoot(rootRealPath, validateRequiredPath(requiredDir, "requiredDirectories"));
  }
}

async function inspectChildPath(
  rootRealPath: string,
  relativePath: string,
  kind: "directory" | "file",
) {
  let resolvedPath: Awaited<ReturnType<typeof resolvePluginLocalFolderPath>>;
  try {
    resolvedPath = await resolvePluginLocalFolderPath(rootRealPath, relativePath, {
      mustExist: true,
      allowMissingLeaf: true,
    });
  } catch {
    return { exists: true, contained: false, matchesKind: false };
  }
  if (!resolvedPath.exists) {
    return { exists: false, contained: true, matchesKind: false };
  }
  const stat = await fs.stat(resolvedPath.realPath);
  return {
    exists: true,
    contained: true,
    matchesKind: kind === "directory" ? stat.isDirectory() : stat.isFile(),
  };
}

export async function resolvePluginLocalFolderPath(
  rootPath: string,
  relativePath: string,
  options?: { mustExist?: boolean; allowMissingLeaf?: boolean },
) {
  const normalized = normalizeRelativePath(relativePath);
  const rootRealPath = await fs.realpath(rootPath);
  const absolutePath = path.resolve(rootRealPath, normalized);
  const relativeFromRoot = path.relative(rootRealPath, absolutePath);
  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    throw forbidden("Local folder path traversal is not allowed");
  }

  try {
    const realPath = await fs.realpath(absolutePath);
    const realRelative = path.relative(rootRealPath, realPath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw forbidden("Local folder symlink escape is not allowed");
    }
    return { absolutePath, realPath, exists: true };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT" || options?.mustExist) {
      if (options?.allowMissingLeaf && code === "ENOENT") {
        return { absolutePath, realPath: absolutePath, exists: false };
      }
      throw error;
    }

    const parentRealPath = await fs.realpath(path.dirname(absolutePath));
    const parentRelative = path.relative(rootRealPath, parentRealPath);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
      throw forbidden("Local folder symlink escape is not allowed");
    }
    return { absolutePath, realPath: absolutePath, exists: false };
  }
}

export async function readPluginLocalFolderText(rootPath: string, relativePath: string) {
  const resolved = await resolvePluginLocalFolderPath(rootPath, relativePath, { mustExist: true });
  const stat = await fs.stat(resolved.realPath);
  if (!stat.isFile()) {
    throw badRequest("Local folder read target must be a file");
  }
  return fs.readFile(resolved.realPath, "utf8");
}

export async function listPluginLocalFolderEntries(
  rootPath: string,
  options: { relativePath?: string | null; recursive?: boolean; maxEntries?: number } = {},
): Promise<PluginLocalFolderListing> {
  const rootRealPath = await fs.realpath(rootPath);
  const relativePath = normalizeListRelativePath(options.relativePath);
  const target = relativePath
    ? await resolvePluginLocalFolderPath(rootRealPath, relativePath, { mustExist: true })
    : { absolutePath: rootRealPath, realPath: rootRealPath, exists: true };
  const targetStat = await fs.stat(target.realPath);
  if (!targetStat.isDirectory()) {
    throw badRequest("Local folder list target must be a directory");
  }

  const maxEntries = normalizeMaxEntries(options.maxEntries);
  const entries: PluginLocalFolderEntry[] = [];
  let truncated = false;

  const visit = async (directoryRealPath: string, directoryRelativePath: string | null) => {
    if (truncated) return;
    const dirents = await fs.readdir(directoryRealPath, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }

      const childRelativePath = directoryRelativePath ? `${directoryRelativePath}/${dirent.name}` : dirent.name;
      let resolvedChild: Awaited<ReturnType<typeof resolvePluginLocalFolderPath>>;
      try {
        resolvedChild = await resolvePluginLocalFolderPath(rootRealPath, childRelativePath, { mustExist: true });
      } catch {
        continue;
      }

      const stat = await fs.stat(resolvedChild.realPath).catch(() => null);
      if (!stat) continue;
      const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
      if (!kind) continue;

      entries.push({
        path: childRelativePath,
        name: dirent.name,
        kind,
        size: kind === "file" ? stat.size : null,
        modifiedAt: stat.mtime.toISOString(),
      });

      if (options.recursive && kind === "directory") {
        await visit(resolvedChild.realPath, childRelativePath);
        if (truncated) return;
      }
    }
  };

  await visit(target.realPath, relativePath);
  return {
    folderKey: "list-result",
    relativePath,
    entries,
    truncated,
  };
}

export async function writePluginLocalFolderTextAtomic(
  rootPath: string,
  relativePath: string,
  contents: string,
) {
  const rootRealPath = await fs.realpath(rootPath);
  const resolved = await resolvePluginLocalFolderPath(rootPath, relativePath);
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await assertPathInsideRoot(rootRealPath, path.dirname(resolved.absolutePath));
  const tempPath = path.join(
    path.dirname(resolved.absolutePath),
    `.paperclip-${path.basename(resolved.absolutePath)}-${process.pid}-${randomUUID()}.tmp`,
  );
  let tempCreated = false;
  try {
    const handle = await fs.open(tempPath, "wx");
    tempCreated = true;
    try {
      await assertPathInsideRoot(rootRealPath, tempPath);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (tempCreated) {
      await fs.rm(tempPath, { force: true });
    }
    throw error;
  }

  try {
    await resolvePluginLocalFolderPath(rootRealPath, relativePath);
    await fs.rename(tempPath, resolved.absolutePath);
    await resolvePluginLocalFolderPath(rootRealPath, relativePath, { mustExist: true });
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  if (process.platform !== "win32") {
    const dirHandle = await fs.open(path.dirname(resolved.absolutePath), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  }

  return inspectPluginLocalFolder({
    folderKey: "write-result",
    storedConfig: {
      path: rootPath,
      access: "readWrite",
    },
  });
}

export function defaultLocalFolderBasePath(pluginKey: string, companyId: string) {
  return path.join(os.homedir(), ".paperclip", "plugin-data", companyId, pluginKey);
}

export function assertConfiguredLocalFolder(status: PluginLocalFolderStatus) {
  if (!status.configured || !status.realPath || !status.readable) {
    throw notFound("Local folder is not configured or readable");
  }
  if (!status.healthy) {
    throw badRequest("Local folder is not healthy");
  }
}

export function assertWritableConfiguredLocalFolder(status: PluginLocalFolderStatus) {
  if (!status.configured || !status.realPath || !status.readable) {
    throw notFound("Local folder is not configured or readable");
  }
  const onlyMissingRequiredPaths = status.problems.every((item) =>
    item.code === "missing_directory" || item.code === "missing_file"
  );
  if (!status.healthy && !onlyMissingRequiredPaths) {
    throw badRequest("Local folder is not healthy");
  }
}
