import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const MAX_PERSISTED_DEV_SERVER_STATUS_BYTES = 64 * 1024;
const DEV_RESTART_REQUEST_LOCK_STALE_MS = 30_000;
const DEV_RESTART_REQUEST_LOCK_RETRY_COUNT = 50;
const DEV_RESTART_REQUEST_LOCK_RETRY_MS = 2;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export type PersistedDevServerStatus = {
  dirty: boolean;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  pendingMigrations: string[];
  lastRestartAt: string | null;
};

export type DevServerHealthStatus = {
  enabled: true;
  restartRequired: boolean;
  reason:
    | "backend_changes"
    | "pending_migrations"
    | "backend_changes_and_pending_migrations"
    | null;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  pendingMigrations: string[];
  autoRestartEnabled: boolean;
  activeRunCount: number;
  waitingForIdle: boolean;
  lastRestartAt: string | null;
};

export type DevServerRestartRequest = {
  requestedAt: string;
  reason: "manual_restart_now";
  requestId?: string;
  mode?: "hot";
  previousServerIdentity?: string;
};

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function tryRecoverDevRestartRequestLock(lockPath: string): boolean {
  let stale = false;
  try {
    const lockAgeMs = Date.now() - statSync(lockPath).mtimeMs;
    const owner = JSON.parse(
      readFileSync(path.join(lockPath, "owner.json"), "utf8"),
    ) as Record<string, unknown>;
    stale =
      lockAgeMs >= DEV_RESTART_REQUEST_LOCK_STALE_MS ||
      (typeof owner.pid === "number" && !processIsAlive(owner.pid));
  } catch {
    // Canonical locks are published only after owner.json is durable in a
    // private candidate directory. A visible lock without valid ownership is
    // therefore abandoned and can be reclaimed immediately.
    stale = true;
  }
  if (!stale) return false;

  const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return true;
    }
    return false;
  }
  rmSync(stalePath, { recursive: true, force: true });
  return true;
}

