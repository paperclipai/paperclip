import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import type { DeploymentMode } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";

type FilesystemListEntry = {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
};

type FilesystemListResponse = {
  path: string;
  parent: string | null;
  entries: FilesystemListEntry[];
};

function uniquePaths(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = path.normalize(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

async function listWindowsRoots() {
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      const stats = await fs.stat(drive);
      if (stats.isDirectory()) roots.push(drive);
    } catch {
      // Skip drives that do not exist.
    }
  }
  return roots;
}

async function listFilesystemRoots() {
  if (process.platform === "win32") {
    return listWindowsRoots();
  }
  // Restrict Unix roots to the user's home directory. Including "/" made
  // isPathWithinRoot permit any absolute path, defeating containment.
  return uniquePaths([os.homedir()]);
}

function normalizeRequestedPath(requestedPath: string) {
  return path.resolve(requestedPath);
}

function pathParent(absolutePath: string) {
  const parent = path.dirname(absolutePath);
  return parent === absolutePath ? null : parent;
}

function isPathWithinRoot(candidatePath: string, allowedRoot: string) {
  const normalizedCandidate = path.normalize(candidatePath);
  const normalizedRoot = path.normalize(allowedRoot);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveExistingPath(candidatePath: string) {
  try {
    return await fs.realpath(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw notFound("Path not found");
    }
    throw error;
  }
}

function deniedUnixPrefixes() {
  const denied = [path.normalize("/etc/shadow")];
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    denied.push(path.normalize("/root"));
  }
  return denied;
}

function isDeniedPath(candidatePath: string) {
  if (process.platform === "win32") return false;
  const normalizedCandidate = path.normalize(candidatePath);
  for (const deniedPath of deniedUnixPrefixes()) {
    if (
      normalizedCandidate === deniedPath
      || normalizedCandidate.startsWith(`${deniedPath}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}

async function buildEntry(directoryPath: string, name: string): Promise<FilesystemListEntry | null> {
  const fullPath = path.join(directoryPath, name);
  const lstats = await fs.lstat(fullPath);
  if (isDeniedPath(fullPath)) return null;

  let isDir = lstats.isDirectory();
  if (lstats.isSymbolicLink()) {
    try {
      const stats = await fs.stat(fullPath);
      isDir = stats.isDirectory();
      // Also reject symlinks whose target resolves into a denied path so the
      // entry never appears in the listing. Without this, a symlink like
      // ~/.shadow_link -> /etc/shadow would render in the UI and only error
      // on selection.
      const resolvedTarget = await fs.realpath(fullPath);
      if (isDeniedPath(resolvedTarget)) return null;
    } catch {
      isDir = false;
    }
  }

  return {
    name,
    isDir,
    isSymlink: lstats.isSymbolicLink(),
  };
}

async function listDirectoryEntries(directoryPath: string) {
  const names = await fs.readdir(directoryPath);
  const entries = await Promise.all(names.map((name) => buildEntry(directoryPath, name)));
  return entries
    .filter((entry): entry is FilesystemListEntry => entry !== null)
    .sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

async function listRootsResponse(): Promise<FilesystemListResponse> {
  const roots = await listFilesystemRoots();
  return {
    path: "",
    parent: null,
    entries: roots.map((rootPath) => ({
      name: rootPath,
      isDir: true,
      isSymlink: false,
    })),
  };
}

export function filesystemRoutes(opts: { deploymentMode: DeploymentMode }) {
  const router = Router();

  router.get("/filesystem/list", async (req, res) => {
    if (opts.deploymentMode !== "local_trusted") {
      throw forbidden("Filesystem listing is only available in local_trusted mode");
    }

    const rawPath =
      typeof req.query.path === "string"
        ? req.query.path
        : req.query.path === undefined
          ? ""
          : null;
    if (rawPath === null) throw badRequest("Path must be a single string");
    if (rawPath === "") {
      res.json(await listRootsResponse());
      return;
    }
    if (!path.isAbsolute(rawPath)) {
      throw badRequest("Path must be absolute");
    }

    const requestedPath = normalizeRequestedPath(rawPath);
    const roots = await listFilesystemRoots();
    if (!roots.some((rootPath) => isPathWithinRoot(requestedPath, rootPath))) {
      throw forbidden("Path is outside the allowed filesystem roots");
    }

    const resolvedPath = await resolveExistingPath(requestedPath);
    if (isDeniedPath(resolvedPath)) {
      throw forbidden("Path is not allowed");
    }
    // Re-validate the symlink-resolved path against the allowed roots. Without
    // this, a symlink inside an allowed root whose target escapes the root
    // (e.g. ~/escape -> /var/secrets) would pass the pre-resolution root check
    // and expose out-of-root contents.
    if (!roots.some((rootPath) => isPathWithinRoot(resolvedPath, rootPath))) {
      throw forbidden("Resolved path is outside the allowed filesystem roots");
    }

    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      throw badRequest("Path must be a directory");
    }

    res.json({
      path: resolvedPath,
      parent: pathParent(resolvedPath),
      entries: await listDirectoryEntries(resolvedPath),
    } satisfies FilesystemListResponse);
  });

  return router;
}
