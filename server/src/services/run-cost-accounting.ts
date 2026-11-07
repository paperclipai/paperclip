import { notifyStrandedAgentStatus } from "./live-run-recovery-notifications.js";
import { usdToUnits, unitsToCents } from "@paperclipai/shared";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { budgetReservations, agents, environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, issues, projects, decisionInvocations, promptInjectionInvocations, type Db } from "@paperclipai/db";
import { withOperationAccountingTransaction } from "./accounting-transaction.js";
import { withBudgetSpan } from "./budget-tracing.js";
import { conflict } from "../errors.js";
import { createCostEventInTransaction } from "./costs.js";
import type { BudgetServiceHooks } from "./budgets.js";
import { queueBudgetEvaluation } from "./budget-evaluation-work.js";
import { ensureRuntimeAccountingBaseline } from "./runtime-accounting-totals.js";
import { logger } from "../middleware/logger.js";
import { promises as fs } from "node:fs";
import { priceAnthropicReceipt } from "./anthropic-pricing.js";
import { priceCodexReceipt } from "./codex-pricing.js";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { replayUsageReceipts, indexPendingUsageReceipts, readPendingRunUsageReceipts, persistUsageReceiptInTransaction, reconcileLateRunUsageReceiptInTransaction, type UsageReceiptIndex } from "./usage-receipts.js";

const terminalStatuses = ["succeeded", "failed", "timed_out", "cancelled", "interrupted"];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** The source/closed-provider identity is captured before filesystem reads and
 * checked again after run arbitration. A newly closed/replaced source retries
 * rather than acknowledging evidence from an earlier spool snapshot. */
async function readAccountingClosure(db: Db, runId: string) {
  const [closure] = await db.select({
    sourceId: sql<unknown>`${heartbeatRuns.usageJson}->'accountingReceiptSourceId'`,
    sequence: sql<unknown>`${heartbeatRuns.usageJson}->'accountingReceiptSequence'`,
    receiptId: sql<unknown>`${heartbeatRuns.usageJson}->'accountingReceiptId'`,
    ready: sql<unknown>`${heartbeatRuns.usageJson}->'accountingReceiptReady'`,
    failed: sql<unknown>`${heartbeatRuns.usageJson}->'accountingCaptureFailed'`,
    runtimeMode: heartbeatRuns.runtimeMode,
    preProviderFailure: sql<boolean>`(${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted' = 'false'
      or ${heartbeatRuns.usageJson}->>'accountingProviderWorkStarted' = 'false') is true`,
    coordinatorId: nativeRunFinalizations.runId, resultId: nativeRunFinalizations.resultId, phase: nativeRunFinalizations.phase,
    processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
  }).from(heartbeatRuns).leftJoin(nativeRunFinalizations, and(
    eq(nativeRunFinalizations.runId, heartbeatRuns.id), eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
  )).where(eq(heartbeatRuns.id, runId));
  return closure;
}

/** Every remote allocation of the run carries a provider termination receipt
 * bound to that exact lease and run (mirrors hasRemoteTerminationReceipt): the
 * sandbox is stopped or destroyed, so no runner there can report usage. The
 * per-lease check uses "is not true": a missing receipt makes it NULL, which
 * must never count as proof. */
const remoteExecutionTerminated = sql`exists (select 1 from ${environmentLeases} remote_lease
    where remote_lease.company_id = ${heartbeatRuns.companyId} and remote_lease.heartbeat_run_id = ${heartbeatRuns.id})
  and not exists (select 1 from ${environmentLeases} remote_lease
    where remote_lease.company_id = ${heartbeatRuns.companyId} and remote_lease.heartbeat_run_id = ${heartbeatRuns.id}
      and (remote_lease.provider is not null and remote_lease.provider <> 'local'
        and remote_lease.provider_lease_id is not null and remote_lease.released_at is not null
        and remote_lease.cleanup_status = 'success' and remote_lease.status in ('released', 'expired', 'failed')
        and remote_lease.metadata->'remoteExecutionTermination'->>'schema' = 'paperclip.remote-termination.v1'
        and remote_lease.metadata->'remoteExecutionTermination'->>'companyId' = remote_lease.company_id::text
        and remote_lease.metadata->'remoteExecutionTermination'->>'runId' = remote_lease.heartbeat_run_id::text
        and remote_lease.metadata->'remoteExecutionTermination'->>'leaseId' = remote_lease.id::text
        and remote_lease.metadata->'remoteExecutionTermination'->>'provider' = remote_lease.provider
        and remote_lease.metadata->'remoteExecutionTermination'->>'providerLeaseId' = remote_lease.provider_lease_id
        and remote_lease.metadata->'remoteExecutionTermination'->>'state' in ('stopped', 'destroyed')) is not true)`;