function withDevRestartRequestLock<T>(filePath: string, action: () => T): T {
  const lockPath = `${filePath}.lock`;
  for (
    let attempt = 0;
    attempt <= DEV_RESTART_REQUEST_LOCK_RETRY_COUNT;
    attempt += 1
  ) {
    const candidateLockPath = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
    mkdirSync(candidateLockPath);
    try {
      writeFileSync(
        path.join(candidateLockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      try {
        // Publishing a populated directory makes lock ownership visible in one
        // rename; there is no canonical owner-less crash window.
        renameSync(candidateLockPath, lockPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") {
          throw error;
        }
        if (tryRecoverDevRestartRequestLock(lockPath)) continue;
        if (attempt === DEV_RESTART_REQUEST_LOCK_RETRY_COUNT) {
          throw new Error("dev_server_restart_request_lock_busy");
        }
        Atomics.wait(
          lockWaitBuffer,
          0,
          0,
          DEV_RESTART_REQUEST_LOCK_RETRY_MS,
        );
        continue;
      }
    } finally {
      if (existsSync(candidateLockPath)) {
        rmSync(candidateLockPath, { recursive: true, force: true });
      }
    }
    try {
      return action();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
  throw new Error("dev_server_restart_request_lock_busy");
}

export function getDevServerRestartRequestFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const statusFilePath = env.PAPERCLIP_DEV_SERVER_STATUS_FILE?.trim();
  if (!statusFilePath) return null;
  return path.join(
    path.dirname(statusFilePath),
    "dev-server-restart-request.json",
  );
}

export function writeDevServerRestartRequest(
  request: DevServerRestartRequest,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const filePath = getDevServerRestartRequestFilePath(env);
  if (!filePath) return false;

  mkdirSync(path.dirname(filePath), { recursive: true });
  withDevRestartRequestLock(filePath, () => {
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
      renameSync(tempPath, filePath);
    } finally {
      try {
        unlinkSync(tempPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  });
  return true;
}

function readDevServerRestartRequestAtPath(
  filePath: string,
): DevServerRestartRequest | null {
  try {
    if (statSync(filePath).size > MAX_PERSISTED_DEV_SERVER_STATUS_BYTES)
      return null;
    const value = JSON.parse(readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof value.requestedAt !== "string" ||
      value.reason !== "manual_restart_now"
    ) {
      return null;
    }
    return {
      requestedAt: value.requestedAt,
      reason: "manual_restart_now",
      ...(typeof value.requestId === "string"
        ? { requestId: value.requestId }
        : {}),
      ...(value.mode === "hot" ? { mode: "hot" as const } : {}),
      ...(typeof value.previousServerIdentity === "string"
        ? { previousServerIdentity: value.previousServerIdentity }
        : {}),
    };
  } catch {
    return null;
  }
}

export function readDevServerRestartRequest(
  env: NodeJS.ProcessEnv = process.env,
): DevServerRestartRequest | null {
  const filePath = getDevServerRestartRequestFilePath(env);
  if (!filePath || !existsSync(filePath)) return null;
  return readDevServerRestartRequestAtPath(filePath);
}

export function removeDevServerRestartRequest(
  expected?: Pick<DevServerRestartRequest, "requestId">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const filePath = getDevServerRestartRequestFilePath(env);
  if (!filePath) return false;
  try {
    withDevRestartRequestLock(filePath, () => {
      const current = readDevServerRestartRequestAtPath(filePath);
      if (expected?.requestId && current?.requestId !== expected.requestId) return;
      rmSync(filePath, { force: true });
    });
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "dev_server_restart_request_lock_busy"
    ) {
      return false;
    }
    throw error;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readPersistedDevServerStatus(
  env: NodeJS.ProcessEnv = process.env,
): PersistedDevServerStatus | null {
  const filePath = env.PAPERCLIP_DEV_SERVER_STATUS_FILE?.trim();
  if (!filePath || !existsSync(filePath)) return null;

  try {
    if (statSync(filePath).size > MAX_PERSISTED_DEV_SERVER_STATUS_BYTES) {
      return null;
    }
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    const changedPathsSample = normalizeStringArray(
      raw.changedPathsSample,
    ).slice(0, 5);
    const pendingMigrations = normalizeStringArray(raw.pendingMigrations);
    const changedPathCountRaw = raw.changedPathCount;
    const changedPathCount =
      typeof changedPathCountRaw === "number" &&
      Number.isFinite(changedPathCountRaw)
        ? Math.max(0, Math.trunc(changedPathCountRaw))
        : changedPathsSample.length;
    const dirtyRaw = raw.dirty;
    const dirty =
      typeof dirtyRaw === "boolean"
        ? dirtyRaw
        : changedPathCount > 0 || pendingMigrations.length > 0;

    return {
      dirty,
      lastChangedAt: normalizeTimestamp(raw.lastChangedAt),
      changedPathCount,
      changedPathsSample,
      pendingMigrations,
      lastRestartAt: normalizeTimestamp(raw.lastRestartAt),
    };
  } catch {
    return null;
  }
}

export function toDevServerHealthStatus(
  persisted: PersistedDevServerStatus,
  opts: { autoRestartEnabled: boolean; activeRunCount: number },
): DevServerHealthStatus {
  const hasPathChanges = persisted.changedPathCount > 0;
  const hasPendingMigrations = persisted.pendingMigrations.length > 0;
  const reason =
    hasPathChanges && hasPendingMigrations
      ? "backend_changes_and_pending_migrations"
      : hasPendingMigrations
        ? "pending_migrations"
        : hasPathChanges
          ? "backend_changes"
          : null;
  const restartRequired = persisted.dirty || reason !== null;

  return {
    enabled: true,
    restartRequired,
    reason,
    lastChangedAt: persisted.lastChangedAt,
    changedPathCount: persisted.changedPathCount,
    changedPathsSample: persisted.changedPathsSample,
    pendingMigrations: persisted.pendingMigrations,
    autoRestartEnabled: opts.autoRestartEnabled,
    activeRunCount: opts.activeRunCount,
    waitingForIdle:
      restartRequired && opts.autoRestartEnabled && opts.activeRunCount > 0,
    lastRestartAt: persisted.lastRestartAt,
  };
}
