import { constants } from "node:fs";
import { open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { logger } from "../middleware/logger.js";

const OPEN_DIRECTORY_NOFOLLOW = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

function isPermissionError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

const throughHandle = (handle: FileHandle, name?: string) =>
  name === undefined ? `/proc/self/fd/${handle.fd}` : `/proc/self/fd/${handle.fd}/${name}`;

async function openDirectoryNoFollow(target: string) {
  try { return await open(target, OPEN_DIRECTORY_NOFOLLOW); }
  catch { return undefined; }
}

async function handleLookupIsBound(handle: FileHandle) {
  if (process.platform !== "linux") return false;
  try {
    const [opened, resolved] = await Promise.all([handle.stat(), stat(throughHandle(handle))]);
    return opened.dev === resolved.dev && opened.ino === resolved.ino;
  } catch {
    return false;
  }
}

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
