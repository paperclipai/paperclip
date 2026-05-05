import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const isWindows = os.platform() === "win32";

// On Windows, fs.symlink() with type "dir" (the default for directory targets)
// requires SeCreateSymbolicLinkPrivilege — i.e. running as administrator or
// having Developer Mode enabled. Without it, the call fails with EPERM and
// breaks adapter onboarding (see paperclipai/paperclip#63). Junctions are an
// older Windows reparse point that behaves like a directory symlink for our
// purposes (skills directories, adapter-managed home dirs) and does NOT need
// elevated privileges.
//
// Junctions only support absolute paths to local directories, so we resolve
// the source before creating one. For file targets, "file"-typed symlinks do
// not need elevated privileges on modern Windows, so we use them directly.
export async function safeSymlink(source: string, target: string): Promise<void> {
  if (!isWindows) {
    await fs.symlink(source, target);
    return;
  }

  const stats = await fs.stat(source).catch(() => null);
  if (stats?.isDirectory()) {
    await fs.symlink(path.resolve(source), target, "junction");
    return;
  }

  await fs.symlink(source, target, "file");
}
