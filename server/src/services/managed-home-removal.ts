import { constants } from "node:fs";
import { open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { logger } from "../middleware/logger.js";

const OPEN_DIRECTORY_NOFOLLOW = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

function isPermissionError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

// Grants the owner rwx on every real directory below `directory`. Symlinks are
// never followed: `withFileTypes` entries report links as non-directories, and
// each directory is changed through a handle opened with O_NOFOLLOW, so a link
// to a read-only target outside the tree keeps its target's mode.
async function grantOwnerDirectoryAccess(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, OPEN_DIRECTORY_NOFOLLOW); }
  catch { return; }
  try {
    const { mode } = await handle.stat();
    if ((mode & 0o700) !== 0o700) await handle.chmod((mode & 0o7777) | 0o700);
  } catch { /* Removal below reports what is still blocked. */ }
  finally { await handle.close(); }
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) await grantOwnerDirectoryAccess(path.join(directory, entry.name));
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
  await grantOwnerDirectoryAccess(home);
  try {
    await rm(home, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ err: error, code: (error as NodeJS.ErrnoException)?.code }, "Managed AI run home could not be removed");
    throw error;
  }
}
