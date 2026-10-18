import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getServerAdapter } from "../adapters/registry.js";
import { persistUsageReceipt, type UsageReceiptEnvelope } from "./usage-receipts.js";
import { logger } from "../middleware/logger.js";

const terminalStatuses = ["succeeded", "failed", "timed_out", "cancelled", "interrupted"] as const;
const recoverableStatuses = ["failed", "timed_out", "cancelled", "interrupted"] as const;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export type SessionUsageRecoveryResult =
  | { recovered: true; runId: string; reason: null }
  | { recovered: false; runId: string; reason: SessionUsageRecoverySkipReason };
export type SessionUsageRecoverySkipReason =
  | "run_not_found"
  | "run_not_terminal"
  | "run_not_pending"
  | "already_accounted"
  | "receipt_already_ready"
  | "capture_failed"
  | "provider_work_not_started"
  | "native_coordinator_open"
  | "grace_pending"
  | "no_session_ref"
  | "no_receipt_source"
  | "adapter_recovery_unavailable"
  | "nothing_recovered"
  | "recovered_usage_regressed"
  | "recovery_error";

const RECOVERY_GRACE_MS = 60_000;

/** A terminal run interrupted before its final adapter receipt (operator stop,
 * graceful server shutdown, timeout, crash) keeps its durable usage
 * checkpoints, but its last receipt is incomplete so cost accounting waits for
 * a final receipt that will never arrive. When the adapter keeps a durable
 * session record (the Pi session JSONL for pi_local), the completed turns'
 * usage can still be recovered from it and committed as the run's final
 * receipt. Cost settlement stays in `accountRunCost`: it writes the cost event
 * and acknowledges the run in the same transaction, so the ledger receipt and
 * the run receipt can never disagree. */
