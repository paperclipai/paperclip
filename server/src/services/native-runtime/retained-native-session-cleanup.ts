import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { nativeRunnerOwnershipNotHeldCondition } from "./native-runner-ownership.js";

import type { RetainedNativeSessionCleanupScope } from "../retained-native-session-cleanup-notifications.js";
export type { RetainedNativeSessionCleanupScope } from "../retained-native-session-cleanup-notifications.js";




export function findRetainedNativeSessionCleanupCandidates(db: Db, options: {
  scope?: RetainedNativeSessionCleanupScope;
  after?: string;
  limit: number;
  includeLeased?: boolean;
}) {
  return db
    .select({
      runId: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      issueId: nativeRunFinalizations.issueId,
      agentId: heartbeatRuns.agentId,
      leaseOwner: nativeRunFinalizations.leaseOwner,
      leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    })
    .from(heartbeatRuns)
    .innerJoin(
      nativeRunFinalizations,
      and(
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId),
      ),
    )
    .innerJoin(
      nativeRunResults,
      and(
        eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.runId, heartbeatRuns.id),
        eq(nativeRunResults.companyId, heartbeatRuns.companyId),
        eq(nativeRunResults.issueId, heartbeatRuns.nativeIssueId),
      ),
    )
    .where(
      and(
        eq(heartbeatRuns.runtimeMode, "native"),
        inArray(heartbeatRuns.status, ["succeeded", "failed"]),
        isNotNull(heartbeatRuns.finishedAt),
        nativeRunnerOwnershipNotHeldCondition(),
        eq(nativeRunFinalizations.phase, "committed"),
        eq(nativeRunResults.schemaStatus, "accepted"),
        isNotNull(nativeRunFinalizations.assessmentId),
        isNotNull(nativeRunFinalizations.decisionId),
        isNull(nativeRunFinalizations.nextAttemptAt),
        options.includeLeased ? undefined : or(
          isNull(nativeRunFinalizations.leaseOwner),
          isNull(nativeRunFinalizations.leaseExpiresAt),
          lte(nativeRunFinalizations.leaseExpiresAt, sql`now()`),
        ),


        sql`coalesce(${heartbeatRuns.errorCode}, ${heartbeatRuns.resultJson}->'recoveredExecutionFailure'->>'errorCode') in ('adapter_failed', 'provider_transport_failed')`,
        sql`coalesce(${heartbeatRuns.error}, ${heartbeatRuns.resultJson}->'recoveredExecutionFailure'->>'error') = 'provider_transport_failed: runner did not durably suspend before checkpoint'`,
        sql`not (${nativeRunFinalizations.recoveryHistory} @> '[{"kind":"native_cleanup_runner_epoch"}]'::jsonb)`,
        sql`not (${nativeRunFinalizations.recoveryHistory} @> '[{"kind":"native_cleanup_source_archive","phase":"operator_required"}]'::jsonb)`,




        sql`(
          select coalesce(
            jsonb_array_length(history.entries) = 0 or (
              jsonb_array_length(history.entries) = 2
              and history.entries->0->>'version' = '1'
              and history.entries->1->>'version' = '1'
              and history.entries->0->>'phase' = 'started'
              and history.entries->1->>'phase' = 'operator_required'
              and history.entries->1->>'code' = 'native_cleanup_maintenance_unproven'
              and history.entries->0->>'requestId' like 'native-cleanup:%'
              and history.entries->0->>'requestId' = history.entries->1->>'requestId'
              and history.entries->0->>'sourceFingerprint' ~ '^[a-f0-9]{64}$'
            ), false
          )
          from (
            select coalesce(jsonb_agg(entry.value order by entry.ordinal), '[]'::jsonb) as entries
            from jsonb_array_elements(${nativeRunFinalizations.recoveryHistory})
              with ordinality as entry(value, ordinal)
            where entry.value->>'kind' = 'native_cleanup_maintenance'
          ) history
        )`,
        options.scope ? and(
          eq(heartbeatRuns.companyId, options.scope.companyId),
          options.scope.runId ? eq(heartbeatRuns.id, options.scope.runId) : undefined,
          options.scope.issueId ? eq(nativeRunFinalizations.issueId, options.scope.issueId) : undefined,
          options.scope.agentId ? eq(heartbeatRuns.agentId, options.scope.agentId) : undefined,
        ) : undefined,
        options.after ? gt(heartbeatRuns.id, options.after) : undefined,
      ),
    )
    .orderBy(asc(heartbeatRuns.id))
    .limit(options.limit);
}

