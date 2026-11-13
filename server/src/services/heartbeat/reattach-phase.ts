import { and, eq, inArray, isNotNull, isNull, ne, notLike, or } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { currentControllerBootId } from "../controller-process-identity.js";
import {
  announceReattachPhase,
  enableReattachPhase,
  hasJoinedReattachPhase,
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
export const REATTACH_PHASE_REFRESH_MS = 2_000;

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

type ReattachWatch = {
  db: Db;
  bootId: string;
  refreshMs: number;
  watching: boolean;
  leases: Map<string, PreviousControllerRunLease>;
  timer: ReturnType<typeof setInterval> | null;
  refreshing: boolean;
  stopListening: () => void;
};

let watch: ReattachWatch | null = null;

function observeLeases(current: ReattachWatch, rows: PreviousControllerRunLease[], now = Date.now()): void {
  current.leases = new Map(rows.map(row => [row.runId, row]));
  const unjoined = rows.filter(row => !hasJoinedReattachPhase(row.runId));
  const claimable = unjoined.map(row => claimableReattachRun(row, now)).filter((run): run is ClaimableReattachRun => run !== null);
  joinReattachPhase(claimable, {}, now);
  current.watching = unjoined.length > claimable.length;
}

async function refreshReattachWatch(current: ReattachWatch): Promise<void> {
  if (current.watching) observeLeases(current, await listPreviousControllerRunLeases(current.db, current.bootId));
  await settleFinishedReattachRuns(current.db);
  if (!current.watching && pendingReattachRunIds().length === 0) stopRefreshing(current);
}

function startRefreshing(current: ReattachWatch): void {
  if (current.timer || watch !== current) return;
  current.timer = setInterval(() => {
    if (current.refreshing) return;
    current.refreshing = true;
    void refreshReattachWatch(current)
      .catch(error => logger.warn({ err: error }, "reattach phase refresh failed"))
      .finally(() => { current.refreshing = false; });
  }, current.refreshMs);
  current.timer.unref?.();
}

function stopRefreshing(current: ReattachWatch): void {
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
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
  startRefreshing(current);
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

export function startReattachPhase(db: Db, options: {
  capMs?: number;
  refreshMs?: number;
  bootId?: string;
  onEnd?: Parameters<typeof onReattachPhaseEnd>[0];
} = {}): Promise<void> {
  const capMs = options.capMs ?? reattachPhaseCapMs();
  if (capMs <= 0) return Promise.resolve();
  if (watch) stopReattachWatch();
  enableReattachPhase(capMs);
  const current: ReattachWatch = { db, bootId: options.bootId ?? currentControllerBootId(),
    refreshMs: options.refreshMs ?? REATTACH_PHASE_REFRESH_MS, watching: false, leases: new Map(), timer: null,
    refreshing: false, stopListening: options.onEnd ? onReattachPhaseEnd(options.onEnd) : () => undefined };
  watch = current;
  return (async () => {
    let rows: PreviousControllerRunLease[];
    try {
      rows = await listPreviousControllerRunLeases(db, current.bootId);
    } catch (error) {
      logger.warn({ err: error }, "reattach phase could not list live runs of a previous server; only runs this server claims are tracked");
      return;
    }
    if (watch !== current) return;
    if (rows.length === 0) {
      reportNothingToReattach();
      return;
    }
    observeLeases(current, rows);
    logger.info({ liveRuns: rows.length, claimableNow: rows.filter(row => hasJoinedReattachPhase(row.runId)).length },
      "reattach phase watching live runs of a previous server: new run starts are held only once they become claimable");
    if (current.watching || pendingReattachRunIds().length > 0) startRefreshing(current);
  })();
}

export function stopReattachWatch(): void {
  if (!watch) return;
  stopRefreshing(watch);
  watch.stopListening();
  watch = null;
}
