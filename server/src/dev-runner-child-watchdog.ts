import { execFile } from "node:child_process";

/**
 * Keeps a captured child process from stalling the dev runner silently.
 *
 * The pre-boot migration status check runs with piped stdio, so from the
 * operator's seat a stalled child and a slow child look identical: nothing is
 * printed until it exits. This emits periodic notices while the child is still
 * running and fires `onTimeout` once a hard deadline passes, so the caller can
 * terminate the child and report what it was doing instead of waiting forever.
 */
export type ChildWatchdogOptions = {
  /** What is being waited on, e.g. `migration status check`. */
  label: string;
  /** The command line, printed so the operator can run it by hand. */
  command: string;
  /** Delay before the first "still running" notice. */
  warnAfterMs?: number;
  /** Cadence of further notices. */
  noticeIntervalMs?: number;
  /** Hard deadline; `onTimeout` fires once when it passes. */
  timeoutMs?: number;
  write?: (line: string) => void;
  now?: () => number;
};

export type ChildWatchdog = {
  /** Stop all timers. Safe to call more than once. */
  dispose(): void;
  /** Whether the deadline passed before `dispose` was called. */
  readonly timedOut: boolean;
  elapsedMs(): number;
};

export const DEFAULT_CHILD_WATCHDOG_WARN_AFTER_MS = 15_000;
export const DEFAULT_CHILD_WATCHDOG_NOTICE_INTERVAL_MS = 30_000;
/**
 * Generous on purpose: every wait inside the migration status check already
 * carries its own, shorter budget and reports its own error. This only has to
 * catch a stall none of those can see, and must outlast the child's own
 * watchdog (4 minutes) so that its diagnosis, not this one, is what prints.
 */
export const DEFAULT_CHILD_WATCHDOG_TIMEOUT_MS = 300_000;

export function resolveChildWatchdogTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_CHILD_WATCHDOG_TIMEOUT_MS,
): number {
  const raw = env.PAPERCLIP_DEV_PREFLIGHT_TIMEOUT_MS?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createChildWatchdog(
  options: ChildWatchdogOptions,
  onTimeout: (info: { elapsedMs: number }) => void,
): ChildWatchdog {
  const warnAfterMs = options.warnAfterMs ?? DEFAULT_CHILD_WATCHDOG_WARN_AFTER_MS;
  const noticeIntervalMs = options.noticeIntervalMs ?? DEFAULT_CHILD_WATCHDOG_NOTICE_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_WATCHDOG_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const startedAt = now();

  let disposed = false;
  let timedOut = false;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const elapsedMs = () => now() - startedAt;
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

  const scheduleNotice = (delayMs: number) => {
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      if (disposed || timedOut) return;
      write(
        `[paperclip] ${options.label} still running after ${seconds(elapsedMs())} ` +
          `(will give up at ${seconds(timeoutMs)}). Command: ${options.command}`,
      );
      scheduleNotice(noticeIntervalMs);
    }, delayMs);
  };

  if (warnAfterMs < timeoutMs) scheduleNotice(warnAfterMs);
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    if (disposed) return;
    timedOut = true;
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    onTimeout({ elapsedMs: elapsedMs() });
  }, timeoutMs);

  return {
    get timedOut() {
      return timedOut;
    },
    elapsedMs,
    dispose() {
      disposed = true;
      if (noticeTimer) clearTimeout(noticeTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      noticeTimer = null;
      deadlineTimer = null;
    },
  };
}

/**
 * Terminate a child and everything it spawned.
 *
 * On Windows the dev runner launches commands through a shell, so `child.pid`
 * is cmd.exe and a plain `kill()` would orphan pnpm, tsx, node and any
 * postmaster beneath it; `taskkill /t` walks the tree. Elsewhere the child is
 * signalled directly and escalated to SIGKILL if it ignores SIGTERM.
 */
export async function terminateChildProcessTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean; exitCode: number | null; signalCode: NodeJS.Signals | null },
  options: { platform?: NodeJS.Platform; killAfterMs?: number } = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    if (!child.pid) return;
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => resolve());
    });
    return;
  }

  child.kill("SIGTERM");
  const killAfterMs = options.killAfterMs ?? 5_000;
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, killAfterMs);
  });
}
