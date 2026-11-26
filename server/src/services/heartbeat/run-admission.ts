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
export const REATTACH_FAILURE_THRESHOLD_MS = 150_000;
export type ReattachPhaseEndReason = "nothing_to_reattach" | "all_settled" | "cap_reached";
export type ReattachClaimableReason = "handed_over" | "owner_gone" | "lease_expired";
export type ClaimableReattachRun = { runId: string; reason: ReattachClaimableReason; claimableAt: number };

export type ReattachPhaseSummary = {
  reason: ReattachPhaseEndReason;
  startReason: ReattachClaimableReason | null;
  liveRuns: number;
  authenticated: number;
  reached: number;
  reachedAfterThreshold: number;
  givenUp: number;
  outstanding: number;
  maxReachLatencyMs: number | null;
  durationMs: number;
  capMs: number;
  gatedStarts: boolean;
  runs: Array<{ runId: string; outcome: ReattachOutcome | "outstanding"; latencyMs: number; authenticatedMs: number | null }>;
};

type ReattachPhase = {
  startedAt: number;
  startReason: ReattachClaimableReason;
  capMs: number;
  deadline: number;
  pending: Set<string>;
  claimable: Map<string, { reason: ReattachClaimableReason; at: number }>;
  settled: Array<{ runId: string; outcome: ReattachOutcome; at: number }>;
  authenticatedAt: Map<string, number>;
  gatedStarts: boolean;
  announced: boolean;
  capTimer: ReturnType<typeof setTimeout> | null;
};

let reattachCapMs = 0;
let reattachEnabledAt = 0;
let reattachPhase: ReattachPhase | null = null;
const joinedReattachRuns = new Set<string>();
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

export function enableReattachPhase(capMs: number, now = Date.now()): void {
  reattachCapMs = capMs;
  reattachEnabledAt = now;
}

function claimableSince(claimableAt: number, now: number): number {
  return Math.min(now, Math.max(reattachEnabledAt, claimableAt));
}

export function isReattachPhaseEnabled(): boolean {
  return reattachCapMs > 0;
}

export function hasJoinedReattachPhase(runId: string): boolean {
  return joinedReattachRuns.has(runId);
}

export function joinReattachPhase(runs: readonly ClaimableReattachRun[], options: { announce?: boolean } = {},
  now = Date.now()): string[] {
  if (reattachCapMs <= 0) return [];
  const fresh = runs.filter(run => !joinedReattachRuns.has(run.runId));
  if (fresh.length === 0) return [];
  let phase = reattachPhase;
  if (!phase) {
    const first = fresh.reduce((earliest, run) => run.claimableAt < earliest.claimableAt ? run : earliest);
    phase = {
      startedAt: claimableSince(first.claimableAt, now), startReason: first.reason, capMs: reattachCapMs, deadline: 0,
      pending: new Set(), claimable: new Map(), settled: [], authenticatedAt: new Map(), gatedStarts: false,
      announced: false, capTimer: null,
    };
    reattachPhase = phase;
  }
  for (const run of fresh) {
    joinedReattachRuns.add(run.runId);
    phase.pending.add(run.runId);
    phase.claimable.set(run.runId, { reason: run.reason, at: claimableSince(run.claimableAt, now) });
  }
  armReattachCap(phase, Math.max(...fresh.map(run => claimableSince(run.claimableAt, now))) + phase.capMs, now);
  if (options.announce !== false) announceReattachPhase(fresh.map(run => run.runId), now);
  return fresh.map(run => run.runId);
}

export function refineReattachClaimable(runs: readonly ClaimableReattachRun[], now = Date.now()): void {
  const phase = reattachPhase;
  if (!phase) return;
  for (const run of runs) {
    const current = phase.claimable.get(run.runId);
    if (!current) continue;
    const at = Math.min(current.at, claimableSince(run.claimableAt, now));
    phase.claimable.set(run.runId, { reason: run.reason, at });
    if (at < phase.startedAt) phase.startedAt = at;
  }
  const entries = [...phase.claimable.values()];
  const earliest = entries.reduce((first, entry) => entry.at < first.at ? entry : first);
  phase.startReason = earliest.reason;
  const deadline = Math.max(...entries.map(entry => entry.at)) + phase.capMs;
  if (deadline < phase.deadline) {
    phase.deadline = 0;
    armReattachCap(phase, deadline, now);
  }
}

export function announceReattachPhase(runIds: readonly string[], now = Date.now()): void {
  const phase = reattachPhase;
  if (!phase) return;
  const joined = runIds.filter(runId => phase.claimable.has(runId));
  if (joined.length === 0) return;
  const reasons = Object.fromEntries((["handed_over", "owner_gone", "lease_expired"] as const)
    .map(reason => [reason, joined.filter(runId => phase.claimable.get(runId)?.reason === reason).length])
    .filter(([, count]) => count));
  const fields = { reason: phase.startReason, reasons, liveRuns: phase.claimable.size, joined: joined.length,
    capMs: phase.capMs, capEndsInMs: phase.deadline - now,
    claimableAgoMs: Math.max(...joined.map(runId => now - phase.claimable.get(runId)!.at)) };
  if (!phase.announced) {
    phase.announced = true;
    logger.info(fields, "reattach phase started: live runs of a previous server became claimable; new run starts wait until each is reached or given up");
  } else {
    logger.info(fields, "reattach phase grew: more live runs of a previous server became claimable");
  }
}

