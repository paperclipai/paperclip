import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Checked before opening either format. An interrupted migration must never
 * turn a temporarily absent file into permission to create fresh authority. */
export function assertNoPendingLegacyMigration(stateDirectory: string): void {
  const path = resolve(dirname(stateDirectory), "indexed-migration.json");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("native_legacy_migration_unsafe");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error("native_legacy_migration_changed"); offset += count; }
    const after = fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("native_legacy_migration_changed");
    const marker = JSON.parse(bytes.toString()) as {schema?:unknown;phase?:unknown};
    if (marker.schema !== "paperclip.runner.legacy-activation.v1" || marker.phase !== "active") throw new Error("native_legacy_migration_pending");
  } finally { closeSync(fd); }
}