/** A native run's receipt source is closed only with positive stop evidence,
 * after recovery ended in terminal failure without a result:
 * - Local: the run no longer records a process identity and its latest
 *   server-authored process event is the verified local stop. Only a failed
 *   run closes this way; a cancelled local run keeps its accounting drain,
 *   since Stop recovery can still reattach a recorder.
 * - Remote: every allocation has a termination receipt for its sandbox, so
 *   neither the original nor a reattached runner can report usage. That proof
 *   does not clear the recorded remote process identity.
 * Missing identity alone is never proof. One predicate serves the reconciler
 * scan and settlement so they cannot disagree. */
const closedNativeReceiptSource = sql`${heartbeatRuns.runtimeMode} = 'native'
  and exists (select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
    and ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
    and ${nativeRunFinalizations.resultId} is null and ${nativeRunFinalizations.phase} = 'terminal_failure')
  and ((${heartbeatRuns.status} = 'failed'
    and ${heartbeatRuns.processPid} is null and ${heartbeatRuns.processGroupId} is null
    and (select process_event.event_type from ${heartbeatRunEvents} process_event
      where process_event.company_id = ${heartbeatRuns.companyId} and process_event.run_id = ${heartbeatRuns.id}
        and process_event.source_event_id is null
        and process_event.event_type in ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped')
      order by process_event.seq desc limit 1) = 'native.local_process_stopped')
    or (${heartbeatRuns.status} in ('failed', 'cancelled', 'timed_out', 'interrupted') and ${remoteExecutionTerminated}))`;

async function nativeReceiptSourceClosed(db: Db, runId: string) {
  const [row] = await db.select({ closed: sql<boolean>`${closedNativeReceiptSource}` }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId));
  return row?.closed === true;
}

/** A receipt lost with its stopped provider still carries the usage observed
 * before the loss. When the model and token counts are known, price them from
 * the rate card as an estimate marked as a lower bound, instead of leaving
 * known numbers unpriced. Zero observed tokens stay unpriced: unknown is never
 * presented as zero cost. */
function estimateLostReceipt(usage: Record<string, unknown>) {
  const count = (key: string) => amount(usage[key]);
  const inputTokens = count("inputTokens") ?? 0, outputTokens = count("outputTokens") ?? 0;
  const cachedInputTokens = count("cachedInputTokens"), cacheWriteTokens = count("cacheWriteTokens");
  if (inputTokens + outputTokens + (cachedInputTokens ?? 0) <= 0) return null;
  if ((usage.usageSource ?? "per_run") !== "per_run") return null;
  // Aggregate totals across several models cannot take one model's rate.
  if (Array.isArray(usage.usageByModel) && usage.usageByModel.length > 0) return null;
  const billingType = text(usage.billingType);
  const priced = priceAnthropicReceipt(priceCodexReceipt({
    complete: true, usageBasis: "per_run", provider: text(usage.provider) ?? undefined,
    biller: text(usage.biller) ?? undefined, model: text(usage.model) ?? undefined,
    billingType: billingType === "metered_api" ? "api" : billingType ?? undefined,
    usage: { inputTokens, outputTokens,
      ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
      ...(cacheWriteTokens !== null ? { cacheWriteTokens } : {}) },
  } as AdapterUsageCheckpoint));
  const exact = text(priced.costUsdExact);
  if (exact === null || !priced.pricingProvenance) return null;
  const evidence = text(priced.pricingProvenance.evidence);
  return { costUsdExact: exact, pricingProvenance: { ...priced.pricingProvenance,
    evidence: [evidence, "final receipt lost; observed usage is a lower bound"].filter(Boolean).join("; ") } };
}

