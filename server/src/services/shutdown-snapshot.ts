import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * Durable evidence that a graceful service stop found these runs in flight.
 *
 * The graceful drain lives in the database: it selects the `running` rows and
 * writes them back as `interrupted`. That is the right place for it, but it is
 * also the one resource a service stop can take away — systemd signals the
 * whole cgroup, and the embedded PostgreSQL goes down with the server. When
 * that happens the drain cannot write anything and the runs are later
 * reconciled as `adapter_failed`, which spends the issue's bounded retry
 * budget on an infrastructure event.
 *
 * This snapshot is written before the drain touches the database, from the
 * in-memory set of executions when the database is already gone. The next
 * server boot reads it and finalizes exactly those runs as
 * `server_shutdown_interrupted`, so a stop is never recorded as an adapter
 * failure.
 */
export const SHUTDOWN_SNAPSHOT_FILENAME = "shutdown-snapshot.json";

export type ShutdownSnapshot = {
  version: 1;
  capturedAt: string;
  signal: "SIGINT" | "SIGTERM";
  serverPid: number;
  /** Runs this server had in flight when it started stopping. */
  runIds: string[];
};

export function resolveShutdownSnapshotPath(homeDir?: string): string {
  return path.join(resolvePaperclipInstanceRoot({ homeDir }), SHUTDOWN_SNAPSHOT_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSignal(value: unknown): "SIGINT" | "SIGTERM" | null {
  return value === "SIGINT" || value === "SIGTERM" ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Parse leniently so a partially written or older file cannot block startup. */
export function parseShutdownSnapshot(value: unknown): ShutdownSnapshot | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const capturedAt = readString(value.capturedAt);
  const signal = readSignal(value.signal);
  const serverPid = readPositiveInteger(value.serverPid);
  const runIds = Array.isArray(value.runIds)
    ? [
        ...new Set(
          value.runIds
            .map((id) => readString(id))
            .filter((id): id is string => id !== null),
        ),
      ]
    : null;
  if (!capturedAt || !signal || !serverPid || !runIds) return null;
  if (Number.isNaN(new Date(capturedAt).getTime())) return null;
  return { version: 1, capturedAt, signal, serverPid, runIds };
}

export async function readShutdownSnapshot(homeDir?: string): Promise<ShutdownSnapshot | null> {
  let content: string;
  try {
    content = await fs.readFile(resolveShutdownSnapshotPath(homeDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return parseShutdownSnapshot(JSON.parse(content));
  } catch {
    return null;
  }
}

export async function writeShutdownSnapshot(
  snapshot: ShutdownSnapshot,
  homeDir?: string,
): Promise<void> {
  const filePath = resolveShutdownSnapshotPath(homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function removeShutdownSnapshot(homeDir?: string): Promise<void> {
  await fs.rm(resolveShutdownSnapshotPath(homeDir), { force: true });
}
