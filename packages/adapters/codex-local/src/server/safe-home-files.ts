import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Remote staging runs on the host. A local agent can change its mounted home
// while the service is preparing a later run, so paths below that home must be
// opened relative to pinned directories, never checked and then read by name.
const fdRoot = process.platform === "linux" ? "/proc/self/fd" :
  process.platform === "darwin" ? "/dev/fd" : null;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type SafeHandle = {
  fd: number | null;
  path: string;
  stat: () => Promise<Stats>;
  readFile: () => Promise<Buffer>;
  close: () => Promise<void>;
};

function wrapHandle(handle: FileHandle, candidate: string): SafeHandle {
  return {
    fd: handle.fd,
    path: candidate,
    stat: () => handle.stat(),
    readFile: () => handle.readFile(),
    close: () => handle.close(),
  };
}

function wrapUnconfinedPath(candidate: string): SafeHandle {
  return {
    fd: null,
    path: candidate,
    stat: () => fs.stat(candidate),
    readFile: () => fs.readFile(candidate),
    close: async () => {},
  };
}

function fdPath(dir: SafeHandle, name?: string): string {
  if (name && (name === "." || name === ".." || path.basename(name) !== name)) {
    throw new Error("Invalid Codex home entry name");
  }
  const base = fdRoot && dir.fd !== null ? path.join(fdRoot, String(dir.fd)) : dir.path;
  return name ? path.join(base, name) : base;
}

export async function openDirectoryNoFollow(directory: string): Promise<SafeHandle> {
  if (!path.isAbsolute(directory)) throw new Error("Codex home path must be absolute");
  if (!fdRoot) {
    // Windows has no /proc/self/fd-style directory anchor. Preserve normal
    // Codex home behavior there; never use that fallback with a service DB file.
    if (process.env.PAPERCLIP_DATABASE_URL_FILE?.trim()) {
      throw new Error("File-backed database credentials require descriptor-based Codex home staging");
    }
    if (!(await fs.stat(directory)).isDirectory()) throw new Error("Codex home path is not a directory");
    return wrapUnconfinedPath(directory);
  }
  // Traverse from a pinned root so a local agent cannot replace an ancestor
  // after a path check. Never follow a directory link here: a local agent and
  // the service may share a UID, so ownership and mode cannot establish whether
  // the link was planted inside the agent's writable mount namespace.
  const root = path.parse(directory).root;
  const parts = path.resolve(directory).slice(root.length).split(path.sep).filter(Boolean);
  let current = wrapHandle(await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY), root);
  try {
    for (const part of parts) {
      const candidate = fdPath(current, part);
      let next: FileHandle;
      try {
        next = await fs.open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((await lstatChild(current, part))?.isSymbolicLink()) {
          throw new Error("Codex home path contains an untrusted directory symlink");
        }
        throw error;
      }
      await current.close();
      current = wrapHandle(next, candidate);
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

export async function openChildNoFollow(dir: SafeHandle, name: string): Promise<SafeHandle | null> {
  const candidate = fdPath(dir, name);
  if (!fdRoot) {
    const stat = await fs.lstat(candidate).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) return wrapUnconfinedPath(candidate);
    return wrapHandle(await fs.open(candidate, constants.O_RDONLY), candidate);
  }
  try {
    return wrapHandle(await fs.open(candidate, readFlags), candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw error;
  }
}

export async function lstatChild(dir: SafeHandle, name: string): Promise<Stats | null> {
  try {
    return await fs.lstat(fdPath(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function openPathNoFollow(candidate: string): Promise<SafeHandle | null> {
  const dir = await openDirectoryNoFollow(path.dirname(candidate));
  try {
    return await openChildNoFollow(dir, path.basename(candidate));
  } finally {
    await dir.close();
  }
}

export async function readRegularFileNoFollow(candidate: string): Promise<Buffer | null> {
  const handle = await openPathNoFollow(candidate);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Codex home entry is not a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readChildLink(dir: SafeHandle, name: string): Promise<string | null> {
  try {
    return await fs.readlink(fdPath(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listPinnedDirectory(dir: SafeHandle): Promise<string[]> {
  return fs.readdir(fdPath(dir));
}

export async function replaceRegularFileNoFollow(candidate: string, bytes: string | Buffer): Promise<void> {
  const dir = await openDirectoryNoFollow(path.dirname(candidate));
  const name = path.basename(candidate);
  const temporary = `.paperclip-${randomUUID()}`;
  const temporaryPath = fdPath(dir, temporary);
  const targetPath = fdPath(dir, name);
  try {
    const handle = await fs.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    // Rename replaces the directory entry itself, never its symlink target.
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await dir.close();
  }
}

export async function removeFileNoFollow(candidate: string): Promise<void> {
  const dir = await openDirectoryNoFollow(path.dirname(candidate));
  try {
    await fs.unlink(fdPath(dir, path.basename(candidate))).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  } finally {
    await dir.close();
  }
}
