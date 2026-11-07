import { constants, createReadStream } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

// The marker survives process replacement on persistent instance storage.
// It contains no credentials or tenant data, and never substitutes for a dump.
export const idleBackupWakeMarker = (directory: string) => path.join(directory, ".idle-backup-wake-required");

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function markIdleBackupWakeRequired(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const marker = await open(idleBackupWakeMarker(directory), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await marker.writeFile("Take a fresh database backup after this process restarts.\n");
    await marker.sync();
  } finally { await marker.close(); }
  await syncDirectory(directory);
}

/** Read the entire archive to verify the gzip trailer, then persist its bytes
 * and directory entry before allowing compute to stop. The backup runner
 * retains its in-flight receipt until this function settles. */
export async function verifyIdleDatabaseBackup(backupFile: string): Promise<void> {
  const handle = await open(backupFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) throw new Error("Idle backup archive is empty or invalid");
    let bytes = 0;
    await pipeline(
      createReadStream(backupFile, { fd: handle.fd, autoClose: false }),
      createGunzip(),
      new Writable({ write(chunk, _encoding, done) { bytes += chunk.length; done(); } }),
    );
    if (bytes === 0) throw new Error("Idle backup archive contains no SQL");
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(path.dirname(backupFile));
}

export async function clearIdleBackupWakeRequired(directory: string): Promise<void> {
  await unlink(idleBackupWakeMarker(directory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await syncDirectory(directory);
}
