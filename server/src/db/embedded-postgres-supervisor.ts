// Supervisor for the embedded-postgres lifecycle. Same code path on macOS
// and Linux; the acute symptom we ship for is the macOS-ENOSPC class from
// TRA-242 / TRA-244 (paperclipai/paperclip), but the throttle/window/backoff
// guards apply to every embedded-postgres deployment.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export const SUPERVISOR_THROTTLE_MS = 30_000;
export const SUPERVISOR_WINDOW_MS = 5 * 60_000;
export const SUPERVISOR_MAX_ATTEMPTS_PER_WINDOW = 3;
export const SUPERVISOR_BACKOFF_MS: ReadonlyArray<number> = [5_000, 15_000, 45_000];
export const SUPERVISOR_AUTO_RESET_MS = 30 * 60_000;

export type SupervisorTriggerReason = "health" | "probe" | "pool" | "manual";
export type SupervisorState = "idle" | "attempting" | "gave_up";

export type SupervisorLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type SupervisorPostgresHandle = {
  start(): Promise<void>;
  stop?(): Promise<void>;
};

export type SupervisorClock = () => number;

export type TimerHandle = { cleared: boolean };

export type SupervisorTimer = {
  schedule(delayMs: number, fn: () => void): TimerHandle;
  clear(handle: TimerHandle): void;
};

const defaultTimer: SupervisorTimer = {
  schedule(delayMs, fn) {
    const t = setTimeout(fn, delayMs);
    if (typeof t.unref === "function") t.unref();
    const handle: TimerHandle & { _t: NodeJS.Timeout } = { cleared: false, _t: t };
    return handle;
  },
  clear(handle) {
    const t = (handle as TimerHandle & { _t?: NodeJS.Timeout })._t;
    if (t) clearTimeout(t);
    handle.cleared = true;
  },
};

export type EmbeddedPostgresSupervisorDeps = {
  embeddedPostgres: SupervisorPostgresHandle;
  dataDir: string;
  port: number;
  logger: SupervisorLogger;
  now?: SupervisorClock;
  timer?: SupervisorTimer;
  isProcessAlive?: (pid: number) => boolean;
  readPidFile?: (path: string) => string | null;
  removePidFile?: (path: string) => void;
};

export type EmbeddedPostgresSupervisor = {
  recoverIfUnhealthy(reason: SupervisorTriggerReason): Promise<void>;
  resetGaveUp(reason?: string): void;
  state(): SupervisorState;
  shutdown(): void;
};

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultReadPidFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultRemovePidFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* swallow */
  }
}

