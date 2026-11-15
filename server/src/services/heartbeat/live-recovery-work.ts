import { pendingFailedNativeRetryCancellationCondition } from "../native-runtime/native-cancellation-request.js";
import { legacyWorkspaceRecoveryNotMigrated } from "../legacy-workspace-recovery-migration.js";
import { settledNativeProcessCandidates } from "../native-local-process-stop.js";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../delivery-work-notifications.js";
import type { LiveResourceRecoveryScope, LiveRunRecoveryScope } from "../live-run-recovery-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";

const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const SETTLED_PENDING_BASE_DELAY_MS = 30_000;
const SETTLED_PENDING_MAX_DELAY_MS = 15 * 60_000;
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
    const settledOutcomes = new Map<string, { companyId: string; parked: boolean; attempts: number; notBefore: number }>();
    const settledScans = new Map<string, Set<string>>();
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
            dueAt: kind === "orphanLease"
              // A run lease is judged by its holder proof, not by age. A run-less
              // (login/probe) lease keeps its idle backoff until its kind moves.
              ? row.runId ? row.updatedAt.getTime() : row.updatedAt.getTime() + 5 * 60_000
              : Date.parse(String((row.metadata?.legacyShutdownWorkspaceSettlement as Record<string, unknown>)?.deadlineAt)) || Date.now(),
          }));
        } else if (kind === "settled") {
          const page = await loadSettled(scope, cursor);
          if (page.complete) cursors.delete(key); else cursors.set(key, page.rows.at(-1)!.id);
          return { complete: page.complete, rows: applySettledOutcomes(key, scope, page.rows, page.complete) };
        } else {
          const candidates = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
            nextAttemptAt: nativeRunFinalizations.nextAttemptAt, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt })
            .from(heartbeatRuns).leftJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
              eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId)))
            .where(and(scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
              scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
              cursor ? gt(heartbeatRuns.id, cursor) : undefined,
              kind === "native" ? and(eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.status, ["running", "failed"]),
                legacyWorkspaceRecoveryNotMigrated(),
                eq(nativeRunFinalizations.phase, "retryable_failure"), isNull(nativeRunFinalizations.resultId),
                sql`${heartbeatRuns.contextSnapshot}->'nativeQuestionCancellation' is null`)
                : kind === "question" ? and(or(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
                    pendingFailedNativeRetryCancellationCondition()),
                  sql`${heartbeatRuns.contextSnapshot}->'nativeQuestionCancellation' is not null`)
                  : and(eq(heartbeatRuns.status, "running"),
                    sql`${heartbeatRuns.contextSnapshot}->'nativeQuestionCancellation' is null`),
            )).orderBy(asc(heartbeatRuns.id)).limit(100);
          rows = candidates.map(row => ({ id: row.id, companyId: row.companyId, dueAt: kind === "native"
            ? Math.max(Date.now(), row.nextAttemptAt?.getTime() ?? 0, row.leaseExpiresAt?.getTime() ?? 0) : Date.now() }));
        }
        const complete = rows.length < 100;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        return { complete, rows };
    }
    async function loadSettled(scope: Scope | undefined, cursor: string | undefined) {
      const bounds = and(scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
        scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined, cursor ? gt(heartbeatRuns.id, cursor) : undefined);
      const select = (condition: ReturnType<typeof and>) => db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId })
        .from(heartbeatRuns).where(and(bounds, condition)).orderBy(asc(heartbeatRuns.id)).limit(100);
      const processes = await settledNativeProcessCandidates(db, { companyId: scope?.companyId, runId: scope?.runId,
        after: cursor, limit: 100 });
      const stops = await select(and(eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.driverKind, "cursor_cloud_api"),
        sql`(${heartbeatRuns.resultJson}->'executionCancellation'->>'state') = 'requested'`,
        eq(heartbeatRuns.runtimeMode, "native"), isNotNull(heartbeatRuns.finishedAt),
        sql`${heartbeatRuns.runnerProfileJson}->>'backend' = 'cursor_cloud_api'`));
      const merged = [...new Map([...processes, ...stops].map(row => [row.id, row])).values()]
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const complete = processes.length < 100 && stops.length < 100 && merged.length <= 100;
      return { complete, rows: merged.slice(0, 100).map(row => ({ ...row, dueAt: Date.now() })) };
    }
    function applySettledOutcomes(key: string, scope: Scope | undefined, rows: Entry[], complete: boolean) {
      if (scope?.runId) settledOutcomes.delete(scope.runId);
      const seen = settledScans.get(key) ?? new Set<string>();
      for (const row of rows) seen.add(row.id);
      if (!complete) settledScans.set(key, seen);
      else {
        settledScans.delete(key);
        if (!scope?.runId) for (const [id, outcome] of settledOutcomes)
          if ((!scope || outcome.companyId === scope.companyId) && !seen.has(id)) settledOutcomes.delete(id);
      }
      return rows.flatMap(row => {
        const outcome = settledOutcomes.get(row.id);
        if (outcome?.parked) return [];
        return [{ ...row, dueAt: Math.max(row.dueAt, outcome?.notBefore ?? 0) }];
      });
    }
    function recordSettledOutcome(entry: Entry, outcome: unknown): Entry | null | undefined {
      if (outcome === "released") { settledOutcomes.delete(entry.id); return null; }
      if (outcome === "skipped") {
        settledOutcomes.set(entry.id, { companyId: entry.companyId, parked: true, attempts: 0, notBefore: 0 });
        return null;
      }
      if (outcome !== "pending") return undefined;
      const attempts = (settledOutcomes.get(entry.id)?.attempts ?? 0) + 1;
      const notBefore = Date.now() + Math.min(SETTLED_PENDING_MAX_DELAY_MS, SETTLED_PENDING_BASE_DELAY_MS * 2 ** (attempts - 1));
      settledOutcomes.set(entry.id, { companyId: entry.companyId, parked: false, attempts, notBefore });
      return { ...entry, dueAt: notBefore };
    }
    return registerScopedDeadlineWork<Entry, Scope>(coordinator, {
      queue,
      reconstructionIntervalMs: 30_000,
      beforePass: async () => { enabled = await owner.enabled(); },
      decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint),
      // `matches` below never matches a scope of another company.
      scopeKey: { entry: entry => entry.companyId, scope: scope => scope.companyId },
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
        if (kind !== "settled") {
          const loaded = await load(currentScope);
          const current = (Array.isArray(loaded) ? loaded : loaded.rows).find(row => row.id === entry.id);
          if (!current) return null;
          if (current.dueAt > Date.now()) return current;
        }
        let next: number | null = null;
        const errors: unknown[] = [];
        const scope: CheckScope = { companyId: entry.companyId,
          ...(kind === "agent" ? { agentId: entry.id } : kind === "orphanLease" || kind === "shutdown"
            ? { leaseId: entry.id } : { runId: entry.id }),
          onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); },
          onError: error => { errors.push(error); },
        };
        const outcome = await owner[kind](scope);
        if (errors.length) throw new AggregateError(errors, `Recovery obligation ${entry.id} failed`);
        if (kind === "settled") {
          const settled = recordSettledOutcome(entry, outcome);
          if (settled !== undefined) return settled;
        }
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
