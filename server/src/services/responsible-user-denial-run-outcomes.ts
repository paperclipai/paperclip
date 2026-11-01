import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  isResponsibleUserDenialCode,
  type ResponsibleUserDenialCode,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

/**
 * The run id comes from a caller-supplied header, so a remembered denial is
 * keyed by the run id together with the agent and company that reported it.
 * Finalization of a run owned by anyone else never observes it, and a caller
 * that supplies another agent's run id writes its own entry instead of
 * replacing the owner's one.
 */
export interface ResponsibleUserDenialRunOwner {
  agentId: string;
  companyId: string;
}

const pendingResponsibleUserDenialsByRunKey = new Map<
  string,
  ResponsibleUserDenialCode
>();

function rememberedDenialKey(runId: string, owner: ResponsibleUserDenialRunOwner) {
  return JSON.stringify([owner.companyId.trim(), owner.agentId.trim(), runId.trim()]);
}

/**
 * Upper bound on remembered denials. The run id comes from the caller, so the
 * map must not grow without limit when a run never reaches finalization; the
 * oldest entries are evicted first. Entries exist only between a failed durable
 * write and that run's finalization, so the bound is never reached in practice.
 */
export const MAX_REMEMBERED_RESPONSIBLE_USER_DENIALS = 1024;

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  owner: ResponsibleUserDenialRunOwner,
): ResponsibleUserDenialCode | null {
  const normalizedRunId = runId.trim();
  const normalizedCode = normalizeResponsibleUserDenialCode(code);
  const agentId = owner.agentId.trim();
  const companyId = owner.companyId.trim();
  if (!RUN_ID_PATTERN.test(normalizedRunId) || !normalizedCode || !agentId || !companyId) {
    return null;
  }
  const key = rememberedDenialKey(normalizedRunId, { agentId, companyId });
  pendingResponsibleUserDenialsByRunKey.delete(key);
  while (pendingResponsibleUserDenialsByRunKey.size >= MAX_REMEMBERED_RESPONSIBLE_USER_DENIALS) {
    const oldest = pendingResponsibleUserDenialsByRunKey.keys().next().value;
    if (oldest === undefined) break;
    pendingResponsibleUserDenialsByRunKey.delete(oldest);
  }
  pendingResponsibleUserDenialsByRunKey.set(key, normalizedCode);
  return normalizedCode;
}

export function getRememberedResponsibleUserDenialForRun(run: {
  id: string;
  agentId: string;
  companyId: string;
}): ResponsibleUserDenialCode | null {
  return pendingResponsibleUserDenialsByRunKey.get(rememberedDenialKey(run.id, run)) ?? null;
}

export function clearRememberedResponsibleUserDenialForRun(run: {
  id: string;
  agentId: string;
  companyId: string;
}): boolean {
  return pendingResponsibleUserDenialsByRunKey.delete(rememberedDenialKey(run.id, run));
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