export async function recoverInterruptedRunUsageFromSession(
  db: Db,
  input: { companyId: string; runId: string },
  options: { now?: Date; graceMs?: number } = {},
): Promise<SessionUsageRecoveryResult> {
  const { companyId, runId } = input;
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? RECOVERY_GRACE_MS;
  const skip = (reason: SessionUsageRecoverySkipReason): SessionUsageRecoveryResult => ({ recovered: false, runId, reason });

  let row: { run: typeof heartbeatRuns.$inferSelect; adapterType: string } | undefined;
  try {
    [row] = await db
      .select({ run: heartbeatRuns, adapterType: agents.adapterType })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  } catch (error) {
    logger.error({ err: error, runId }, "Session usage recovery failed to read the run");
    return skip("recovery_error");
  }
  if (!row) return skip("run_not_found");
  const { run, adapterType } = row;
  if (!terminalStatuses.includes(run.status as (typeof terminalStatuses)[number])) return skip("run_not_terminal");
  if (run.costAccountedAt) return skip("already_accounted");
  if (!run.costAccountingPending) return skip("run_not_pending");

  const usage = object(run.usageJson);
  if (usage.accountingCaptureFailed === true) return skip("capture_failed");
  if (usage.accountingReceiptReady === true) return skip("receipt_already_ready");
  const resultJson = object(run.resultJson);
  const executionRecovery = object(resultJson.executionRecovery);
  if (executionRecovery.providerWorkStarted === false || usage.accountingProviderWorkStarted === false) {
    return skip("provider_work_not_started");
  }
  // A native coordinator that still owns the run can resume the same provider
  // work. Its own durable reconciliation owns the final receipt; recovering
  // underneath it would double-count the turns it re-drives.
  if (run.runtimeMode === "native") {
    const [coordinator] = await db
      .select({ resultId: nativeRunFinalizations.resultId, phase: nativeRunFinalizations.phase })
      .from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, run.id));
    if (coordinator && !coordinator.resultId && coordinator.phase !== "terminal_failure") {
      return skip("native_coordinator_open");
    }
  }
  const finishedAt = run.finishedAt ?? run.createdAt;
  if (graceMs > 0 && finishedAt && now.getTime() - finishedAt.getTime() < graceMs) {
    return skip("grace_pending");
  }

  const sessionRef = text(usage.accountingSessionRef);
  if (!sessionRef) return skip("no_session_ref");
  const sourceId = text(usage.accountingReceiptSourceId);
  if (!sourceId) return skip("no_receipt_source");

  const adapter = getServerAdapter(adapterType);
  const recoverSessionUsage = adapter?.recoverSessionUsage;
  if (!recoverSessionUsage) return skip("adapter_recovery_unavailable");

  let recovered;
  try {
    recovered = await recoverSessionUsage({
      sessionRef,
      from: run.startedAt,
      to: run.finishedAt,
    });
  } catch (error) {
    logger.warn({ err: error, runId, sessionRef }, "Session usage recovery hook failed");
    return skip("recovery_error");
  }
  if (!recovered) return skip("nothing_recovered");
  const recoveredUsage = recovered.usage ?? { inputTokens: 0, outputTokens: 0 };
  const recoveredTokens =
    (recoveredUsage.inputTokens ?? 0) + (recoveredUsage.cachedInputTokens ?? 0) + (recoveredUsage.outputTokens ?? 0);
  if (recoveredTokens === 0) return skip("nothing_recovered");

  // The recovered snapshot must cover at least what the live stream already
  // checkpointed. A session older than the run (resume with a stale file) or a
  // truncated session must never erase captured usage or a known price.
  if (
    (amount(usage.inputTokens) ?? 0) > (recoveredUsage.inputTokens ?? 0) ||
    (amount(usage.cachedInputTokens) ?? 0) > (recoveredUsage.cachedInputTokens ?? 0) ||
    (amount(usage.outputTokens) ?? 0) > (recoveredUsage.outputTokens ?? 0)
  ) {
    logger.warn({ runId, sessionRef }, "Recovered session usage regressed below the captured checkpoint; keeping the captured receipt pending");
    return skip("recovered_usage_regressed");
  }
  if (amount(usage.costUsd) !== null && amount(recovered.costUsd) === null) {
    logger.warn({ runId, sessionRef }, "Recovered session usage lost a known price; keeping the captured receipt pending");
    return skip("recovered_usage_regressed");
  }

  const envelope: UsageReceiptEnvelope = {
    schema: "paperclip/accounting-receipt/v1",
    id: randomUUID(),
    companyId,
    runId,
    sourceId,
    sequence: Number(usage.accountingReceiptSequence ?? 0) + 1,
    receivedAt: now.toISOString(),
    adapterType,
    receipt: {
      ...recovered,
      usage: recoveredUsage,
      usageBasis: "per_run",
      usageSource: "recovered_stream",
      sessionRef,
      complete: true,
    },
  };
  try {
    await persistUsageReceipt(db, envelope);
  } catch (error) {
    logger.warn({ err: error, runId, sessionRef }, "Recovered session usage receipt could not be persisted; retrying on the next sweep");
    return skip("recovery_error");
  }
  logger.info({ runId, sessionRef, inputTokens: recoveredUsage.inputTokens, outputTokens: recoveredUsage.outputTokens }, "Recovered interrupted run usage from the durable session record");
  return { recovered: true, runId, reason: null };
}

/** Sweep terminal runs whose final receipt never arrived and recover their
 * completed-turn usage from the adapter's durable session record. Bounded so a
 * large backlog cannot monopolize an accounting tick. */
export async function recoverPendingInterruptedRunUsage(
  db: Db,
  options: { now?: Date; graceMs?: number; limit?: number } = {},
): Promise<SessionUsageRecoveryResult[]> {
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? RECOVERY_GRACE_MS;
  const cutoff = new Date(now.getTime() - graceMs);
  const candidates = await db
    .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.costAccountingPending, true),
        isNull(heartbeatRuns.costAccountedAt),
        inArray(heartbeatRuns.status, [...recoverableStatuses]),
        sql`${heartbeatRuns.usageJson}->>'accountingReceiptReady' = 'false'`,
        sql`${heartbeatRuns.usageJson}->>'accountingCaptureFailed' is distinct from 'true'`,
        sql`${heartbeatRuns.usageJson}->>'accountingSessionRef' is not null`,
        sql`${heartbeatRuns.usageJson}->>'accountingProviderWorkStarted' is distinct from 'false'`,
        sql`${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted' is distinct from 'false'`,
        sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(heartbeatRuns.updatedAt), asc(heartbeatRuns.id))
    .limit(options.limit ?? 20);
  const results: SessionUsageRecoveryResult[] = [];
  for (const candidate of candidates) {
    results.push(
      await recoverInterruptedRunUsageFromSession(
        db,
        { companyId: candidate.companyId, runId: candidate.id },
        { now, graceMs },
      ),
    );
  }
  return results;
}
