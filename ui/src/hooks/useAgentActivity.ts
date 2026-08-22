import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, LiveEvent } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { useCompanyLiveEvent } from "../context/LiveUpdatesProvider";

// Drives the two Org/Office animations:
//   • PULSE  — the set of agents currently "live" (have a running heartbeat run).
//   • BEAMS  — transient agent→agent signals (delegation, @mention, sync) that
//              travel along a connection for a couple of seconds, then fade.

export type BeamKind = "delegation" | "mention" | "sync";

export interface BeamSpec {
  fromAgentId: string;
  toAgentId: string;
  kind: BeamKind;
}

export interface ActiveBeam extends BeamSpec {
  id: number;
}

const BEAM_TTL_MS = 2500;
const MAX_BEAMS = 12;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstString(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = str(item);
      if (s) return s;
    }
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Map a live event to a beam (from → to), or null when it isn't an agent→agent
 * signal. Pure so it can be unit-tested. `resolveManager` (agent → its manager)
 * lets an active-run event render as a "sync" beam up the org chain.
 */
export function liveEventToBeam(
  event: LiveEvent,
  resolveManager?: (agentId: string) => string | null,
): BeamSpec | null {
  const payload = event.payload ?? {};

  if (event.type === "activity.logged") {
    const actorType = str(payload.actorType);
    const actorId = str(payload.actorId);
    if (actorType !== "agent" || !actorId) return null;
    const action = str(payload.action);
    const details = readRecord(payload.details);
    if (action === "issue.updated") {
      const to = str(details.assigneeAgentId) ?? str(details.toAgentId);
      if (to && to !== actorId) return { fromAgentId: actorId, toAgentId: to, kind: "delegation" };
      return null;
    }
    if (action === "issue.comment_added") {
      const to =
        str(details.toAgentId) ??
        str(details.mentionedAgentId) ??
        firstString(details.mentionedAgentIds);
      if (to && to !== actorId) return { fromAgentId: actorId, toAgentId: to, kind: "mention" };
      return null;
    }
    return null;
  }

  if (event.type === "heartbeat.run.queued" || event.type === "heartbeat.run.status") {
    const agentId = str(payload.agentId);
    if (!agentId || !resolveManager) return null;
    const manager = resolveManager(agentId);
    if (manager && manager !== agentId) {
      return { fromAgentId: agentId, toAgentId: manager, kind: "sync" };
    }
    return null;
  }

  return null;
}

/**
 * Live activity for a company: which agents are currently working (pulse) and a
 * short-lived queue of agent→agent beams. Reuses the shared `liveRuns` query
 * cache (no extra network) and the single shared LiveUpdates socket. Degrades to
 * empty when rendered without a LiveUpdatesProvider (e.g. in isolated tests).
 */
export function useAgentActivity(companyId: string | null | undefined) {
  const queryClient = useQueryClient();

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: !!companyId,
  });

  const liveAgentIds = useMemo(
    () => new Set((liveRuns ?? []).map((run) => run.agentId)),
    [liveRuns],
  );

  const [activeBeams, setActiveBeams] = useState<ActiveBeam[]>([]);
  const beamSeq = useRef(0);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const resolveManager = useCallback(
    (agentId: string): string | null => {
      if (!companyId) return null;
      const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
      return agents?.find((a) => a.id === agentId)?.reportsTo ?? null;
    },
    [companyId, queryClient],
  );

  useCompanyLiveEvent(
    useCallback(
      (event: LiveEvent) => {
        const spec = liveEventToBeam(event, resolveManager);
        if (!spec) return;
        const id = ++beamSeq.current;
        setActiveBeams((prev) => {
          const next = [...prev, { ...spec, id }];
          return next.length > MAX_BEAMS ? next.slice(next.length - MAX_BEAMS) : next;
        });
        const timer = setTimeout(() => {
          setActiveBeams((prev) => prev.filter((beam) => beam.id !== id));
          timers.current.delete(timer);
        }, BEAM_TTL_MS);
        timers.current.add(timer);
      },
      [resolveManager],
    ),
  );

  useEffect(() => {
    const timerSet = timers.current;
    return () => {
      for (const timer of timerSet) clearTimeout(timer);
      timerSet.clear();
    };
  }, []);

  return { liveAgentIds, activeBeams };
}
