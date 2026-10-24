import fs from "node:fs/promises";

/**
 * Staging dirs whose recursive delete was moved off the cancellation path.
 * A multi-GB staging tree can take minutes to delete on slow storage, so a
 * cancelled restore hands its delete to {@link cleanupStagingDirInBackground}
 * instead of awaiting it: Stop returns promptly and tmpdir reclamation
 * follows in the background. Entries are dropped once the delete settles, so
 * the set always reflects deletes still owed.
 */
const pendingStagingCleanups = new Set<string>();

export function cleanupStagingDirInBackground(stagingDir: string): void {
  if (pendingStagingCleanups.has(stagingDir)) return;
  pendingStagingCleanups.add(stagingDir);
  void fs
    .rm(stagingDir, { recursive: true, force: true })
    .catch(() => undefined)
    .finally(() => {
      pendingStagingCleanups.delete(stagingDir);
    });
}
