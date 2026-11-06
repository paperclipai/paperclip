import { nativeResponsePresentationCandidates } from "./native-response-presentation-query.js";
import { asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { NativeResponsePresentationScope } from "../native-response-presentation-notifications.js";
import { onCommittedChatResponseAuthorityRegistered } from "../durable-chat-wakeup.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { recoverCommittedNativeChatResponse } from "./native-run-finalizer.js";
import { measureRunPhase, withRunResponsePresentationTiming } from "../execution-preparation-timing.js";
import { recordNativeResponsePublicationAttempt } from "./native-response-publication-receipt.js";

export function registerNativeResponsePresentationWork(db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
  return nativeResponsePresentationWork(db).register(coordinator, canRun);
}

type Entry = { id: string; companyId: string; issueId: string; agentId: string; endpointId?: string | null; principalId?: string | null; dueAt: number };

type Candidate = { nextAttemptAt: Date | null; publicationNextAttemptAt: string | null };
function dueAt(row: Candidate) {
  const published = row.publicationNextAttemptAt ? Date.parse(row.publicationNextAttemptAt) : 0;
  return Math.max(row.nextAttemptAt?.getTime() ?? 0, Number.isFinite(published) ? published : 0);
}

export function nativeResponsePresentationWork(db: Db) {
  const candidates = (scope?: NativeResponsePresentationScope, after?: string, runId?: string) => {
    const query = nativeResponsePresentationCandidates(scope, after, runId).as("pending_native_response");
    return db.select().from(query).orderBy(asc(query.id));
  };
  function load(scope?: NativeResponsePresentationScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const work = () => loadWithinTrace(scope, signal, canRun);
    return scope?.runId ? withRunResponsePresentationTiming(scope.runId, work) : work();
  }
  async function loadWithinTrace(scope: NativeResponsePresentationScope | undefined, signal: AbortSignal | undefined,
    canRun: () => boolean): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await measureRunPhase("response.resolve", () => candidates(scope, after));
      for (const row of rows) entries.push({ id: row.id, companyId: row.companyId, issueId: row.issueId, agentId: row.agentId, endpointId: row.endpointId, principalId: row.principalId, dueAt: dueAt(row) });
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
    throw new Error("Native response presentation discovery stopped");
  }
  function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    return withRunResponsePresentationTiming(entry.id, () => checkWithinTrace(entry, signal));
  }
  async function checkWithinTrace(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native response presentation recovery stopped");
    const scope = { companyId: entry.companyId, issueId: entry.issueId };
    const [current] = await measureRunPhase("response.resolve", () => candidates(scope, undefined, entry.id));
    if (!current) return null;
    if (dueAt(current) > Date.now()) return { ...entry, dueAt: dueAt(current) };
    if (signal?.aborted) throw new Error("Native response presentation recovery stopped");
    const recoveryStartedAt = Date.now();
    let failure: unknown = null;
    try {
      await recoverCommittedNativeChatResponse(db, { ...scope, runId: entry.id, onlyWhenDue: true });
    } catch (error) {
      // Ordinary task replies own a durable, bounded retry below. Other
      // presentation classes keep the coordinator's in-memory backoff.
      if (!current.taskReply) throw error;
      failure = error;
    }
    const [remaining] = await measureRunPhase("response.resolve", () => candidates(scope, undefined, entry.id));
    // A published reply settles its retry receipt in the same write that
    // records the comment, so a vanished candidate needs no cleanup here.
    if (!remaining) return null;
    // The coordinator, or another worker's saved retry, already moved the deadline.
    if (dueAt(remaining) > recoveryStartedAt) return { ...entry, dueAt: dueAt(remaining) };
    if (!remaining.taskReply) return null;
    // The accepted reply is still unpublished after a due attempt. Never drop
    // it silently: schedule a bounded retry or record the named failure.
    const attempt = await recordNativeResponsePublicationAttempt(db, {
      companyId: entry.companyId, issueId: entry.issueId, runId: entry.id,
      reason: failure ? "publication_error" : "publication_refused", error: failure,
    });
    return attempt?.state === "retrying" ? { ...entry, dueAt: attempt.nextAttemptAt } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    const worker = registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeResponsePresentation,
      // Endpoint and principal IDs are only dispatch hints. Recovery still locks and checks
      // the complete current source authority inside its own transaction.
      concurrentChecks: { limit: 4, key: (entry: Entry) => [
        `issue:${entry.companyId}:${entry.issueId}`,
        ...(entry.endpointId ? [`endpoint:${entry.companyId}:${entry.endpointId}`] : []),
        ...(entry.principalId ? [`principal:${entry.companyId}:${entry.principalId}`] : []),
      ] },
      decodeScope: (hint: string): NativeResponsePresentationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: NativeResponsePresentationScope) => !scope || entry.companyId === scope.companyId && (!scope.issueId || entry.issueId === scope.issueId) && (!scope.runId || entry.id === scope.runId) && (!scope.agentId || entry.agentId === scope.agentId),
      load: (scope, signal) => load(scope, signal, canRun),
      check: (entry, signal) => {
        if (!canRun()) throw new Error("Native response presentation recovery paused");
        return check(entry, signal);
      },
    }, canRun);
    const unsubscribe = onCommittedChatResponseAuthorityRegistered(db, () => worker.invalidate());
    return { ...worker, stop: unsubscribe };
  }
  return { load, check, register };
}
