import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;

export async function resolveHarnessStateDirectory(value: string): Promise<string> {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error("Harness state directory must be an absolute normalized path");
  }
  if (dirname(value) === value) throw new Error("Harness state directory must not be a filesystem root");
  let metadata: Stats;
  let physical: string;
  try {
    metadata = await lstat(value);
    physical = await realpath(value);
  } catch (error) {
    throw Object.assign(new Error("Harness state directory is unavailable"), { code: errorCode(error) });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || physical !== value) {
    throw new Error("Harness state directory must be a real directory named by its physical path");
  }
  return value;
}

export async function prepareHarnessStateSessionRoot(
  harnessStateDirectory: string,
  namespace: string,
  sessionDirectoryName: string,
): Promise<{ directory: string; root: string }> {
  const directory = await resolveHarnessStateDirectory(harnessStateDirectory);
  const physicalNamespace = await ensurePrivateDirectory(join(directory, namespace), directory, "Harness state");
  const root = await ensurePrivateDirectory(join(physicalNamespace, sessionDirectoryName), physicalNamespace, "Harness state");
  return { directory, root };
}

export async function ensurePrivateDirectory(
  directory: string,
  physicalParent: string,
  label = "ACPX sandbox",
): Promise<string> {
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  let handle: FileHandle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error(`${label} path must be a real directory`);
  }
  let physical: string;
  try {
    const opened = await handle.stat();
    const entry = await lstat(directory);
    if (
      !opened.isDirectory() ||
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !sameFile(entry, opened)
    ) {
      throw new Error(`${label} path must be a real directory`);
    }
    // Apply permissions to the inode that was opened without following links.
    // A directory-entry swap can therefore never redirect chmod to its target.
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
    physical = await realpath(directory);
    const verifiedEntry = await lstat(directory);
    if (!sameFile(verifiedEntry, opened)) {
      throw new Error(`${label} directory changed during preparation`);
    }
    if (!isInside(physicalParent, physical)) {
      throw new Error(`${label} directory escaped its private parent`);
    }
    // Persist the child inode before the directory entry that names it.
    if (process.platform !== "win32") await handle.sync();
  } finally {
    await handle.close();
  }
  // Sync the parent even during recovery: an earlier process may have created
  // the entry and crashed before making that mkdir durable.
  await syncDirectory(physicalParent);
  return physical;
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function isInside(parent: string, child: string): boolean {
  const childPath = relative(parent, child);
  return (
    childPath.length > 0 &&
    childPath !== ".." &&
    !childPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(childPath)
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}
