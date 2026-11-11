import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";

/**
 * Durable, bounded publication of an accepted native task reply.
 *
 * The status decision for an accepted result commits independently of the
 * final reply comment. When publication is refused or fails, the attempt is
 * recorded on the run and retried with backoff. Exhausted retries leave a
 * named failure with an owner on the run and the task instead of a silent
 * done. The comment write itself stays idempotent through the presentation
 * decision's `commentId`, so retries never double-post.
 */
export const NATIVE_RESPONSE_PUBLICATION_SCHEMA = "paperclip.native_response_publication.v1";
export const NATIVE_RESPONSE_PUBLICATION_FAILED = "native_response_publication_failed";
export const NATIVE_RESPONSE_PUBLICATION_MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 300_000;

export type NativeResponsePublicationReason = "publication_refused" | "publication_error";

type Receipt = {
  schema: typeof NATIVE_RESPONSE_PUBLICATION_SCHEMA;
  state: "retrying" | "failed" | "resolved";
  attempts: number;
  firstAttemptAt: string;
  lastAttemptAt: string;
  lastReason: NativeResponsePublicationReason;
  lastError?: string | null;
  nextAttemptAt?: string | null;
  reasonCode?: string;
  owner?: { kind: "agent"; agentId: string };
  failedAt?: string;
  resolvedAt?: string;
};

export function nativeResponsePublicationDelayMs(attempts: number) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

function readReceipt(resultJson: unknown): Receipt | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  const receipt = (resultJson as Record<string, unknown>).responsePublication;
  return receipt && typeof receipt === "object" ? receipt as Receipt : null;
}

function errorText(error: unknown) {
  if (!error) return null;
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500);
}

function patchReceipt(tx: Db, runId: string, receipt: Receipt) {
  // Never overwrite a materialized reply's run record with retry bookkeeping.
  return tx.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
      || jsonb_build_object('responsePublication', ${JSON.stringify(receipt)}::jsonb)`,
    updatedAt: new Date(),
  }).where(and(eq(heartbeatRuns.id, runId),
    sql`jsonb_typeof(${heartbeatRuns.resultJson} #> '{presentationDecision,commentId}') is distinct from 'string'`))
    .returning({ id: heartbeatRuns.id });
}

/** Record one unsuccessful attempt. Returns the next due time, or null once
 * the bounded retry is exhausted and the failure has been recorded. */
export async function recordNativeResponsePublicationAttempt(db: Db, input: {
  companyId: string; issueId: string; runId: string;
  reason: NativeResponsePublicationReason; error?: unknown;
}): Promise<{ state: "retrying"; nextAttemptAt: number } | { state: "failed" } | null> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [run] = await tx.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
      .for("update");
    if (!run) return null;
    const previous = readReceipt(run.resultJson);
    if (previous?.state === "failed") return { state: "failed" as const };
    const now = new Date();
    // Another worker already counted this due attempt and saved the next
    // deadline. Keep its schedule instead of counting the attempt twice.
    const scheduled = previous?.state === "retrying" && previous.nextAttemptAt ? Date.parse(previous.nextAttemptAt) : NaN;
    if (Number.isFinite(scheduled) && scheduled > now.getTime()) return { state: "retrying" as const, nextAttemptAt: scheduled };
    const attempts = (previous?.state === "retrying" ? previous.attempts : 0) + 1;
    const base = {
      schema: NATIVE_RESPONSE_PUBLICATION_SCHEMA as typeof NATIVE_RESPONSE_PUBLICATION_SCHEMA,
      attempts,
      firstAttemptAt: previous?.state === "retrying" ? previous.firstAttemptAt : now.toISOString(),
      lastAttemptAt: now.toISOString(),
      lastReason: input.reason,
      lastError: errorText(input.error),
    };
    if (attempts < NATIVE_RESPONSE_PUBLICATION_MAX_ATTEMPTS) {
      const nextAttemptAt = new Date(now.getTime() + nativeResponsePublicationDelayMs(attempts));
      const [updated] = await patchReceipt(tx, run.id, { ...base, state: "retrying", nextAttemptAt: nextAttemptAt.toISOString() });
      if (!updated) return null;
      await appendHeartbeatRunEvent(tx, {
        companyId: input.companyId, runId: run.id, agentId: run.agentId,
        eventType: "run.response_publication.retrying", stream: "system", level: "warn",
        message: `Final reply publication ${input.reason === "publication_error" ? "failed" : "was refused"}; retry ${attempts + 1} of ${NATIVE_RESPONSE_PUBLICATION_MAX_ATTEMPTS} is scheduled`,
        payload: { attempts, reason: input.reason, nextAttemptAt: nextAttemptAt.toISOString() },
      });
      return { state: "retrying" as const, nextAttemptAt: nextAttemptAt.getTime() };
    }
    const owner = { kind: "agent" as const, agentId: run.agentId };
    const [updated] = await patchReceipt(tx, run.id, { ...base, state: "failed", nextAttemptAt: null,
      reasonCode: NATIVE_RESPONSE_PUBLICATION_FAILED, owner, failedAt: now.toISOString() });
    if (!updated) return null;
    await appendHeartbeatRunEvent(tx, {
      companyId: input.companyId, runId: run.id, agentId: run.agentId,
      eventType: "run.response_publication.failed", stream: "system", level: "error",
      message: `The accepted final reply could not be published to the task after ${attempts} attempts`,
      payload: { reasonCode: NATIVE_RESPONSE_PUBLICATION_FAILED, attempts, lastReason: input.reason, owner },
    });
    await logActivity(tx, {
      companyId: input.companyId, actorType: "system", actorId: "native-response-publication",
      action: "issue.response_publication_failed", entityType: "issue", entityId: input.issueId,
      agentId: run.agentId, runId: run.id,
      details: { runId: run.id, reasonCode: NATIVE_RESPONSE_PUBLICATION_FAILED, attempts, lastReason: input.reason,
        lastError: base.lastError, owner },
    });
    return { state: "failed" as const };
  });
}

/** JSON object to merge into `result_json` in the same write that records a
 * published reply's `commentId`. It settles an open retry receipt atomically
 * with publication, and is empty when no retry is open. */
export function settledResponsePublicationSql() {
  return sql`(case when ${heartbeatRuns.resultJson} #>> '{responsePublication,state}' = 'retrying'
    then jsonb_build_object('responsePublication', ((${heartbeatRuns.resultJson} -> 'responsePublication') - 'nextAttemptAt')
      || jsonb_build_object('state', 'resolved', 'resolvedAt', ${new Date().toISOString()}::text))
    else '{}'::jsonb end)`;
}
