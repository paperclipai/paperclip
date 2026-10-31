import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../delivery-work-notifications.js";
import type { LiveResourceRecoveryScope, LiveRunRecoveryScope } from "../live-run-recovery-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";

const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
type Scope = LiveRunRecoveryScope & LiveResourceRecoveryScope;
type Entry = { id: string; companyId: string; runId?: string | null; dueAt: number };
type CheckScope = { companyId: string; runId?: string; leaseId?: string; agentId?: string;
  onDeferredDeadline(at: number): void; onError(error: unknown): void };
type RunKind = "native" | "question" | "active" | "settled";

export function registerLiveRecoveryWork(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, owner: {
  native(scope: CheckScope): Promise<unknown>;
  question(scope: CheckScope): Promise<unknown>;
  active(scope: CheckScope): Promise<unknown>;
  settled(scope: CheckScope): Promise<unknown>;
  orphanLease(scope: CheckScope): Promise<unknown>;
  shutdown(scope: CheckScope): Promise<unknown>;
  agent(scope: CheckScope): Promise<unknown>;
  enabled(): Promise<boolean>;
}, canRun: () => boolean) {
  function register(queue: DeliveryQueue, kind: RunKind | "orphanLease" | "shutdown" | "agent") {
    const cursors = new Map<string, string>();
    let enabled = false;
    async function load(scope?: Scope) {
        const key = scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId,
          leaseId: scope.leaseId, agentId: scope.agentId }) : "*";
        if (!enabled) { cursors.delete(key); return []; }
        const cursor = cursors.get(key);
        let rows: Entry[];
        if (kind === "agent") {
          const candidates = await db.select({ id: agents.id, companyId: agents.companyId, updatedAt: agents.updatedAt })
            .from(agents).where(and(eq(agents.status, "running"), eq(agents.lifecycleState, "ready"),
              scope ? eq(agents.companyId, scope.companyId) : undefined,
              scope?.agentId ? eq(agents.id, scope.agentId) : undefined,
              cursor ? gt(agents.id, cursor) : undefined,
            )).orderBy(asc(agents.id)).limit(100);
          rows = candidates.map(row => ({ id: row.id, companyId: row.companyId, dueAt: row.updatedAt.getTime() + 5 * 60_000 }));
        } else if (kind === "orphanLease" || kind === "shutdown") {
          const candidates = await db.select({ id: environmentLeases.id, companyId: environmentLeases.companyId,
            runId: environmentLeases.heartbeatRunId, updatedAt: environmentLeases.updatedAt, metadata: environmentLeases.metadata }).from(environmentLeases)
            .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
              eq(heartbeatRuns.companyId, environmentLeases.companyId)))
            .where(and(scope ? eq(environmentLeases.companyId, scope.companyId) : undefined,
              scope?.leaseId ? eq(environmentLeases.id, scope.leaseId) : undefined,
              scope?.runId ? eq(environmentLeases.heartbeatRunId, scope.runId) : undefined,
              cursor ? gt(environmentLeases.id, cursor) : undefined,
              kind === "orphanLease" ? and(eq(environmentLeases.status, "active"),
                or(isNull(environmentLeases.heartbeatRunId), inArray(heartbeatRuns.status, TERMINAL)))
                : sql`${environmentLeases.metadata}#>>'{legacyShutdownWorkspaceSettlement,schema}' = 'paperclip.legacy-shutdown-workspace-settlement.v1'
                  and ${environmentLeases.metadata}#>>'{legacyShutdownWorkspaceSettlement,state}' = 'pending'`,
            )).orderBy(asc(environmentLeases.id)).limit(100);
          rows = candidates.map(row => ({ id: row.id, companyId: row.companyId, runId: row.runId,
            dueAt: kind === "orphanLease" ? row.updatedAt.getTime() + 5 * 60_000
              : Date.parse(String((row.metadata?.legacyShutdownWorkspaceSettlement as Record<string, unknown>)?.deadlineAt)) || Date.now(),
          }));
        } else {
          const candidates = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
            nextAttemptAt: nativeRunFinalizations.nextAttemptAt, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt })
            .from(heartbeatRuns).leftJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
              eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId)))
            .where(and(scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
              scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
              cursor ? gt(heartbeatRuns.id, cursor) : undefined,
              kind === "native" ? and(eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.status, ["running", "failed"]),
                eq(nativeRunFinalizations.phase, "retryable_failure"), isNull(nativeRunFinalizations.resultId),
                sql`${heartbeatRuns.contextSnapshot}->'nativeQuestionCancellation' is null`)
                : kind === "question" ? and(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
                  sql`${heartbeatRuns.contextSnapshot}->'nativeQuestionCancellation' is not null`)
                  : kind === "active" ? and(eq(heartbeatRuns.status, "running"),
                    sql`${heartbeatRuns.contextSnapshot}->'nativeQuestionCancellation' is null`)
                    : and(eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.status, ["failed", "cancelled", "timed_out", "interrupted"]),
                      isNotNull(heartbeatRuns.finishedAt), or(isNotNull(heartbeatRuns.processPid),
                        isNotNull(heartbeatRuns.processGroupId), isNotNull(heartbeatRuns.processStartedAt))),
            )).orderBy(asc(heartbeatRuns.id)).limit(100);
          rows = candidates.map(row => ({ id: row.id, companyId: row.companyId, dueAt: kind === "native"
            ? Math.max(Date.now(), row.nextAttemptAt?.getTime() ?? 0, row.leaseExpiresAt?.getTime() ?? 0) : Date.now() }));
        }
        const complete = rows.length < 100;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        return { complete, rows };
    }
    return registerScopedDeadlineWork<Entry, Scope>(coordinator, {
      queue,
      reconstructionIntervalMs: 30_000,
      beforePass: async () => { enabled = await owner.enabled(); },
      decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry, scope) => !scope || entry.companyId === scope.companyId && (
        kind === "agent" ? !scope.agentId || entry.id === scope.agentId
          : kind === "orphanLease" || kind === "shutdown" ? (!scope.leaseId || entry.id === scope.leaseId) && (!scope.runId || entry.runId === scope.runId)
            : !scope.runId || entry.id === scope.runId),
      load,
      check: async entry => {
        if (!enabled) return null;
        const currentScope = { companyId: entry.companyId,
          ...(kind === "agent" ? { agentId: entry.id } : kind === "orphanLease" || kind === "shutdown"
            ? { leaseId: entry.id } : { runId: entry.id }) };
        const loaded = await load(currentScope);
        const current = (Array.isArray(loaded) ? loaded : loaded.rows).find(row => row.id === entry.id);
        if (!current) return null;
        if (current.dueAt > Date.now()) return current;
        let next: number | null = null;
        const errors: unknown[] = [];
        const scope: CheckScope = { companyId: entry.companyId,
          ...(kind === "agent" ? { agentId: entry.id } : kind === "orphanLease" || kind === "shutdown"
            ? { leaseId: entry.id } : { runId: entry.id }),
          onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); },
          onError: error => { errors.push(error); },
        };
        await owner[kind](scope);
        if (errors.length) throw new AggregateError(errors, `Recovery obligation ${entry.id} failed`);
        if (kind === "native") {
          const refreshed = await load(currentScope);
          const remaining = (Array.isArray(refreshed) ? refreshed : refreshed.rows).find(row => row.id === entry.id);
          if (remaining && remaining.dueAt > Date.now()) next = next === null ? remaining.dueAt : Math.min(next, remaining.dueAt);
        }
        return next === null ? null : { ...entry, dueAt: next };
      },
    }, canRun);
  }
  const workers = [register(DELIVERY_QUEUES.nativeProcessSessions, "native"),
    register(DELIVERY_QUEUES.nativeQuestionCancellations, "question"),
    register(DELIVERY_QUEUES.activeExecutionRecovery, "active"),
    register(DELIVERY_QUEUES.settledNativeProcesses, "settled"),
    register(DELIVERY_QUEUES.orphanActiveLeases, "orphanLease"),
    register(DELIVERY_QUEUES.legacyShutdownSettlement, "shutdown"),
    register(DELIVERY_QUEUES.strandedAgentStatus, "agent")];
  return { ready: Promise.all(workers.map(worker => worker.ready)),
    wake() { for (const worker of workers) worker.invalidate(); },
    async stop() { await Promise.all(workers.map(worker => worker.stop())); } };
}
