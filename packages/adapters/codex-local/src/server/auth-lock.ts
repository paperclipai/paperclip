import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Serializes Codex CLI auth-refresh windows so concurrent codex_local runs on
 * the same machine do not race on the single OAuth refresh token stored in
 * `~/.codex/auth.json`.
 *
 * The refresh-token grant rotates each access token: when two codex processes
 * race, one writes a fresh token pair and the other gets back
 * "Your access token could not be refreshed because your refresh token was
 * already used." That bubbles up as `adapter_failed` and strands the agent.
 *
 * We hold an exclusive file lock from just before spawn until the codex process
 * either emits its first stdout chunk (the JSONL stream starts only after auth
 * is past) or exits. The lock is paired with an in-process mutex so multiple
 * codex_local runs inside the same Node process serialize without filesystem
 * polling.
 */

const LOCK_FILENAME = ".paperclip-auth-refresh.lock";
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_HOLD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MIN_MS = 50;
const POLL_INTERVAL_MAX_MS = 500;

export type CodexAuthLockReleaseReason =
  | "first_output"
  | "completed"
  | "timeout"
  | "manual";

export type CodexAuthLockHandle = {
  release: (reason?: CodexAuthLockReleaseReason) => Promise<void>;
  released: () => boolean;
};

export type AcquireCodexAuthLockOptions = {
  /** Absolute path to the lock file. Defaults to a sibling of `auth.json`. */
  lockPath?: string;
  /** Lock files older than this are considered abandoned and reclaimed. */
  staleMs?: number;
  /** Auto-release after this many ms even if no one calls release(). */
  holdTimeoutMs?: number;
  /** Time source override for tests. */
  now?: () => number;
  /** Sleep override for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional log sink invoked when the lock is reclaimed or auto-released. */
  onLog?: (message: string) => void | Promise<void>;
  /** AbortSignal that cancels the acquire wait loop. */
  signal?: AbortSignal;
};

type LockFilePayload = {
  pid: number;
  hostname: string;
  startedAt: number;
  acquirer: string;
};

function defaultLockPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  const dir = codexHome && codexHome.length > 0 ? codexHome : path.join(os.homedir(), ".codex");
  return path.join(dir, LOCK_FILENAME);
}

export function resolveDefaultCodexAuthLockPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim();
  const dir = codexHome && codexHome.length > 0 ? codexHome : path.join(os.homedir(), ".codex");
  return path.join(dir, LOCK_FILENAME);
}

let inProcessQueue: Promise<void> = Promise.resolve();

function enqueueInProcess(): {
  wait: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = inProcessQueue;
  inProcessQueue = previous.then(() => next);
  return {
    wait: previous,
    release,
  };
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.acquirer !== "string"
    ) {
      return null;
    }
    return parsed as LockFilePayload;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the pid exists but we can't signal it — still alive.
    return code === "EPERM";
  }
}

function nextBackoff(current: number): number {
  return Math.min(POLL_INTERVAL_MAX_MS, Math.max(POLL_INTERVAL_MIN_MS, current * 2));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryClaimLockFile(
  lockPath: string,
  payload: LockFilePayload,
): Promise<boolean> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(payload));
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export async function acquireCodexAuthLock(
  options: AcquireCodexAuthLockOptions = {},
): Promise<CodexAuthLockHandle> {
  const lockPath = options.lockPath ?? defaultLockPath();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const holdTimeoutMs = options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const onLog = options.onLog ?? (() => undefined);
  const signal = options.signal;
  const acquirer = `codex_local:${process.pid}:${now()}`;
  const hostname = os.hostname();

  const inProcess = enqueueInProcess();
  await inProcess.wait;

  let backoff = POLL_INTERVAL_MIN_MS;

  const claim = async (): Promise<boolean> => {
    const payload: LockFilePayload = {
      pid: process.pid,
      hostname,
      startedAt: now(),
      acquirer,
    };
    return tryClaimLockFile(lockPath, payload);
  };

  while (true) {
    if (signal?.aborted) {
      inProcess.release();
      throw new Error("acquireCodexAuthLock aborted");
    }

    if (await claim()) break;

    const existing = await readLockPayload(lockPath);
    const age = existing ? now() - existing.startedAt : Number.POSITIVE_INFINITY;
    const ownerAlive = existing
      ? existing.hostname === hostname && pidIsAlive(existing.pid)
      : false;

    if (existing && (age > staleMs || (!ownerAlive && age > POLL_INTERVAL_MAX_MS))) {
      await onLog(
        `[paperclip] Reclaiming stale Codex auth lock (pid=${existing.pid}, age=${Math.round(age)}ms)`,
      );
      await fs.rm(lockPath, { force: true });
      backoff = POLL_INTERVAL_MIN_MS;
      continue;
    }

    await sleep(backoff);
    backoff = nextBackoff(backoff);
  }

  let released = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const releaseFile = async () => {
    try {
      await fs.rm(lockPath, { force: true });
    } catch {
      // best-effort
    }
  };

  const release = async (reason: CodexAuthLockReleaseReason = "manual"): Promise<void> => {
    if (released) return;
    released = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    try {
      await releaseFile();
    } finally {
      inProcess.release();
    }
    if (reason === "timeout") {
      await onLog(
        `[paperclip] Codex auth lock auto-released after ${holdTimeoutMs}ms hold timeout`,
      );
    }
  };

  if (holdTimeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      void release("timeout");
    }, holdTimeoutMs);
    if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
  }

  return {
    release,
    released: () => released,
  };
}

/**
 * Test helper: drains the in-process serialization queue so unit tests do not
 * leak ordering across cases.
 */
export async function __resetCodexAuthLockQueueForTests(): Promise<void> {
  await inProcessQueue;
  inProcessQueue = Promise.resolve();
}