function parsePid(contents: string | null): number | null {
  if (contents === null) return null;
  const firstLine = contents.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return null;
  const pid = Number(firstLine);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

type Attempt = { startedAt: number; succeeded: boolean };

export function createEmbeddedPostgresSupervisor(
  deps: EmbeddedPostgresSupervisorDeps,
): EmbeddedPostgresSupervisor {
  const now = deps.now ?? Date.now;
  const timer = deps.timer ?? defaultTimer;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const readPidFile = deps.readPidFile ?? defaultReadPidFile;
  const removePidFile = deps.removePidFile ?? defaultRemovePidFile;
  const pidFilePath = resolvePath(deps.dataDir, "postmaster.pid");

  let state: SupervisorState = "idle";
  let attempts: Attempt[] = [];
  let lastAttemptAt = 0;
  let autoResetHandle: TimerHandle | null = null;
  let inFlight = false;

  function pruneWindow(nowMs: number): void {
    const cutoff = nowMs - SUPERVISOR_WINDOW_MS;
    attempts = attempts.filter((a) => a.startedAt >= cutoff);
  }

  function failedAttemptsInWindow(nowMs: number): number {
    pruneWindow(nowMs);
    return attempts.filter((a) => !a.succeeded).length;
  }

  function scheduleAutoReset(): void {
    if (autoResetHandle && !autoResetHandle.cleared) timer.clear(autoResetHandle);
    autoResetHandle = timer.schedule(SUPERVISOR_AUTO_RESET_MS, () => {
      autoResetHandle = null;
      if (state === "gave_up") {
        deps.logger.warn(
          { dataDir: deps.dataDir, port: deps.port },
          "postgres_supervisor_giveup_reset",
        );
        state = "idle";
        attempts = [];
        lastAttemptAt = 0;
      }
    });
  }

  function clearAutoReset(): void {
    if (autoResetHandle && !autoResetHandle.cleared) timer.clear(autoResetHandle);
    autoResetHandle = null;
  }

  function getRunningPid(): number | null {
    const pid = parsePid(readPidFile(pidFilePath));
    if (pid === null) return null;
    if (!isProcessAlive(pid)) return null;
    return pid;
  }

  async function performRestart(reason: SupervisorTriggerReason, attemptIndex: number): Promise<void> {
    const pid = getRunningPid();
    deps.logger.info(
      { reason, attempt: attemptIndex + 1, dataDir: deps.dataDir, port: deps.port, runningPid: pid },
      "postgres_restart_attempt",
    );

    if (pid !== null) {
      if (deps.embeddedPostgres.stop) {
        try {
          await deps.embeddedPostgres.stop();
        } catch (err) {
          deps.logger.warn(
            { reason, attempt: attemptIndex + 1, err, dataDir: deps.dataDir },
            "postgres_stop_failed_before_restart",
          );
        }
      }
    }

    removePidFile(pidFilePath);
    await deps.embeddedPostgres.start();
  }

  async function attemptRestart(reason: SupervisorTriggerReason): Promise<void> {
    const nowMs = now();
    const failedSoFar = failedAttemptsInWindow(nowMs);

    if (failedSoFar >= SUPERVISOR_MAX_ATTEMPTS_PER_WINDOW) {
      if (state !== "gave_up") {
        state = "gave_up";
        deps.logger.error(
          {
            reason,
            failedAttempts: failedSoFar,
            windowMs: SUPERVISOR_WINDOW_MS,
            dataDir: deps.dataDir,
            port: deps.port,
          },
          "postgres_restart_giveup",
        );
        scheduleAutoReset();
      }
      return;
    }

    const backoffMs = SUPERVISOR_BACKOFF_MS[Math.min(failedSoFar, SUPERVISOR_BACKOFF_MS.length - 1)] ?? 0;
    const requiredGapMs = Math.max(SUPERVISOR_THROTTLE_MS, backoffMs);
    if (lastAttemptAt !== 0 && nowMs - lastAttemptAt < requiredGapMs) {
      deps.logger.warn(
        {
          reason,
          sinceLastMs: nowMs - lastAttemptAt,
          throttleMs: SUPERVISOR_THROTTLE_MS,
          backoffMs,
          requiredGapMs,
        },
        "postgres_restart_throttled",
      );
      return;
    }

    state = "attempting";
    lastAttemptAt = now();
    const attempt: Attempt = { startedAt: lastAttemptAt, succeeded: false };
    attempts.push(attempt);

    try {
      await performRestart(reason, failedSoFar);
      attempt.succeeded = true;
      state = "idle";
      deps.logger.info(
        { reason, attempt: failedSoFar + 1, dataDir: deps.dataDir, port: deps.port },
        "postgres_restart_success",
      );
    } catch (err) {
      state = "idle";
      deps.logger.error(
        { reason, attempt: failedSoFar + 1, err, dataDir: deps.dataDir, port: deps.port },
        "postgres_restart_failed",
      );
      const failedAfter = failedAttemptsInWindow(now());
      if (failedAfter >= SUPERVISOR_MAX_ATTEMPTS_PER_WINDOW) {
        state = "gave_up";
        deps.logger.error(
          {
            reason,
            failedAttempts: failedAfter,
            windowMs: SUPERVISOR_WINDOW_MS,
            dataDir: deps.dataDir,
            port: deps.port,
          },
          "postgres_restart_giveup",
        );
        scheduleAutoReset();
      }
    }
  }

  return {
    async recoverIfUnhealthy(reason) {
      if (inFlight) return;
      inFlight = true;
      try {
        await attemptRestart(reason);
      } finally {
        inFlight = false;
      }
    },
    resetGaveUp(reason) {
      clearAutoReset();
      if (state === "gave_up" || attempts.length > 0) {
        deps.logger.info(
          { reason: reason ?? "manual", dataDir: deps.dataDir, port: deps.port },
          "postgres_supervisor_reset",
        );
      }
      state = "idle";
      attempts = [];
      lastAttemptAt = 0;
    },
    state() {
      return state;
    },
    shutdown() {
      clearAutoReset();
    },
  };
}
