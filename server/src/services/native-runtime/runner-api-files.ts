import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Open a previously authorized canonical path without following raced symlinks. */
export async function openRunnerApiWorkspaceFile(path: string): Promise<FileHandle> {
  return openRunnerWorkspaceFile(path, constants.O_RDONLY);
}

/** Confined open for reads or writes; flags are server-selected, never provider input. */
export async function openRunnerWorkspaceFile(path: string, flags: number, mode?: number): Promise<FileHandle> {
  if (!isAbsolute(path)) throw new Error("Workspace file must have a canonical absolute path");
  if (process.platform === "darwin") {
    // Darwin sys/fcntl.h: O_NOFOLLOW_ANY rejects symlinks at every component.
    // Node does not expose this flag in fs.constants. Unsupported kernels fail
    // closed instead of falling back to a pathname check followed by open.
    return open(path, flags | constants.O_NONBLOCK | 0x20000000, mode);
  }
  if (process.platform !== "linux") throw new Error("Workspace uploads require a platform with confined file opens; use an authorized artifact reference");
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === "..")) throw new Error("Invalid canonical workspace path");
  let directory = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of parts.slice(0, -1)) {
      // Linux magic descriptor links provide openat-style directory confinement.
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close();
      directory = next;
    }
    return await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, flags | constants.O_NONBLOCK | constants.O_NOFOLLOW, mode);
  } finally { await directory.close(); }
}