/** The run's persisted usage is a durable receipt. Ledger, reservation handoff
 * and acknowledgement commit together, including after a restart or failed run. */
export async function accountRunCost(db: Db, runId: string, hooks: BudgetServiceHooks = {}, receiptIndex?: UsageReceiptIndex) {
  const [identity] = await db.select({ companyId: heartbeatRuns.companyId, status: heartbeatRuns.status,
    pending: heartbeatRuns.costAccountingPending, accountedAt: heartbeatRuns.costAccountedAt,
    issueId: sql<string | null>`${heartbeatRuns.usageJson}->'ledgerScope'->>'issueId'`,
  }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!identity || !identity.pending || !terminalStatuses.includes(identity.status)) return false;
  // Finalization can call twice. Settled or active runs owe no accounting work.
  // Pending acknowledgements still receive the locked stale-marker cleanup.
  const index = identity.pending && !identity.accountedAt && terminalStatuses.includes(identity.status)
    ? receiptIndex ?? await indexPendingUsageReceipts() : undefined;
  const closure = await readAccountingClosure(db, runId);
  if (!closure) return false;
  if (!identity.accountedAt && closure.runtimeMode === "native" && !closure.preProviderFailure
    && closure.coordinatorId && !closure.resultId && closure.phase !== "terminal_failure") return false;
  const pendingReceipts = !identity.accountedAt
    ? await readPendingRunUsageReceipts({ companyId: identity.companyId, runId }, undefined, index) : [];
  let recoveredFiles: string[] = [];
  const accounted = await withBudgetSpan("budget.accounting.settlement", () => withOperationAccountingTransaction(db, identity.companyId, async (tx, publications) => {
    // The operation wrapper can retry a transaction PostgreSQL rolled back.
    // Never delete files imported only by an earlier, unsuccessful attempt.
    recoveredFiles = [];
    // Native recovery owns the issue before updating its run. Acquire the
    // charge's issue FK lock first so inserting it cannot reverse that order.
    const issueId = text(identity.issueId);
    if (issueId) await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, identity.companyId), eq(issues.id, issueId),
    )).for("key share");
    let [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
    if (!run?.costAccountingPending || !terminalStatuses.includes(run.status)) return false;
    if (run.costAccountedAt) {
      if (object(run.usageJson).accountingLateReceiptPending === true)
        return reconcileLateRunUsageReceiptInTransaction(tx, run, publications);
      await notifyStrandedAgentStatus(tx, { companyId: run.companyId, agentId: run.agentId });
      await tx.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, run.id));
      await queueBudgetEvaluation(tx, { companyId: run.companyId, agentId: run.agentId,
        projectId: text(object(object(run.usageJson).ledgerScope).projectId) });
      return false;
    }
    if (JSON.stringify(await readAccountingClosure(tx, runId)) !== JSON.stringify(closure))
      throw conflict("Run accounting closure changed during receipt recovery. Retry accounting.");
    for (const item of pendingReceipts) await persistUsageReceiptInTransaction(tx, item.envelope);
    recoveredFiles = pendingReceipts.map(item => item.file);
    [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (text(object(object(run.usageJson).ledgerScope).issueId) !== issueId) {
      throw conflict("Run cost attribution changed. Retry accounting.");
    }
    // A failed capture may follow an older complete attempt. Neither replay
    // nor terminal status can certify that the missing work was free.
    if (object(run.usageJson).accountingCaptureFailed === true) return false;
    const preProviderFailure = object(object(run.resultJson).executionRecovery).providerWorkStarted === false
      || object(run.usageJson).accountingProviderWorkStarted === false;
    // A failed native turn is not necessarily the end of this heartbeat: the
    // coordinator can resume the same run. Only its closed provider boundary
    // authorizes acknowledgement; finalization may still run after a result.
    if (run.runtimeMode === "native" && !preProviderFailure) {
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
      if (coordinator && !coordinator.resultId && coordinator.phase !== "terminal_failure") return false;
    }
    // A stop can mark the run terminal before the provider's shutdown receipt
    // arrives. Keep the debt pending instead of acknowledging an invented zero
    // and permanently discarding that late receipt. Once native recovery has
    // given up and the provider process is verified stopped, no producer can
    // deliver it: settle the known part as unpriced usage. A later receipt
    // still posts through late-receipt reconciliation.
    const receiptUnavailable = !preProviderFailure && object(run.usageJson).accountingReceiptReady === false;
    if (receiptUnavailable && !(await nativeReceiptSourceClosed(tx, run.id))) return false;
    if (!preProviderFailure) await ensureRuntimeAccountingBaseline(tx, run.companyId, run.agentId);
    // Acknowledgement is part of the same transaction. Budget checks inside
    // this transaction must not mistake this receipt for missing accounting.
    await notifyStrandedAgentStatus(tx, { companyId: run.companyId, agentId: run.agentId });
    await tx.update(heartbeatRuns).set({ costAccountingPending: false, costAccountedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await tx.update(budgetReservations).set({ state: preProviderFailure ? "released" : "settled", settledAt: new Date() })
      .where(and(eq(budgetReservations.companyId, run.companyId), eq(budgetReservations.runId, run.id), eq(budgetReservations.state, "held")));
    if (preProviderFailure) {
      await queueBudgetEvaluation(tx, { companyId: run.companyId, agentId: run.agentId,
        projectId: text(object(object(run.usageJson).ledgerScope).projectId) });
      return true;
    }
    const usage = object(run.usageJson);
    const scope = object(usage.ledgerScope);
    // Deleted attribution targets become unallocated; a deletion must never
    // prevent recording provider spend. Foreign-company references still fail.
    for (const [table, key] of [[issues, "issueId"], [projects, "projectId"]] as const) {
      const id = text(scope[key]);
      if (id) {
        const [linked] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id));
        if (!linked) scope[key] = null;
      }
    }
    const knownCostUsd = amount(usage.cacheAdjustedCostUsd) ?? text(usage.costUsdExact) ?? amount(usage.costUsd);
    const lostReceiptEstimate = receiptUnavailable && knownCostUsd === null ? estimateLostReceipt(usage) : null;
    const costUsd = knownCostUsd ?? lostReceiptEstimate?.costUsdExact ?? null;
    const billingType = text(usage.billingType) ?? "unknown";
    const costUnits = billingType === "subscription_included" ? 0n : usdToUnits(costUsd ?? 0);
    const costCents = unitsToCents(costUnits);
    const [agent] = await tx.select({ adapterType: agents.adapterType }).from(agents).where(eq(agents.id, run.agentId));
    const hasBillableEvidence = agent?.adapterType !== "process" || costUsd !== null || usage.costStatus === "unpriced"
      || ["inputTokens", "cachedInputTokens", "outputTokens"].some(key => (amount(usage[key]) ?? 0) > 0)
      || (text(usage.provider) !== null && usage.provider !== "unknown");
    const receipt = {
      idempotencyKey: `heartbeat:${run.id}:final`,
      agentId: run.agentId, heartbeatRunId: run.id,
      issueId: text(scope.issueId), projectId: text(scope.projectId), billingCode: text(scope.billingCode),
      provider: text(usage.provider) ?? "unknown", biller: text(usage.biller) ?? text(usage.provider) ?? "unknown",
      providerRequestId: text(usage.providerRequestId),
      pricingProvenance: lostReceiptEstimate?.pricingProvenance ?? object(usage.pricingProvenance),
      model: text(usage.model) ?? "unknown", billingType,
      costStatus: lostReceiptEstimate ? "estimated" : (costUsd === null || usage.costStatus === "unpriced" || receiptUnavailable) && billingType !== "subscription_included" && hasBillableEvidence ? "unpriced" : usage.costStatus === "estimated" ? "estimated" : "reported",
      inputTokens: amount(usage.inputTokens) ?? 0, cachedInputTokens: amount(usage.cachedInputTokens) ?? 0, outputTokens: amount(usage.outputTokens) ?? 0,
      costCents, occurredAt: run.finishedAt ?? run.createdAt,
    };
    const parts = Array.isArray(usage.usageByModel) ? usage.usageByModel.map(object) : [];
    const tokensMatch = ["inputTokens", "cachedInputTokens", "outputTokens"].every((key) =>
      parts.reduce((sum, part) => sum + (amount(object(part.usage)[key]) ?? 0), 0) === (amount(usage[key]) ?? 0));
    const costMatches = costUsd !== null && parts.reduce((sum, part) => sum + usdToUnits(amount(part.costUsd) ?? 0), 0n) === usdToUnits(costUsd);
    const validParts = parts.length > 0 && tokensMatch && costMatches
      && parts.every((part) => text(part.model) && amount(part.costUsd) !== null)
      && new Set(parts.map((part) => part.model)).size === parts.length;
    if (validParts) {
      let allocated = 0n;
      for (const [index, part] of parts.entries()) {
        const partUsage = object(part.usage);
        const remainder = costUnits - allocated;
        const reported = usdToUnits(amount(part.costUsd) ?? 0);
        const partUnits = billingType === "subscription_included" ? 0n : index === parts.length - 1 ? remainder : reported < remainder ? reported : remainder;
        allocated += partUnits;
        const partCents = unitsToCents(partUnits);
        await createCostEventInTransaction(tx, run.companyId, {
          ...receipt, idempotencyKey: `heartbeat:${run.id}:model:${index}`, model: text(part.model)!,
          inputTokens: amount(partUsage.inputTokens) ?? 0, cachedInputTokens: amount(partUsage.cachedInputTokens) ?? 0,
          outputTokens: amount(partUsage.outputTokens) ?? 0, costCents: partCents,
        }, publications, undefined, { deferBudgetEvaluation: true });
      }
    } else {
      await createCostEventInTransaction(tx, run.companyId, receipt, publications, undefined, { deferBudgetEvaluation: true });
    }
    await queueBudgetEvaluation(tx, { companyId: run.companyId, agentId: run.agentId, projectId: text(scope.projectId) });
    // Late usage reported by a later run can arrive before this charge posts.
    const lateDebt = usage.accountingLateReceiptPending === true;
    await tx.update(heartbeatRuns).set({ costAccountingPending: lateDebt, costAccountedAt: new Date(), accountingProjectionVersion: "v2",
      accountingLastError: lateDebt ? "late_usage_requires_reconciliation" : null, accountingLastAttemptAt: new Date(),
      // A complete receipt arriving later may price this charge (see usage-receipts).
      ...(receiptUnavailable ? { usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({
        accountingReceiptUnavailable: true,
        // Late reconciliation measures a later receipt from the accepted money.
        ...(lostReceiptEstimate ? { costUsdExact: lostReceiptEstimate.costUsdExact, costStatus: "estimated",
          pricingProvenance: lostReceiptEstimate.pricingProvenance } : {}),
      })}::jsonb` } : {}),
    }).where(eq(heartbeatRuns.id, run.id));
    return true;
  }), { "budget.accounting.owner": "run" });
  for (const file of recoveredFiles) {
    try { await fs.rm(file, { force: true }); }
    catch (error) { logger.warn({ err: error, runId }, "Accounting committed; recovered receipt cleanup will retry"); }
  }
  return accounted;
}

function actionableRunAccounting() {
  return and(
    eq(heartbeatRuns.costAccountingPending, true), inArray(heartbeatRuns.status, terminalStatuses),
    or(and(sql`${heartbeatRuns.costAccountedAt} is not null`,
      or(sql`${heartbeatRuns.usageJson}->>'accountingLateReceiptPending' is distinct from 'true'`,
        sql`${heartbeatRuns.usageJson}->>'accountingLateReceiptId' is distinct from ${heartbeatRuns.usageJson}->>'accountingLateReceiptAttemptedId'`)), and(
      sql`${heartbeatRuns.costAccountedAt} is null`,
      sql`${heartbeatRuns.usageJson}->>'accountingCaptureFailed' is distinct from 'true'`,
      sql`(${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted' = 'false'
        or ${heartbeatRuns.usageJson}->>'accountingProviderWorkStarted' = 'false'
        or not exists (select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
        and ${heartbeatRuns.runtimeMode} = 'native' and ${nativeRunFinalizations.resultId} is null
        and ${nativeRunFinalizations.phase} <> 'terminal_failure'))`,
      sql`(${heartbeatRuns.usageJson}->>'accountingReceiptReady' is distinct from 'false' or ${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted' = 'false' or ${heartbeatRuns.usageJson}->>'accountingProviderWorkStarted' = 'false'
        or (${closedNativeReceiptSource}))`,
    )),
  );
}

/** Only unfinished, actionable debt warrants retries. Incomplete provider
 * receipts retain their accounting/idle hold and wake when evidence arrives. */
export async function readCostAccountingWork(db: Db, now = Date.now(), receiptDirectory?: string) {
  const [pending] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(actionableRunAccounting()).limit(1);
  const [deadline] = await db.execute<{ at: Date | string | null }>(sql`
    select min(started_at) + interval '120 seconds 1 millisecond' as at from (
      select ${decisionInvocations.startedAt} as started_at from ${decisionInvocations}
        where ${decisionInvocations.status} = 'running'
      union all
      select ${promptInjectionInvocations.startedAt} from ${promptInjectionInvocations}
        where ${promptInjectionInvocations.status} = 'running'
    ) running_service_invocations`);
  const nextRunAt = deadline?.at == null ? null : new Date(deadline.at).getTime();
  const receipts = await indexPendingUsageReceipts(receiptDirectory);
  return {
    pending: !!pending || receipts.size > 0 || (nextRunAt !== null && nextRunAt <= now),
    nextRunAt,
  };
}

export async function reconcileRunCosts(db: Db, hooks: BudgetServiceHooks = {}) {
  const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(actionableRunAccounting())
    .orderBy(asc(heartbeatRuns.updatedAt), asc(heartbeatRuns.id)).limit(100);
  let accounted = 0;
  const receiptIndex = pending.length > 0 ? await indexPendingUsageReceipts() : undefined;
  for (const run of pending) {
    try { if (await accountRunCost(db, run.id, hooks, receiptIndex)) accounted++; }
    catch (error) {
      // Move failed attempts behind other pending work so a poisoned receipt
      // cannot monopolize the bounded batch on every recovery tick.
      await db.update(heartbeatRuns).set({ updatedAt: new Date(), accountingLastAttemptAt: new Date(), accountingAttemptCount: sql`${heartbeatRuns.accountingAttemptCount} + 1`, accountingLastError: error instanceof Error ? error.message.slice(0, 1000) : "Accounting failed" }).where(eq(heartbeatRuns.id, run.id));
      logger.error({ err: error, runId: run.id }, "Run accounting remains pending for retry");
    }
  }
  return { scanned: pending.length, accounted };
}

/** Share recovery across overlapping signals. The owning delivery worker
 * schedules retries only while a durable receipt or actionable debt remains. */
export function createCostAccountingReconciler(db: Db, hooks: BudgetServiceHooks = {}, recoverServices?: () => Promise<void>) {
  let inFlight: Promise<Awaited<ReturnType<typeof reconcileRunCosts>>> | undefined;
  return () => {
    if (!inFlight) {
      inFlight = (async () => {
        try {
          let serviceRecoveryFailure: { error: unknown } | undefined;
          try { await recoverServices?.(); }
          catch (error) { serviceRecoveryFailure = { error }; }
          await replayUsageReceipts(db);
          const result = await reconcileRunCosts(db, hooks);
          if (serviceRecoveryFailure) throw serviceRecoveryFailure.error;
          return result;
        } finally {
          inFlight = undefined;
        }
      })();
    }
    return inFlight;
  };
}
