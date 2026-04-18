import { promises as fs } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type LockFilePayload = {
  pid: number;
  createdAt: string;
};

export interface EmbeddedPostgresBootstrapLockOptions {
  dataDir: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 15_000;
const LOCK_FILE_SUFFIX = ".paperclip-embedded-postgres-bootstrap.lock";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockFile(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") {
      return null;
    }
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function inspectLockFile(lockPath: string): Promise<{
  payload: LockFilePayload | null;
  mtimeMs: number | null;
} | null> {
  try {
    const stat = await fs.stat(lockPath);
    return {
      payload: await readLockFile(lockPath),
      mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null,
    };
  } catch {
    return null;
  }
}

export function readEmbeddedPostmasterInfo(postmasterPidFile: string): {
  pid: number | null;
  port: number | null;
} {
  if (!existsSync(postmasterPidFile)) {
    return { pid: null, port: null };
  }

  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const rawPid = Number(lines[0]?.trim());
    const rawPort = Number(lines[3]?.trim());
    const pid = Number.isInteger(rawPid) && rawPid > 0 && isProcessRunning(rawPid) ? rawPid : null;
    const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : null;
    return { pid, port };
  } catch {
    return { pid: null, port: null };
  }
}

async function removeLockFile(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true });
}

export async function acquireEmbeddedPostgresBootstrapLock(
  input: EmbeddedPostgresBootstrapLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleMs = input.staleMs ?? DEFAULT_STALE_MS;
  const lockPath = path.resolve(
    path.dirname(input.dataDir),
    `${path.basename(input.dataDir)}${LOCK_FILE_SUFFIX}`,
  );
  const startedAt = Date.now();
  const payload: LockFilePayload = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  while (true) {
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, JSON.stringify(payload), { flag: "wx" });
      return async () => {
        await removeLockFile(lockPath);
      };
    } catch (error) {
      const maybeCode =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (maybeCode !== "EEXIST") {
        throw error;
      }
    }

    const existing = await inspectLockFile(lockPath);
    const existingPayload = existing?.payload ?? null;
    const lockAgeMs = existing?.mtimeMs != null ? Date.now() - existing.mtimeMs : staleMs + 1;
    const stale =
      !existing ||
      Number.isNaN(lockAgeMs) ||
      lockAgeMs > staleMs ||
      (existingPayload !== null && !isProcessRunning(existingPayload.pid));

    if (stale) {
      await removeLockFile(lockPath);
      continue;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Timed out waiting for embedded PostgreSQL bootstrap lock in ${input.dataDir}`,
      );
    }

    await sleep(pollIntervalMs);
  }
}
