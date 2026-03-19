import type { Db } from "@paperclipai/db";
import { count, eq, gt, sql } from "drizzle-orm";
import { agents, costEvents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export function startUsageReporter(
  db: Db,
  opts: { url: string; instanceId: string; secret: string; intervalMs?: number },
) {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let lastReportedAt = new Date(0);

  const report = async () => {
    const periodStart = lastReportedAt;
    const periodEnd = new Date();
    try {
      const [agentCount, runCount, tokenUsage] = await Promise.all([
        db.select({ count: count() }).from(agents).where(eq(agents.status, "active")).then((r) => Number(r[0]?.count ?? 0)),
        db.select({ count: count() }).from(heartbeatRuns).where(eq(heartbeatRuns.status, "running")).then((r) => Number(r[0]?.count ?? 0)),
        db.select({ total: sql<number>`coalesce(sum(${costEvents.inputTokens}) + sum(${costEvents.outputTokens}), 0)` })
          .from(costEvents).where(gt(costEvents.occurredAt, periodStart)).then((r) => Number(r[0]?.total ?? 0)),
      ]);
      const res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-paperclip-instance-id": opts.instanceId, "x-paperclip-management-secret": opts.secret },
        body: JSON.stringify({ instanceId: opts.instanceId, activeAgents: agentCount, runningRuns: runCount, periodTokens: tokenUsage, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) logger.warn({ status: res.status }, "Usage report endpoint returned non-OK status");
      else lastReportedAt = periodEnd;
    } catch (err) {
      logger.warn({ err }, "Usage report failed");
    }
  };

  const timer = setInterval(() => void report(), intervalMs);
  void report();
  return { stop: () => clearInterval(timer) };
}
