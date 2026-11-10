import { and, asc, eq, gt, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../../services/delivery-work-notifications.js";
import type { LiveRunRecoveryScope } from "../../../services/live-run-recovery-notifications.js";
import { registerScopedDeadlineWork } from "../../../services/scoped-deadline-work.js";
import type { ScanSilentActiveRunsOptions } from "../application/use-cases.js";
import type { WatchdogRunReader } from "../application/ports.js";

type Entry = { id: string; companyId: string; issueId: string | null; dueAt: number };

export function registerActiveRunSilenceWork(db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: { reader: WatchdogRunReader; scan(input: ScanSilentActiveRunsOptions): Promise<unknown>;
    suspicionThresholdMs: number; enabled(): Promise<boolean> },
  canRun: () => boolean,
) {
  const cursors = new Map<string, string>();
  let enabled = false;
  return registerScopedDeadlineWork<Entry, LiveRunRecoveryScope>(coordinator, {
    queue: DELIVERY_QUEUES.activeRunSilence,
    reconstructionIntervalMs: 30_000,
    beforePass: async () => { enabled = await owner.enabled(); },
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint),
    matches: (entry, scope) => !scope || entry.companyId === scope.companyId && (!scope.runId || entry.id === scope.runId) && (!scope.issueId || entry.issueId === scope.issueId),
    load: async scope => {
      const key = scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId }) : "*";
      if (!enabled) { cursors.delete(key); return []; }
      const cursor = cursors.get(key);
      const issueId = sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`;
      const rows = await db.select({ issueId, id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
        lastActivity: sql<Date>`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.processStartedAt},
          ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`.mapWith(heartbeatRuns.createdAt),
      }).from(heartbeatRuns).where(and(eq(heartbeatRuns.status, "running"),
        scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
        scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
        scope?.issueId ? eq(issueId, scope.issueId) : undefined,
        cursor ? gt(heartbeatRuns.id, cursor) : undefined,
      )).orderBy(asc(heartbeatRuns.id)).limit(100);
      const complete = rows.length < 100;
      if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
      return { complete, rows: rows.map(row => ({ id: row.id, companyId: row.companyId, issueId: row.issueId,
        dueAt: row.lastActivity.getTime() + owner.suspicionThresholdMs })) };
    },
    check: async entry => {
      if (!enabled) return null;
      const run = await owner.reader.findRunForCompany(entry.companyId, entry.id);
      if (!run || run.status !== "running") return null;
      const started = run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt;
      if (!started) return null;
      const due = started.getTime() + owner.suspicionThresholdMs;
      if (due > Date.now()) return { ...entry, dueAt: due };
      const decision = await owner.reader.findLatestDecision(entry.companyId, entry.id, new Date());
      if (decision.quietUntilDecision) return { ...entry, dueAt: decision.quietUntilDecision.snoozedUntil.getTime() };
      let next: number | null = null;
      await owner.scan({ companyId: entry.companyId, runId: entry.id, onDeferredDeadline: at => {
        next = next === null ? at : Math.min(next, at);
      } });
      return next === null ? null : { ...entry, dueAt: next };
    },
  }, canRun);
}
