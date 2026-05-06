import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkspaceBrowserKind,
  WorkspaceFileBrowserContent,
  WorkspaceFileBrowserEntry,
  WorkspaceFileBrowserListing,
} from "@paperclipai/shared";

const DIRECTORY_ENTRY_LIMIT = 500;
const FILE_PREVIEW_LIMIT_BYTES = 128 * 1024;

function normalizeStatSize(size: number | bigint): number {
  return typeof size === "bigint" ? Number(size) : size;
}

const CONTENT_TYPE_BY_EXTENSION = new Map<string, string>([
  [".cjs", "application/javascript"],
  [".conf", "text/plain"],
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "application/javascript"],
  [".json", "application/json"],
  [".jsonc", "application/json"],
  [".jsx", "application/javascript"],
  [".log", "text/plain"],
  [".md", "text/markdown"],
  [".mjs", "application/javascript"],
  [".png", "image/png"],
  [".py", "text/x-python"],
  [".sh", "application/x-sh"],
  [".sql", "application/sql"],
  [".svg", "image/svg+xml"],
  [".toml", "application/toml"],
  [".ts", "application/typescript"],
  [".tsx", "application/typescript"],
  [".txt", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

const TEXT_PREVIEW_CONTENT_TYPES = new Set<string>([
  "application/javascript",
  "application/json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-sh",
  "application/xml",
  "application/yaml",
  "text/css",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/x-python",
]);

export class WorkspaceFileBrowserError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileBrowserError";
  }
}

interface ResolvedWorkspacePath {
  rootPath: string;
  absolutePath: string;
  relativePath: string;
  stats: Awaited<ReturnType<typeof fs.stat>>;
}

function normalizeRelativePath(relativePath: string | null | undefined): string {
  if (!relativePath) return "";
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new WorkspaceFileBrowserError(400, "Path traversal is not allowed.");
  }
  return segments.join("/");
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

function inferContentType(name: string): string | null {
  const extension = path.extname(name).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION.get(extension) ?? null;
}

function isTextPreviewContentType(contentType: string | null): boolean {
  return Boolean(contentType && (contentType.startsWith("text/") || TEXT_PREVIEW_CONTENT_TYPES.has(contentType)));
}

function isImageContentType(contentType: string | null): boolean {
  return Boolean(contentType?.startsWith("image/"));
}

function buildParentPath(relativePath: string): string | null {
  if (!relativePath) return null;
  const lastSlash = relativePath.lastIndexOf("/");
  return lastSlash === -1 ? "" : relativePath.slice(0, lastSlash);
}

async function resolveWorkspacePath(
  rootPath: string,
  relativePath: string | null | undefined,
  expectedKind?: "file" | "dir",
): Promise<ResolvedWorkspacePath> {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const resolvedRootPath = await fs.realpath(rootPath).catch(() => null);
  if (!resolvedRootPath) {
    throw new WorkspaceFileBrowserError(404, "Workspace path is not available.");
  }

  const candidatePath = normalizedRelativePath
    ? path.resolve(resolvedRootPath, normalizedRelativePath)
    : resolvedRootPath;

  const resolvedTargetPath = await fs.realpath(candidatePath).catch(() => null);
  if (!resolvedTargetPath || !isPathWithinRoot(resolvedRootPath, resolvedTargetPath)) {
    throw new WorkspaceFileBrowserError(404, "Requested file path was not found.");
  }

  const stats = await fs.stat(resolvedTargetPath).catch(() => null);
  if (!stats) {
    throw new WorkspaceFileBrowserError(404, "Requested file path was not found.");
  }
  if (expectedKind === "dir" && !stats.isDirectory()) {
    throw new WorkspaceFileBrowserError(400, "Requested path is not a directory.");
  }
  if (expectedKind === "file" && !stats.isFile()) {
    throw new WorkspaceFileBrowserError(400, "Requested path is not a file.");
  }

  return {
    rootPath: resolvedRootPath,
    absolutePath: resolvedTargetPath,
    relativePath: normalizedRelativePath,
    stats,
  };
}

