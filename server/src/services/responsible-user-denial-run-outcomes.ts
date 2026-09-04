import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  isResponsibleUserDenialCode,
  type ResponsibleUserDenialCode,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

const pendingResponsibleUserDenialCodesByRunId = new Map<
  string,
  ResponsibleUserDenialCode
>();

export function normalizeResponsibleUserDenialCode(
  code: unknown,
): ResponsibleUserDenialCode | null {
  return typeof code === "string" && isResponsibleUserDenialCode(code) ? code : null;
}

/**
 * Keep a process-local fail-closed signal until heartbeat finalization makes the
 * run terminal. The database marker remains the durable source of truth; this
 * signal covers a transient write failure in the request handler without
 * terminalizing the run before the finalizer can settle its wakeup and locks.
 *
 * Process-local scope is sufficient here, and deliberately so:
 *
 * - The denial request and the finalizer share a process. The heartbeat service
 *   is constructed inside the API server (`heartbeatService(db)` in
 *   `server/src/index.ts`), so the adapter child and the HTTP handler that
 *   answers its Paperclip call always live in the same Node process. There is no
 *   clustered or split-worker deployment to straddle.
 * - A process restart cannot reach the zero-exit success path at all. Restarting
 *   kills the in-process adapter child, so no exit code is ever observed;
 *   the stale-lock sweep terminalizes the surviving `running` row as
 *   `interrupted` with `orphaned_running_run`, never as `succeeded`.
 * - When the durable marker cannot be written because the database itself is
 *   unavailable, the finalizer's own status write fails for the same reason, so
 *   the run does not become terminal-successful either. Any signal that
 *   outlived that outage would have to live outside the database, which is a
 *   different design decision than this fix.
 */
export function rememberResponsibleUserDenialForRun(
  runId: string,
  code: unknown,
): ResponsibleUserDenialCode | null {
  const normalizedRunId = runId.trim();
  const normalizedCode = normalizeResponsibleUserDenialCode(code);
  if (!normalizedRunId || !normalizedCode) return null;
  pendingResponsibleUserDenialCodesByRunId.set(normalizedRunId, normalizedCode);
  return normalizedCode;
}

export function getRememberedResponsibleUserDenialForRun(
  runId: string,
): ResponsibleUserDenialCode | null {
  return pendingResponsibleUserDenialCodesByRunId.get(runId.trim()) ?? null;
}

export function clearRememberedResponsibleUserDenialForRun(
  runId: string,
): boolean {
  return pendingResponsibleUserDenialCodesByRunId.delete(runId.trim());
}

export async function recordResponsibleUserDenialOnActiveRun(
  db: Db,
  input: {
    runId?: string | null;
    agentId?: string | null;
    companyId?: string | null;
    code: unknown;
  },
) {
  const runId = input.runId?.trim();
  const code = normalizeResponsibleUserDenialCode(input.code);
  if (!runId || !code) return null;

  const conditions = [
    eq(heartbeatRuns.id, runId),
    inArray(heartbeatRuns.status, ["queued", "running"]),
  ];
  if (input.agentId) conditions.push(eq(heartbeatRuns.agentId, input.agentId));
  if (input.companyId) conditions.push(eq(heartbeatRuns.companyId, input.companyId));

  const updated = await db
    .update(heartbeatRuns)
    .set({
      errorCode: code,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning()
    .then((rows) => rows[0] ?? null);

  if (!updated) return null;

  publishLiveEvent({
    companyId: updated.companyId,
    type: "heartbeat.run.status",
    payload: {
      runId: updated.id,
      agentId: updated.agentId,
      status: updated.status,
      invocationSource: updated.invocationSource,
      triggerDetail: updated.triggerDetail,
      error: updated.error ?? null,
      errorCode: updated.errorCode ?? null,
      startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
      finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
    },
  });

  logger.info(
    {
      runId: updated.id,
      agentId: updated.agentId,
      companyId: updated.companyId,
      errorCode: code,
    },
    "recorded responsible-user denial code on active heartbeat run",
  );

  return updated;
}