function armReattachCap(phase: ReattachPhase, deadline: number, now: number): void {
  if (deadline <= phase.deadline) return;
  phase.deadline = deadline;
  if (phase.capTimer) clearTimeout(phase.capTimer);
  phase.capTimer = setTimeout(() => { if (reattachPhase === phase) endReattachPhase("cap_reached"); },
    Math.max(0, deadline - now));
  phase.capTimer.unref?.();
}

export function pendingReattachRunIds(): string[] {
  return reattachPhase ? [...reattachPhase.pending] : [];
}

export function markReattachAuthenticated(runId: string, now = Date.now()): void {
  const phase = reattachPhase;
  if (!phase || !phase.pending.has(runId) || phase.authenticatedAt.has(runId)) return;
  phase.authenticatedAt.set(runId, now);
  logger.info({ runId, authenticatedMs: now - phase.claimable.get(runId)!.at }, "reattach phase run authenticated");
}

export function settleReattachRun(runId: string, outcome: ReattachOutcome, now = Date.now()): void {
  const phase = reattachPhase;
  if (!phase || !phase.pending.delete(runId)) return;
  phase.settled.push({ runId, outcome, at: now });
  const claimable = phase.claimable.get(runId)!;
  const authenticatedAt = phase.authenticatedAt.get(runId);
  logger.info({ runId, outcome, claimableReason: claimable.reason, latencyMs: now - claimable.at,
    authenticatedMs: authenticatedAt === undefined ? null : authenticatedAt - claimable.at,
    remaining: phase.pending.size }, "reattach phase run settled");
  if (phase.pending.size === 0) endReattachPhase("all_settled", now);
}

export function onReattachPhaseEnd(listener: (summary: ReattachPhaseSummary) => void): () => void {
  reattachPhaseEndListeners.add(listener);
  return () => { reattachPhaseEndListeners.delete(listener); };
}

export function reportNothingToReattach(): void {
  publishReattachPhaseEnd({ reason: "nothing_to_reattach", startReason: null, liveRuns: 0, authenticated: 0, reached: 0,
    reachedAfterThreshold: 0, givenUp: 0, outstanding: 0, maxReachLatencyMs: null, durationMs: 0, capMs: reattachCapMs,
    gatedStarts: false, runs: [] });
}

function endReattachPhase(reason: ReattachPhaseEndReason, now = Date.now()): void {
  const phase = reattachPhase;
  if (!phase) return;
  reattachPhase = null;
  if (phase.capTimer) clearTimeout(phase.capTimer);
  const latency = (runId: string, at: number) => at - phase.claimable.get(runId)!.at;
  const authenticatedMs = (runId: string) => {
    const at = phase.authenticatedAt.get(runId);
    return at === undefined ? null : latency(runId, at);
  };
  const runs = [
    ...phase.settled.map(run => ({ runId: run.runId, outcome: run.outcome, latencyMs: latency(run.runId, run.at) })),
    ...[...phase.pending].map(runId => ({ runId, outcome: "outstanding" as const, latencyMs: latency(runId, now) })),
  ].map(run => ({ ...run, authenticatedMs: authenticatedMs(run.runId) }));
  const reached = runs.filter(run => run.outcome === "reached");
  publishReattachPhaseEnd({
    reason,
    startReason: phase.startReason,
    liveRuns: phase.claimable.size,
    authenticated: phase.authenticatedAt.size,
    reached: reached.length,
    reachedAfterThreshold: reached.filter(run => run.latencyMs > REATTACH_FAILURE_THRESHOLD_MS).length,
    givenUp: runs.filter(run => run.outcome === "given_up").length,
    outstanding: phase.pending.size,
    maxReachLatencyMs: reached.length ? Math.max(...reached.map(run => run.latencyMs)) : null,
    durationMs: now - phase.startedAt,
    capMs: phase.capMs,
    gatedStarts: phase.gatedStarts,
    runs,
  });
}

function publishReattachPhaseEnd(summary: ReattachPhaseSummary): void {
  if (summary.reason === "cap_reached") logger.warn(summary, "reattach phase ended");
  else logger.info(summary, "reattach phase ended");
  for (const listener of reattachPhaseEndListeners) {
    try { listener(summary); } catch (error) { logger.warn({ err: error }, "reattach phase end listener failed"); }
  }
}

export function resetReattachPhaseForTests(): void {
  if (reattachPhase?.capTimer) clearTimeout(reattachPhase.capTimer);
  reattachPhase = null;
  reattachCapMs = 0;
  reattachEnabledAt = 0;
  joinedReattachRuns.clear();
  reattachPhaseEndListeners.clear();
}
