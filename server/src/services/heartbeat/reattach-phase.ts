import { and, eq, inArray, isNotNull, isNull, ne, notLike, or } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { currentControllerBootId } from "../controller-process-identity.js";
import {
  announceReattachPhase,
  enableReattachPhase,
  hasJoinedReattachPhase,
  isProcessRunAdmissionClosed,
  isReattachPhaseEnabled,
  joinReattachPhase,
  onReattachPhaseEnd,
  pendingReattachRunIds,
  refineReattachClaimable,
  reportNothingToReattach,
  settleReattachRun,
  type ClaimableReattachRun,
  type ReattachClaimableReason,
} from "./run-admission.js";

export const REATTACH_PHASE_DEFAULT_CAP_MS = 180_000;
export const REATTACH_PHASE_MIN_CAP_MS = 5_000;
export const REATTACH_PHASE_MAX_CAP_MS = 600_000;
export const REATTACH_PHASE_RECHECK_MS = 2_000;

export function reattachPhaseCapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_REATTACH_PHASE_CAP_MS?.trim();
  if (!raw) return REATTACH_PHASE_DEFAULT_CAP_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return REATTACH_PHASE_DEFAULT_CAP_MS;
  if (parsed <= 0) return 0;
  return Math.min(REATTACH_PHASE_MAX_CAP_MS, Math.max(REATTACH_PHASE_MIN_CAP_MS, Math.round(parsed)));
}

export type PreviousControllerRunLease = { runId: string; leaseExpiresAt: Date | null; recoveryState: string | null };

export async function listPreviousControllerRunLeases(db: Db, bootId = currentControllerBootId()): Promise<PreviousControllerRunLease[]> {
  const rows = await db.select({ runId: heartbeatRuns.id, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    recoveryState: nativeRunFinalizations.recoveryState })
    .from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(
      eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.runtimeMode, "native"),
      eq(nativeRunFinalizations.phase, "observed"),
      isNull(nativeRunFinalizations.resultId),
      isNotNull(nativeRunFinalizations.leaseOwner),
      notLike(nativeRunFinalizations.leaseOwner, "native-finalizer:%"),
      notLike(nativeRunFinalizations.leaseOwner, "native-cleanup:%"),
      or(isNull(nativeRunFinalizations.controllerBootId), ne(nativeRunFinalizations.controllerBootId, bootId)),
    ));
  return [...new Map(rows.map(row => [row.runId, row])).values()];
}

export async function listLiveRunsOwnedByPreviousControllers(db: Db, bootId = currentControllerBootId()): Promise<string[]> {
  return (await listPreviousControllerRunLeases(db, bootId)).map(row => row.runId);
}

export function claimableReattachRun(row: PreviousControllerRunLease, now = Date.now()): ClaimableReattachRun | null {
  const expiresAt = row.leaseExpiresAt?.getTime() ?? null;
  if (expiresAt !== null && expiresAt > now) return null;
  const reason: ReattachClaimableReason = row.recoveryState === "awaiting_runner_reattach" ? "handed_over"
    : expiresAt === null ? "owner_gone" : "lease_expired";
  return { runId: row.runId, reason, claimableAt: expiresAt ?? now };
}

export async function settleFinishedReattachRuns(db: Db): Promise<number> {
  const pending = pendingReattachRunIds();
  if (pending.length === 0) return 0;
  const rows = await db.select({ runId: heartbeatRuns.id, status: heartbeatRuns.status,
    resultId: nativeRunFinalizations.resultId, phase: nativeRunFinalizations.phase })
    .from(heartbeatRuns)
    .leftJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId)))
    .where(inArray(heartbeatRuns.id, pending));
  const live = new Set(rows.filter(row => row.status === "running" && row.resultId === null && row.phase === "observed")
    .map(row => row.runId));
  const finished = pending.filter(runId => !live.has(runId));
  for (const runId of finished) settleReattachRun(runId, "given_up");
  return finished.length;
}

type ReattachWorker = { wake: () => void; stop: () => Promise<void>; ready: Promise<unknown> };

type ReattachWatch = {
  db: Db;
  bootId: string;
  initialized: boolean;
  notified: boolean;
  watching: boolean;
  leases: Map<string, PreviousControllerRunLease>;
  worker: ReattachWorker | null;
  stopListening: () => void;
  claim?: (runIds: string[]) => Promise<unknown>;
};

let watch: ReattachWatch | null = null;

export async function notifyReattachHandOver(transaction: object, runId: string): Promise<void> {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.reattachPhase, runId);
}

function observeLeases(current: ReattachWatch, rows: PreviousControllerRunLease[], now = Date.now()): string[] {
  current.leases = new Map(rows.map(row => [row.runId, row]));
  const unjoined = rows.filter(row => !hasJoinedReattachPhase(row.runId));
  const claimable = unjoined.map(row => claimableReattachRun(row, now)).filter((run): run is ClaimableReattachRun => run !== null);
  const joined = joinReattachPhase(claimable, {}, now);
  current.watching = unjoined.length > claimable.length;
  return joined;
}

