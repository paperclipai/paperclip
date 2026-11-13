import { and, eq, inArray, isNotNull, isNull, ne, notLike, or } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { currentControllerBootId } from "../controller-process-identity.js";
import {
  failReattachDiscovery,
  onReattachPhaseEnd,
  openReattachPhase,
  pendingReattachRunIds,
  settleReattachRun,
  trackReattachRuns,
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

export async function listLiveRunsOwnedByPreviousControllers(db: Db, bootId = currentControllerBootId()): Promise<string[]> {
  const rows = await db.select({ runId: heartbeatRuns.id })
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
  return [...new Set(rows.map(row => row.runId))];
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

export function startReattachPhase(db: Db, options: {
  capMs?: number;
  refreshMs?: number;
  bootId?: string;
  onEnd?: Parameters<typeof onReattachPhaseEnd>[0];
} = {}): Promise<void> {
  const capMs = options.capMs ?? reattachPhaseCapMs();
  if (capMs <= 0) return Promise.resolve();
  openReattachPhase(capMs);
  let refresher: ReturnType<typeof setInterval> | null = null;
  let refreshing = false;
  const stopListening = onReattachPhaseEnd(summary => {
    if (refresher) clearInterval(refresher);
    stopListening();
    options.onEnd?.(summary);
  });
  return (async () => {
    let runIds: string[];
    try {
      runIds = await listLiveRunsOwnedByPreviousControllers(db, options.bootId);
    } catch (error) {
      logger.warn({ err: error }, "reattach phase could not list live runs; new run starts are not held");
      failReattachDiscovery();
      return;
    }
    trackReattachRuns(runIds);
    if (pendingReattachRunIds().length === 0) return;
    refresher = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void settleFinishedReattachRuns(db)
        .catch(error => logger.warn({ err: error }, "reattach phase refresh failed"))
        .finally(() => { refreshing = false; });
    }, options.refreshMs ?? REATTACH_PHASE_REFRESH_MS);
    refresher.unref?.();
  })();
}
