import { useEffect, useMemo, useRef, useState } from "react";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";
import { heartbeatsApi } from "@/api/heartbeats";
import { nativeRunEventsToTranscript } from "./native-run-events";

const EVENT_PAGE_SIZE = 1_000;
const EVENT_POLL_INTERVAL_MS = 2_000;

export interface NativeRunTranscriptSource {
  id: string;
  status: string;
  runtimeMode?: "legacy" | "native";
}

function isLive(status: string): boolean {
  return status === "queued" || status === "running";
}

export function useNativeRunTranscripts(runs: readonly NativeRunTranscriptSource[]) {
  const nativeRunsKey = runs
    .filter((run) => run.runtimeMode === "native")
    .map((run) => `${run.id}:${run.status}`)
    .sort()
    .join(",");
  const nativeRuns = useMemo(
    () => runs.filter((run) => run.runtimeMode === "native").map((run) => ({ ...run })),
    // The key carries every field this hook consumes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nativeRunsKey],
  );
  const [eventsByRun, setEventsByRun] = useState<Map<string, HeartbeatRunEvent[]>>(new Map());
  const cursorByRunRef = useRef(new Map<string, number>());

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const refresh = async () => {
      const updates = new Map<string, HeartbeatRunEvent[]>();
      await Promise.all(nativeRuns.map(async (run) => {
        try {
          let cursor = cursorByRunRef.current.get(run.id) ?? 0;
          const incoming: HeartbeatRunEvent[] = [];
          for (;;) {
            const page = await heartbeatsApi.events(run.id, cursor, EVENT_PAGE_SIZE);
            if (cancelled) return;
            const last = page.at(-1);
            const nextCursor = last ? Math.max(cursor, last.seq) : cursor;
            incoming.push(...page);
            if (page.length < EVENT_PAGE_SIZE || nextCursor === cursor) {
              cursor = nextCursor;
              break;
            }
            cursor = nextCursor;
          }
          if (incoming.length > 0) updates.set(run.id, incoming);
          cursorByRunRef.current.set(run.id, cursor);
        } catch {
          // Keep the last durable cursor; the next poll retries this run only.
        }
      }));

      if (cancelled) return;
      const retainedIds = new Set(nativeRuns.map((run) => run.id));
      for (const runId of cursorByRunRef.current.keys()) {
        if (!retainedIds.has(runId)) cursorByRunRef.current.delete(runId);
      }
      setEventsByRun((previous) => {
        const next = new Map<string, HeartbeatRunEvent[]>();
        for (const runId of retainedIds) {
          const current = previous.get(runId) ?? [];
          const incoming = updates.get(runId) ?? [];
          next.set(runId, incoming.length > 0 ? [...current, ...incoming] : current);
        }
        return next;
      });

      if (nativeRuns.some((run) => isLive(run.status))) {
        timer = window.setTimeout(refresh, EVENT_POLL_INTERVAL_MS);
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [nativeRuns]);

  const transcriptByRun = useMemo(() => {
    const transcripts = new Map<string, TranscriptEntry[]>();
    for (const run of nativeRuns) {
      transcripts.set(run.id, nativeRunEventsToTranscript(eventsByRun.get(run.id) ?? []));
    }
    return transcripts;
  }, [eventsByRun, nativeRuns]);

  return { transcriptByRun };
}
