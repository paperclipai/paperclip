import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Remove a retired controller-owned backup, never a live harness directory. */
export function removeNativeHarnessBackup(root: string): void {
  // Archives preserve immutable skill directory modes. Deleting their children
  // requires write permission on those directories, even with rm's force flag.
  // Only change directories in the backup being discarded. lstat deliberately
  // avoids following provider-created symlinks into live or unrelated trees.
  const prepareDirectory = (path: string): void => {
    const metadata = lstatSync(path, { throwIfNoEntry: false });
    if (!metadata?.isDirectory()) return;
    chmodSync(path, (metadata.mode & 0o777) | 0o700);
    for (const name of readdirSync(path)) prepareDirectory(join(path, name));
  };
  prepareDirectory(root);
  rmSync(root, { recursive: true, force: true });
}