async function claimJoinedRuns(current: ReattachWatch, joined: string[]): Promise<void> {
  if (joined.length === 0 || !current.claim || watch !== current || isProcessRunAdmissionClosed()) return;
  await current.claim(joined)
    .catch(error => logger.warn({ err: error, runIds: joined }, "reattach phase could not start the claim of handed-over runs"));
}

export function nextReattachLeaseDeadline(leases: Iterable<PreviousControllerRunLease>, now = Date.now()): number | null {
  let next: number | null = null;
  for (const row of leases) {
    if (hasJoinedReattachPhase(row.runId)) continue;
    const at = row.leaseExpiresAt?.getTime();
    if (at === undefined || at <= now) continue;
    if (next === null || at < next) next = at;
  }
  return next;
}

async function reconcileReattachWatch(current: ReattachWatch): Promise<void> {
  if (watch !== current) return;
  if (!current.initialized) {
    current.notified = false;
    let rows: PreviousControllerRunLease[];
    try {
      rows = await listPreviousControllerRunLeases(current.db, current.bootId);
    } catch (error) {
      current.notified = true;
      throw error;
    }
    if (watch !== current) return;
    current.initialized = true;
    if (rows.length === 0) reportNothingToReattach();
    else {
      await claimJoinedRuns(current, observeLeases(current, rows));
      logger.info({ liveRuns: rows.length, claimableNow: rows.filter(row => hasJoinedReattachPhase(row.runId)).length },
        "reattach phase watching live runs of a previous server: new run starts are held only once they become claimable");
    }
  } else if (current.watching || current.notified) {
    current.notified = false;
    let rows: PreviousControllerRunLease[];
    try {
      rows = await listPreviousControllerRunLeases(current.db, current.bootId);
    } catch (error) {
      current.notified = true;
      throw error;
    }
    if (watch !== current) return;
    await claimJoinedRuns(current, observeLeases(current, rows));
  }
  if (pendingReattachRunIds().length > 0) await settleFinishedReattachRuns(current.db);
}

export function noteReattachRunsClaimed(runIds: readonly string[], now = Date.now()): void {
  const current = watch;
  if (!current || !isReattachPhaseEnabled()) return;
  const joined = joinReattachPhase(runIds.map(runId => {
    const observed = current.leases.get(runId);
    const claimable = observed ? claimableReattachRun(observed, now) : null;
    return claimable ?? { runId, reason: "owner_gone" as const, claimableAt: now };
  }), { announce: false }, now);
  if (joined.length === 0) return;
  current.worker?.wake();
  void classifyClaimedRuns(current, joined, now)
    .catch(error => logger.warn({ err: error }, "reattach phase could not read how claimed runs were released"))
    .finally(() => announceReattachPhase(joined));
}

type RecoveryHistoryEntry = { at?: unknown; disposition?: unknown; controllerBootId?: unknown };

export function handOverMoment(history: readonly RecoveryHistoryEntry[], bootId: string): number | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.controllerBootId === bootId) continue;
    if (entry?.disposition !== "restart_suspended" || typeof entry.at !== "string") return null;
    const at = Date.parse(entry.at);
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

async function classifyClaimedRuns(current: ReattachWatch, runIds: string[], now: number): Promise<void> {
  const rows = await current.db.select({ runId: nativeRunFinalizations.runId, history: nativeRunFinalizations.recoveryHistory })
    .from(nativeRunFinalizations).where(inArray(nativeRunFinalizations.runId, runIds));
  refineReattachClaimable(rows.flatMap(row => {
    const at = handOverMoment(Array.isArray(row.history) ? row.history as RecoveryHistoryEntry[] : [], current.bootId);
    return at === null ? [] : [{ runId: row.runId, reason: "handed_over" as const, claimableAt: at }];
  }), now);
}

export function registerReattachPhaseWork(
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  db: Db,
  options: {
    capMs?: number;
    recheckMs?: number;
    bootId?: string;
    onEnd?: Parameters<typeof onReattachPhaseEnd>[0];
    claim?: (runIds: string[]) => Promise<unknown>;
  } = {},
): ReattachWorker | null {
  const capMs = options.capMs ?? reattachPhaseCapMs();
  if (capMs <= 0) return null;
  if (watch) void stopReattachWatch();
  enableReattachPhase(capMs);
  const current: ReattachWatch = { db, bootId: options.bootId ?? currentControllerBootId(), initialized: false,
    notified: false, watching: false, leases: new Map(), worker: null, claim: options.claim,
    stopListening: options.onEnd ? onReattachPhaseEnd(options.onEnd) : () => undefined };
  watch = current;
  const release = () => {
    if (watch !== current) return;
    watch = null;
    current.stopListening();
  };
  current.worker = coordinator.register(DELIVERY_QUEUES.reattachPhase, {
    retryMs: options.recheckMs ?? REATTACH_PHASE_RECHECK_MS,
    run: () => reconcileReattachWatch(current),
    hasPending: async () => watch === current && pendingReattachRunIds().length > 0,
    nextRunAt: () => watch === current && current.watching ? nextReattachLeaseDeadline(current.leases.values()) : null,
    onSettled: () => { current.notified = true; },
    onStop: release,
  });
  return current.worker;
}

export async function stopReattachWatch(): Promise<void> {
  const current = watch;
  if (!current) return;
  watch = null;
  current.stopListening();
  await current.worker?.stop();
}
