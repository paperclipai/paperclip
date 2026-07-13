import type { Db } from "@paperclipai/db";
import { seoDocRegistryEntries } from "@paperclipai/db";
import type { SeoDocAuditResult } from "./seo-doc-governance.js";
import { seoDocGovernanceService } from "./seo-doc-governance.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;

export function createSeoDocGovernanceScheduler(opts: {
  db: Db;
  intervalMs?: number;
  now?: () => Date;
  enqueueWakeup?: NonNullable<Parameters<typeof seoDocGovernanceService>[1]>["enqueueWakeup"];
}): {
  start(): void;
  stop(): void;
  runOnce(now?: Date): Promise<SeoDocAuditResult>;
} {
  const governance = seoDocGovernanceService(opts.db, { enqueueWakeup: opts.enqueueWakeup });
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const nowFn = opts.now ?? (() => new Date());
  const log = logger.child({ service: "seo-doc-governance-scheduler" });

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const runOnce = async (auditNow?: Date): Promise<SeoDocAuditResult> => {
    const now = auditNow ?? nowFn();
    const companyRows = await opts.db
      .select({ companyId: seoDocRegistryEntries.companyId })
      .from(seoDocRegistryEntries)
      .groupBy(seoDocRegistryEntries.companyId);

    const aggregate: SeoDocAuditResult = {
      scanned: 0,
      staleDocKeys: [],
      escalatedDocKeys: [],
      violations: [],
    };

    for (const row of companyRows) {
      const result = await governance.auditCompany(row.companyId, now);
      aggregate.scanned += result.scanned;
      aggregate.staleDocKeys.push(...result.staleDocKeys);
      aggregate.escalatedDocKeys.push(...result.escalatedDocKeys);
      aggregate.violations.push(...result.violations);
    }

    return aggregate;
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (error) {
      log.warn({ err: error }, "seo governance scheduler run failed");
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      timer.unref?.();
      void tick();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    async runOnce(now?: Date) {
      return runOnce(now);
    },
  };
}
