import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { fileResourcesApi } from "@/api/file-resources";
import { queryKeys } from "@/lib/queryKeys";
import {
  chunkWorkspaceFileAvailabilityRefs,
  workspaceFileAvailabilityFromResult,
  workspaceFileAvailabilityKey,
  WORKSPACE_FILE_AVAILABILITY_PENDING,
  WORKSPACE_FILE_AVAILABILITY_STALE_MS,
  type WorkspaceFileAvailability,
  type WorkspaceFileAvailabilityRef,
} from "@/lib/workspace-file-availability";

type QueuedRef = readonly [key: string, ref: WorkspaceFileAvailabilityRef];
type QueuedBatch = {
  chunk: QueuedRef[];
  issueId: string;
  generation: number;
};

/** Matches the server's per-actor, per-issue availability concurrency limit. */
const WORKSPACE_FILE_AVAILABILITY_MAX_CONCURRENT = 2;

export interface WorkspaceFileAvailabilityRegistry {
  /**
   * Bumped whenever known results change. Consumers that memoize on the
   * registry (remark plugins) must include it so a completed batch re-renders.
   */
  version: number;
  /**
   * Read the availability of a reference, queueing a batched check the first
   * time it is seen. Safe to call during render: it only mutates internal
   * queues and schedules the request for the next macrotask.
   */
  check(ref: WorkspaceFileAvailabilityRef): WorkspaceFileAvailability;
}

function isFileResourceKeyForIssue(queryKey: readonly unknown[], issueId: string) {
  return queryKey[0] === "issues" && queryKey[1] === "file-resources" && queryKey[2] === issueId;
}

/**
 * Issue-scoped registry of workspace-file availability results.
 *
 * References discovered while rendering markdown are deduplicated by key,
 * coalesced into a single request per event-loop burst, chunked only above the
 * server's 100-query cap, and cached on the shared file-resource query key so
 * an invalidation of the issue's file resources forces a recheck.
 */
export function useWorkspaceFileAvailability(issueId: string): WorkspaceFileAvailabilityRegistry {
  const queryClient = useQueryClient();
  const [version, setVersion] = useState(0);
  const resultsRef = useRef<Map<string, WorkspaceFileAvailability>>(new Map());
  const queueRef = useRef<Map<string, WorkspaceFileAvailabilityRef>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const batchQueueRef = useRef<QueuedBatch[]>([]);
  const activeBatchCountRef = useRef(0);
  const flushHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);
  const generationRef = useRef(0);
  const clientRef = useRef<QueryClient>(queryClient);
  clientRef.current = queryClient;

  // Reset during render rather than in an effect: children call `check()` while
  // rendering, so an effect-based reset would discard the queue they just
  // filled. A new issue scope must not inherit another issue's confirmations.
  const issueIdRef = useRef(issueId);
  if (issueIdRef.current !== issueId) {
    issueIdRef.current = issueId;
    generationRef.current += 1;
    if (flushHandleRef.current !== null) {
      clearTimeout(flushHandleRef.current);
      flushHandleRef.current = null;
    }
    resultsRef.current.clear();
    queueRef.current.clear();
    inFlightRef.current.clear();
    batchQueueRef.current = [];
  }

  const bump = useCallback(() => {
    if (!activeRef.current) return;
    setVersion((current) => current + 1);
  }, []);

  const runBatch = useCallback(
    async ({ chunk, issueId: batchIssueId, generation }: QueuedBatch) => {
      // Sorted keys give identical batches one cache entry regardless of the
      // order the refs happened to be rendered in.
      const refKeys = chunk.map(([key]) => key).sort();
      try {
        const response = await clientRef.current.fetchQuery({
          queryKey: queryKeys.issues.fileResourceAvailability(batchIssueId, refKeys),
          queryFn: () => fileResourcesApi.availability(batchIssueId, chunk.map(([, ref]) => ref)),
          staleTime: WORKSPACE_FILE_AVAILABILITY_STALE_MS,
        });
        if (generation !== generationRef.current) return;
        const byKey = new Map(
          response.results.map((result) => [
            workspaceFileAvailabilityKey(result.query),
            workspaceFileAvailabilityFromResult(result),
          ]),
        );
        for (const [key] of chunk) {
          // A reference the server did not echo back stays non-openable rather
          // than falling through to a provisional link.
          resultsRef.current.set(key, byKey.get(key) ?? { state: "unavailable", reason: "unmatched_reference" });
          inFlightRef.current.delete(key);
        }
        bump();
      } catch {
        if (generation !== generationRef.current) return;
        // Fail closed: the refs stay unresolved and render as plain inline code.
        // Releasing them from the in-flight set lets a later render burst retry
        // without looping, since a failure never triggers a re-render itself.
        for (const [key] of chunk) inFlightRef.current.delete(key);
      }
    },
    [bump],
  );

  const drainBatchQueue = useCallback(() => {
    while (
      activeBatchCountRef.current < WORKSPACE_FILE_AVAILABILITY_MAX_CONCURRENT
      && batchQueueRef.current.length > 0
    ) {
      const batch = batchQueueRef.current.shift()!;
      activeBatchCountRef.current += 1;
      void runBatch(batch).finally(() => {
        activeBatchCountRef.current -= 1;
        drainBatchQueue();
      });
    }
  }, [runBatch]);

  const flush = useCallback(() => {
    flushHandleRef.current = null;
    const queued = [...queueRef.current.entries()] as QueuedRef[];
    queueRef.current.clear();
    const fresh = queued.filter(([key]) => !inFlightRef.current.has(key) && !resultsRef.current.has(key));
    if (fresh.length === 0) return;
    for (const [key] of fresh) inFlightRef.current.add(key);
    batchQueueRef.current.push(
      ...chunkWorkspaceFileAvailabilityRefs(fresh).map((chunk) => ({
        chunk,
        issueId,
        generation: generationRef.current,
      })),
    );
    drainBatchQueue();
  }, [drainBatchQueue, issueId]);

  const check = useCallback<WorkspaceFileAvailabilityRegistry["check"]>(
    (ref) => {
      const key = workspaceFileAvailabilityKey(ref);
      const known = resultsRef.current.get(key);
      if (known) return known;
      if (!inFlightRef.current.has(key) && !queueRef.current.has(key)) {
        queueRef.current.set(key, ref);
        if (flushHandleRef.current === null) {
          flushHandleRef.current = setTimeout(flush, 0);
        }
      }
      return WORKSPACE_FILE_AVAILABILITY_PENDING;
    },
    [flush],
  );

  useEffect(() => {
    activeRef.current = true;
    // A remount (StrictMode, suspense replay) tears down the timer scheduled by
    // the render that filled the queue; reschedule so those refs aren't stranded.
    if (queueRef.current.size > 0 && flushHandleRef.current === null) {
      flushHandleRef.current = setTimeout(flush, 0);
    }
    return () => {
      activeRef.current = false;
      if (flushHandleRef.current !== null) {
        clearTimeout(flushHandleRef.current);
        flushHandleRef.current = null;
      }
    };
  }, [flush]);

  // Recheck when the issue's file resources are invalidated (workspace changed,
  // run finished, viewer refreshed). Only `invalidate` actions are handled so
  // writing our own batch results cannot loop.
  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "invalidate") return;
      if (!isFileResourceKeyForIssue(event.query.queryKey, issueId)) return;
      if (resultsRef.current.size === 0) return;
      resultsRef.current.clear();
      bump();
    });
  }, [bump, issueId, queryClient]);

  return useMemo(() => ({ version, check }), [version, check]);
}