async function toBrowserEntry(
  rootPath: string,
  directoryPath: string,
  entry: string,
): Promise<WorkspaceFileBrowserEntry | null> {
  const absolutePath = path.join(directoryPath, entry);
  const resolvedPath = await fs.realpath(absolutePath).catch(() => null);
  if (!resolvedPath || !isPathWithinRoot(rootPath, resolvedPath)) {
    return null;
  }

  const stats = await fs.stat(resolvedPath).catch(() => null);
  if (!stats) return null;

  const relativePath = path.relative(rootPath, resolvedPath).split(path.sep).join("/");
  const contentType = stats.isFile() ? inferContentType(entry) : null;
  const previewable = stats.isFile() && (isTextPreviewContentType(contentType) || isImageContentType(contentType));

  return {
    name: entry,
    path: relativePath,
    kind: stats.isDirectory() ? "dir" : "file",
    byteSize: stats.isFile() ? stats.size : null,
    extension: stats.isFile() ? path.extname(entry).toLowerCase() || null : null,
    updatedAt: stats.mtime,
    contentType,
    previewable,
  };
}

export async function listWorkspaceFiles(options: {
  workspaceKind: WorkspaceBrowserKind;
  workspaceId: string;
  workspaceName: string;
  rootPath: string;
  relativePath?: string | null;
}): Promise<WorkspaceFileBrowserListing> {
  const resolved = await resolveWorkspacePath(options.rootPath, options.relativePath, "dir");
  const entries = await fs.readdir(resolved.absolutePath);
  const browserEntries = (
    await Promise.all(entries.slice(0, DIRECTORY_ENTRY_LIMIT).map((entry) => toBrowserEntry(resolved.rootPath, resolved.absolutePath, entry)))
  )
    .filter((entry): entry is WorkspaceFileBrowserEntry => entry !== null)
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

  return {
    workspaceKind: options.workspaceKind,
    workspaceId: options.workspaceId,
    workspaceName: options.workspaceName,
    rootPath: resolved.rootPath,
    currentPath: resolved.relativePath,
    parentPath: buildParentPath(resolved.relativePath),
    entries: browserEntries,
  };
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export async function readWorkspaceFileContent(options: {
  workspaceKind: WorkspaceBrowserKind;
  workspaceId: string;
  workspaceName: string;
  rootPath: string;
  relativePath: string;
}): Promise<WorkspaceFileBrowserContent> {
  const resolved = await resolveWorkspacePath(options.rootPath, options.relativePath, "file");
  const contentType = inferContentType(resolved.absolutePath);
  if (!isTextPreviewContentType(contentType)) {
    throw new WorkspaceFileBrowserError(415, "This file cannot be previewed as text.");
  }

  const fileSize = normalizeStatSize(resolved.stats.size);
  const bytesToRead = Math.min(fileSize, FILE_PREVIEW_LIMIT_BYTES);
  const handle = await fs.open(resolved.absolutePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    if (looksBinary(buffer)) {
      throw new WorkspaceFileBrowserError(415, "This file cannot be previewed as text.");
    }

    return {
      workspaceKind: options.workspaceKind,
      workspaceId: options.workspaceId,
      workspaceName: options.workspaceName,
      rootPath: resolved.rootPath,
      path: resolved.relativePath,
      byteSize: fileSize,
      contentType,
      previewable: true,
      truncated: fileSize > FILE_PREVIEW_LIMIT_BYTES,
      content: buffer.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

export async function resolveWorkspaceFileForDownload(options: {
  rootPath: string;
  relativePath: string;
}): Promise<{ absolutePath: string; contentType: string | null }> {
  const resolved = await resolveWorkspacePath(options.rootPath, options.relativePath, "file");
  return {
    absolutePath: resolved.absolutePath,
    contentType: inferContentType(resolved.absolutePath),
  };
}
