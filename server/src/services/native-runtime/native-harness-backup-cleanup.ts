import { chmod, lstat, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { sortedNativeHarnessNames } from "./native-harness-tree.js";

/** Remove a retired controller-owned backup, never a live harness directory. */
export async function removeNativeHarnessBackup(root: string): Promise<void> {
  // Archives preserve immutable skill directory modes. Deleting their children
  // requires write permission on those directories, even with rm's force flag.
  // Only change directories in the backup being discarded. lstat deliberately
  // avoids following provider-created symlinks into live or unrelated trees.
  const remove = async (path: string, depth: number): Promise<void> => {
    // Published harness trees use the same path-depth bound. File count and
    // historical bytes are unbounded; directory names spill to private disk.
    if (depth > 128) throw new Error("runner_harness_backup_path_too_deep");
    const metadata = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return;
    if (!metadata.isDirectory()) { await unlink(path); return; }
    await chmod(path, (metadata.mode & 0o777) | 0o700);
    for await (const name of sortedNativeHarnessNames(path)) await remove(join(path, name), depth + 1);
    await rmdir(path);
  };
  await remove(root, 0);
}
