import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Remove a retired controller-owned backup, never a live harness directory. */
export async function removeNativeHarnessBackup(root: string): Promise<void> {
  // Archives preserve immutable skill directory modes. Deleting their children
  // requires write permission on those directories, even with rm's force flag.
  // Only change directories in the backup being discarded. lstat deliberately
  // avoids following provider-created symlinks into live or unrelated trees.
  const prepareDirectory = async (path: string): Promise<void> => {
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata?.isDirectory()) return;
    await chmod(path, (metadata.mode & 0o777) | 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await prepareDirectory(join(path, entry.name));
    }
  };
  await prepareDirectory(root);
  await rm(root, { recursive: true, force: true });
}
