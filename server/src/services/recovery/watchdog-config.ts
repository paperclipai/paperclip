// Watchdog runtime configuration. All values are read from environment
// variables so we can revert behaviour without redeploying.
//
// Master kill switch: PAPERCLIP_WATCHDOG_API_RETRY_AWARE (default true).
// When false, the parser stops updating `lastLivenessAt`, the retry-stall
// detector becomes a no-op, and the hard cascade guard short-circuits to the
// pre-change behaviour. Used as the rollback lever for AUR-33.

export const DEFAULT_RETRY_STALL_ATTEMPT_THRESHOLD = 3;
export const DEFAULT_RETRY_STALL_BUDGET_SEC = 300;
export const DEFAULT_KILL_GRACE_MS = 10_000;

export type WatchdogConfig = {
  apiRetryAware: boolean;
  autoRecover: boolean;
  retryStallAttemptThreshold: number;
  retryStallBudgetSec: number;
  killGraceMs: number;
};

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function envInt(name: string, fallback: number, opts?: { min?: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (opts?.min !== undefined && floored < opts.min) return opts.min;
  return floored;
}

export function getWatchdogConfig(): WatchdogConfig {
  return {
    apiRetryAware: envBool("PAPERCLIP_WATCHDOG_API_RETRY_AWARE", true),
    autoRecover: envBool("PAPERCLIP_WATCHDOG_AUTO_RECOVER", true),
    retryStallAttemptThreshold: envInt(
      "PAPERCLIP_WATCHDOG_RETRY_STALL_ATTEMPT",
      DEFAULT_RETRY_STALL_ATTEMPT_THRESHOLD,
      { min: 1 },
    ),
    retryStallBudgetSec: envInt(
      "PAPERCLIP_WATCHDOG_RETRY_STALL_BUDGET_SEC",
      DEFAULT_RETRY_STALL_BUDGET_SEC,
      { min: 1 },
    ),
    killGraceMs: envInt(
      "PAPERCLIP_WATCHDOG_KILL_GRACE_MS",
      DEFAULT_KILL_GRACE_MS,
      { min: 0 },
    ),
  };
}
