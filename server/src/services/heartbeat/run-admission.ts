import { logger } from "../../middleware/logger.js";

let runAdmissionClosed = false;

export function closeProcessRunAdmission(): void {
  runAdmissionClosed = true;
}

export function isProcessRunAdmissionClosed(): boolean {
  return runAdmissionClosed;
}

export function resetProcessRunAdmissionForTests(): void {
  runAdmissionClosed = false;
}

export type ReattachOutcome = "reached" | "given_up";
export type ReattachPhaseEndReason = "nothing_to_reattach" | "all_settled" | "cap_reached" | "discovery_failed";

export type ReattachPhaseSummary = {
  reason: ReattachPhaseEndReason;
  liveRuns: number;
  reached: number;
  givenUp: number;
  outstanding: number;
  durationMs: number;
  capMs: number;
  gatedStarts: boolean;
  runs: Array<{ runId: string; outcome: ReattachOutcome | "outstanding"; latencyMs: number }>;
};

type ReattachPhase = {
  startedAt: number;
  capMs: number;
  deadline: number;
  discovering: boolean;
  pending: Set<string>;
  settled: Array<{ runId: string; outcome: ReattachOutcome; latencyMs: number }>;
  liveRuns: number;
  gatedStarts: boolean;
  capTimer: ReturnType<typeof setTimeout> | null;
};

let reattachPhase: ReattachPhase | null = null;
const reattachPhaseEndListeners = new Set<(summary: ReattachPhaseSummary) => void>();

export function isReattachPhaseActive(now = Date.now()): boolean {
  const phase = reattachPhase;
  if (!phase) return false;
  if (now >= phase.deadline) {
    endReattachPhase("cap_reached", now);
    return false;
  }
  phase.gatedStarts = true;
  return true;
}

export function reattachPhaseRecheckAt(now = Date.now()): Date {
  const deadline = reattachPhase?.deadline ?? now;
  return new Date(Math.max(now + 1_000, Math.min(deadline, now + 10_000)));
}

export function openReattachPhase(capMs: number, now = Date.now()): void {
  if (reattachPhase) return;
  const phase: ReattachPhase = {
    startedAt: now, capMs, deadline: now + capMs, discovering: true, pending: new Set(), settled: [],
    liveRuns: 0, gatedStarts: false, capTimer: null,
  };
  phase.capTimer = setTimeout(() => { if (reattachPhase === phase) endReattachPhase("cap_reached"); }, capMs);
  phase.capTimer.unref?.();
  reattachPhase = phase;
}

export function trackReattachRuns(runIds: readonly string[], now = Date.now()): void {
  const phase = reattachPhase;
  if (!phase) return;
  for (const runId of runIds) phase.pending.add(runId);
  phase.liveRuns = phase.pending.size;
  phase.discovering = false;
  if (phase.pending.size === 0) {
    endReattachPhase("nothing_to_reattach", now);
    return;
  }
  logger.info({ liveRuns: phase.liveRuns, capMs: phase.capMs, discoveryMs: now - phase.startedAt },
    "reattach phase started: new run starts wait until every live run of the previous server is reached or given up");
}

export function failReattachDiscovery(now = Date.now()): void {
  if (reattachPhase?.discovering) endReattachPhase("discovery_failed", now);
}

export function pendingReattachRunIds(): string[] {
  return reattachPhase ? [...reattachPhase.pending] : [];
}

export function settleReattachRun(runId: string, outcome: ReattachOutcome, now = Date.now()): void {
  const phase = reattachPhase;
  if (!phase || !phase.pending.delete(runId)) return;
  const latencyMs = now - phase.startedAt;
  phase.settled.push({ runId, outcome, latencyMs });
  logger.info({ runId, outcome, latencyMs, remaining: phase.pending.size }, "reattach phase run settled");
  if (phase.pending.size === 0 && !phase.discovering) endReattachPhase("all_settled", now);
}

export function onReattachPhaseEnd(listener: (summary: ReattachPhaseSummary) => void): () => void {
  reattachPhaseEndListeners.add(listener);
  return () => { reattachPhaseEndListeners.delete(listener); };
}

function endReattachPhase(reason: ReattachPhaseEndReason, now = Date.now()): void {
  const phase = reattachPhase;
  if (!phase) return;
  reattachPhase = null;
  if (phase.capTimer) clearTimeout(phase.capTimer);
  const summary: ReattachPhaseSummary = {
    reason,
    liveRuns: phase.liveRuns,
    reached: phase.settled.filter(run => run.outcome === "reached").length,
    givenUp: phase.settled.filter(run => run.outcome === "given_up").length,
    outstanding: phase.pending.size,
    durationMs: now - phase.startedAt,
    capMs: phase.capMs,
    gatedStarts: phase.gatedStarts,
    runs: [...phase.settled, ...[...phase.pending].map(runId => ({ runId, outcome: "outstanding" as const, latencyMs: now - phase.startedAt }))],
  };
  if (reason === "cap_reached" || reason === "discovery_failed") logger.warn(summary, "reattach phase ended");
  else logger.info(summary, "reattach phase ended");
  for (const listener of reattachPhaseEndListeners) {
    try { listener(summary); } catch (error) { logger.warn({ err: error }, "reattach phase end listener failed"); }
  }
}

export function resetReattachPhaseForTests(): void {
  if (reattachPhase?.capTimer) clearTimeout(reattachPhase.capTimer);
  reattachPhase = null;
  reattachPhaseEndListeners.clear();
}
