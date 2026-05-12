// Best-effort SIGTERM -> SIGKILL helper for the watchdog auto-recovery path.
//
// AUR-42 will own the production-grade helper (with detailed structured logs,
// pgid resolution helpers, and the `PAPERCLIP_WATCHDOG_AUTO_RECOVER` master
// switch). Until that lands, the retry-stall detector needs a small inline
// version so we can ship AUR-33 without waiting on the sibling. Behaviour:
//
//  1. Respect `PAPERCLIP_WATCHDOG_AUTO_RECOVER` (default true); when false,
//     return `{ skipped: "auto_recover_disabled" }` without sending signals.
//  2. `process.kill(-pgid, SIGTERM)` (or `pid` when pgid is unavailable).
//  3. Wait up to `graceMs` for the process group to exit.
//  4. If still alive, `process.kill(-pgid, SIGKILL)`.
//  5. Return a structured outcome the caller can log.

import { logger } from "../../middleware/logger.js";
import { getWatchdogConfig } from "./watchdog-config.js";

export type KillProcessGroupInput = {
  pid?: number | null;
  pgid?: number | null;
  graceMs?: number;
  runId?: string | null;
};

export type KillProcessGroupOutcome =
  | { ok: true; term: true; killed: boolean; gracedMs: number }
  | { ok: false; skipped: "auto_recover_disabled" | "process_not_found" | "no_pid"; }
  | { ok: false; error: string };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

async function waitForExit(pid: number, graceMs: number): Promise<{ killed: boolean; gracedMs: number }> {
  const start = Date.now();
  const pollIntervalMs = Math.max(25, Math.min(250, Math.floor(graceMs / 20) || 50));
  while (Date.now() - start < graceMs) {
    if (!processAlive(pid)) {
      return { killed: false, gracedMs: Date.now() - start };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { killed: true, gracedMs: Date.now() - start };
}

export async function killProcessGroup(input: KillProcessGroupInput): Promise<KillProcessGroupOutcome> {
  const config = getWatchdogConfig();
  if (!config.autoRecover) {
    logger.info(
      { runId: input.runId ?? null, pid: input.pid ?? null, pgid: input.pgid ?? null, action: "kill", outcome: "skipped_auto_recover_disabled" },
      "watchdog killProcessGroup skipped: PAPERCLIP_WATCHDOG_AUTO_RECOVER=false",
    );
    return { ok: false, skipped: "auto_recover_disabled" };
  }
  const graceMs = input.graceMs ?? config.killGraceMs;
  const pid = input.pid ?? null;
  const pgid = input.pgid ?? null;
  const target = pgid ?? pid;
  if (target === null) {
    return { ok: false, skipped: "no_pid" };
  }
  // process.kill(-pgid) sends to the whole group; positive id sends to one pid.
  const killTarget = pgid !== null ? -pgid : pid!;
  const checkPid = pid ?? pgid!;
  if (!processAlive(checkPid)) {
    return { ok: false, skipped: "process_not_found" };
  }
  try {
    process.kill(killTarget, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") {
      return { ok: false, skipped: "process_not_found" };
    }
    logger.warn({ err, runId: input.runId ?? null, pid, pgid, signal: "SIGTERM" }, "watchdog killProcessGroup SIGTERM failed");
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const { killed, gracedMs } = await waitForExit(checkPid, graceMs);
  if (killed) {
    try {
      process.kill(killTarget, "SIGKILL");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ESRCH") {
        logger.warn({ err, runId: input.runId ?? null, pid, pgid, signal: "SIGKILL" }, "watchdog killProcessGroup SIGKILL failed");
      }
    }
  }
  logger.info(
    { runId: input.runId ?? null, pid, pgid, action: "kill", outcome: killed ? "killed" : "terminated", gracedMs },
    "watchdog killProcessGroup signalled",
  );
  return { ok: true, term: true, killed, gracedMs };
}