export type NativeCleanupOutcome = {
  runId: string;
  status: "settled" | "not_eligible" | "operator_required";
} | {
  runId: string;
  status: "deferred";
  waitFor: "process_exit" | "session_release" | "environment_release" | "maintenance_settlement";
} | {
  runId: string;
  status: "deferred";
  waitFor: "lease_expiry";
  retryAt: Date;
};
export type RetainedNativeSessionCleanup = (input: { companyId: string; runId: string }) => Promise<NativeCleanupOutcome>;





const operations = new WeakMap<Db, {
  tail: Promise<void>;
  runs: Map<string, Promise<NativeCleanupOutcome>>;
}>();
export function runRetainedNativeSessionCleanup(db: Db, input: { companyId: string; runId: string }, cleanup: RetainedNativeSessionCleanup) {
  let owned = operations.get(db);
  if (!owned) { owned = { tail: Promise.resolve(), runs: new Map() }; operations.set(db, owned); }
  const existing = owned.runs.get(input.runId);
  if (existing) return existing;
  const pending = owned.tail.then(() => cleanup(input)).finally(() => {
    if (owned.runs.get(input.runId) === pending) owned.runs.delete(input.runId);
    if (!owned.runs.size && operations.get(db) === owned) operations.delete(db);
  });
  owned.runs.set(input.runId, pending);
  owned.tail = pending.then(() => undefined, () => undefined);
  return pending;
}
export function pendingRetainedNativeSessionCleanup(db: Db, runId: string) {
  return operations.get(db)?.runs.get(runId);
}

type NativeCleanupSweep = {
  cursor: string | null;
  pending: Promise<NativeCleanupOutcome[]> | null;
};
const nativeCleanupSweeps = new WeakMap<Db, NativeCleanupSweep>();





export function reconcileRetainedNativeSessionCleanups(
  db: Db,
  options: {
    cleanup: RetainedNativeSessionCleanup;
    onError?: (error: unknown, runId: string) => void;
    limit?: number;
  },
): Promise<NativeCleanupOutcome[]> {
  let sweep = nativeCleanupSweeps.get(db);
  if (!sweep) {
    sweep = { cursor: null, pending: null };
    nativeCleanupSweeps.set(db, sweep);
  }
  if (sweep.pending) return sweep.pending;
  const owned = sweep;
  const limit = Number.isInteger(options.limit)
    ? Math.max(1, Math.min(5, options.limit!))
    : 1;
  const operation = async () => {
    const selectCandidates = (cursor: string | null) =>
      findRetainedNativeSessionCleanupCandidates(db, { after: cursor ?? undefined, limit });
    let candidates = await selectCandidates(owned.cursor);
    if (candidates.length === 0 && owned.cursor !== null) {
      owned.cursor = null;
      candidates = await selectCandidates(null);
    }
    const outcomes: NativeCleanupOutcome[] = [];
    for (const candidate of candidates) {
      owned.cursor = candidate.runId;
      try {
        outcomes.push(await runRetainedNativeSessionCleanup(db, { companyId: candidate.companyId, runId: candidate.runId }, options.cleanup));
      } catch (error) {
        options.onError?.(error, candidate.runId);
      }
    }
    return outcomes;
  };


  const pending = Promise.resolve()
    .then(operation)
    .finally(() => {
      if (owned.pending === pending) owned.pending = null;
    });
  owned.pending = pending;
  return pending;
}
