/**
 * Phase 4A-S4 B2 (LET-367): 5-minute poller for the billing-cap monitor.
 *
 * Wired from `app.ts` at boot. The scheduler holds a list of companies it
 * should poll for; when no companies are registered the timer is a no-op so
 * non-pilot deployments incur zero overhead.
 *
 * Constraint (S3 AC §Constraints): the monitor must not itself issue any
 * billable call. The interval-based timer just calls `monitor.tick(...)`,
 * which performs read-only DB work and (optionally) one read-only vendor API
 * call. No billable lease is created.
 */

import type { Logger } from "pino";
import type { BillingCapMonitor } from "./monitor.js";

export const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;

export interface BillingCapSchedulerDeps {
  monitor: BillingCapMonitor;
  /** Companies to poll on every tick; mutable so tests can register/remove. */
  resolveCompanyIds: () => Promise<string[]>;
  logger: Pick<Logger, "info" | "warn" | "error">;
  intervalMs?: number;
}

export interface BillingCapScheduler {
  start(): void;
  stop(): void;
  /** Run a single tick across all registered companies. */
  runOnce(now?: Date): Promise<void>;
}

export function createBillingCapScheduler(deps: BillingCapSchedulerDeps): BillingCapScheduler {
  let timer: NodeJS.Timeout | null = null;
  const intervalMs = deps.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  let running = false;

  const tick = async () => {
    if (running) return; // overlapping ticks are a smell — drop instead.
    running = true;
    try {
      await runOnce();
    } finally {
      running = false;
    }
  };

  const runOnce = async (now?: Date) => {
    let companyIds: string[];
    try {
      companyIds = await deps.resolveCompanyIds();
    } catch (err) {
      deps.logger.error({ err }, "billing cap scheduler failed to resolve company ids");
      return;
    }
    for (const companyId of companyIds) {
      try {
        await deps.monitor.tick({ companyId, now });
      } catch (err) {
        deps.logger.error(
          { err, companyId },
          "billing cap monitor tick failed",
        );
      }
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}
