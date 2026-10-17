import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ManagedDatabaseConfig } from "@paperclipai/shared/managed-database";

/**
 * On-volume layout owned by the managed database supervisor.
 *
 *   <mount>/           root:node 1775   app home; sticky, so the app cannot
 *                                       rename <root> (and every directory
 *                                       between <mount> and <root> likewise)
 *   <root>/            root 0711   traversable, not listable
 *     data/            db   0700   PGDATA
 *     pg-socket/       db   0700   PostgreSQL Unix socket (privileged roles)
 *     secrets/         root 0700   role passwords
 *     state/           root 0700   lease, recovery hold, restore intent
 *     receipts/        root 0700   signed command receipts
 *     snapshots/       root 0700   database archives + metadata
 *     public/          root 0755   readiness.json, control.sock (app-readable)
 *     marker.json      root 0600   stack-bound initialization marker
 *     volume.json      root 0600   volume identity bound at first initialization
 */
export type ManagedDatabaseLayout = ReturnType<typeof managedDatabaseLayout>;

export function managedDatabaseLayout(config: Pick<ManagedDatabaseConfig, "root" | "volume">) {
  const root = path.resolve(config.root);
  const publicDir = path.join(root, "public");
  const stateDir = path.join(root, "state");
  return {
    root,
    dataDir: path.join(root, "data"),
    socketDir: path.join(root, "pg-socket"),
    secretsDir: path.join(root, "secrets"),
    secretsFile: path.join(root, "secrets", "roles.json"),
    stateDir,
    leaseFile: path.join(stateDir, "lease.json"),
    holdFile: path.join(stateDir, "hold.json"),
    restoreIntentFile: path.join(stateDir, "restore-intent.json"),
    receiptsDir: path.join(root, "receipts"),
    snapshotsDir: path.join(root, "snapshots"),
    publicDir,
    readinessFile: path.join(publicDir, "readiness.json"),
    controlSocket: path.join(publicDir, "control.sock"),
    markerFile: path.join(root, "marker.json"),
    volumeIdentityFile: path.join(root, "volume.json"),
  };
}

/** Write JSON durably: temp file, fsync, rename, fsync the directory. */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fsyncFile(tmp);
  renameSync(tmp, file);
  fsyncDirectory(path.dirname(file));
}

/** Flush a finished file's contents before it is renamed into place. */
export function fsyncFile(file: string): void {
  const fd = openSync(file, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function fsyncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some filesystems reject directory fsync; the rename is still atomic.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function readJsonIfExists<T = unknown>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
