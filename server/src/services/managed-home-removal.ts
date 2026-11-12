import { constants } from "node:fs";
import { open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { logger } from "../middleware/logger.js";

const OPEN_DIRECTORY_NOFOLLOW = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

function isPermissionError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

// Path of a child entry resolved relative to an open directory handle rather
// than to a pathname. On Linux `/proc/self/fd/<fd>` always names the exact
// directory the handle was opened on, so renaming or replacing that directory
// (or any of its ancestors) with a symlink cannot redirect the lookup.
const throughHandle = (handle: FileHandle, name?: string) =>
  name === undefined ? `/proc/self/fd/${handle.fd}` : `/proc/self/fd/${handle.fd}/${name}`;

async function openDirectoryNoFollow(target: string) {
  try { return await open(target, OPEN_DIRECTORY_NOFOLLOW); }
  catch { return undefined; }
}

// Checks that handle-relative lookups really resolve to the opened directory.
// Without that guarantee (for example no Linux procfs) the walk is skipped and
// the removal failure is reported instead of risking changes outside the home.
async function handleLookupIsBound(handle: FileHandle) {
  if (process.platform !== "linux") return false;
  try {
    const [opened, resolved] = await Promise.all([handle.stat(), stat(throughHandle(handle))]);
    return opened.dev === resolved.dev && opened.ino === resolved.ino;
  } catch {
    return false;
  }
}

// Grants the owner rwx on the directory held by `handle` and every real
// directory below it on the same filesystem. Every child is listed and opened
// through its parent's handle with O_NOFOLLOW, and changed through its own
// handle, so symlinks, replaced ancestors and mount points are never crossed.
async function grantOwnerDirectoryAccess(handle: FileHandle, device: number): Promise<void> {
  try {
    const { mode, dev } = await handle.stat();
    if (dev !== device) return;
    if ((mode & 0o700) !== 0o700) await handle.chmod((mode & 0o7777) | 0o700);
  } catch { return; }
  let entries;
  try { entries = await readdir(throughHandle(handle), { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = await openDirectoryNoFollow(throughHandle(handle, entry.name));
    if (!child) continue;
    try { await grantOwnerDirectoryAccess(child, device); }
    finally { await child.close(); }
  }
}

async function restoreOwnerAccess(home: string) {
  const handle = await openDirectoryNoFollow(home);
  if (!handle) return;
  try {
    if (!(await handleLookupIsBound(handle))) {
      logger.warn({ home }, "Managed AI run home permissions were not repaired: directory handles cannot be traversed safely on this platform");
      return;
    }
    await grantOwnerDirectoryAccess(handle, (await handle.stat()).dev);
  } finally {
    await handle.close();
  }
}

/**
 * Removes a managed AI run home that removal has already been decided for.
 * Tools such as the Go module cache leave read-only directories, which make a
 * plain recursive removal stop part-way with EACCES. On a permission error this
 * restores owner access inside the home and retries once; a remaining failure
 * is logged and rethrown so callers keep their existing retention behavior.
 */
export async function removeManagedHome(home: string): Promise<void> {
  try {
    await rm(home, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!isPermissionError(error)) throw error;
  }
  await restoreOwnerAccess(home);
  try {
    await rm(home, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ err: error, code: (error as NodeJS.ErrnoException)?.code }, "Managed AI run home could not be removed");
    throw error;
  }
}
