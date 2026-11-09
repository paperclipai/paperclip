import { notifyStrandedAgentStatus } from "./live-run-recovery-notifications.js";
import { promoteDeferredWorkIntents } from "./work-intent-outbox.js";
import { centsToUnits, centsToUsd, usdToUnits, unitsToCents } from "@paperclipai/shared";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { budgetReservations, agents, environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, runUsageReceipts, issues, projects, decisionInvocations, promptInjectionInvocations, type Db } from "@paperclipai/db";
import { withOperationAccountingTransaction } from "./accounting-transaction.js";
import { withBudgetSpan } from "./budget-tracing.js";
import { conflict } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS } from "./native-runtime/native-runner-recovery-contract.js";
import { createCostEventInTransaction } from "./costs.js";
import { settleChargedImageReceiptsInTransaction } from "./native-runtime/generate-image-tool.js";
import type { BudgetServiceHooks } from "./budgets.js";
import { queueBudgetEvaluation } from "./budget-evaluation-work.js";
import { ensureRuntimeAccountingBaseline } from "./runtime-accounting-totals.js";
import { logger } from "../middleware/logger.js";
import { promises as fs } from "node:fs";
import { priceAnthropicReceipt } from "./anthropic-pricing.js";
import { priceCodexReceipt } from "./codex-pricing.js";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { replayUsageReceipts, indexPendingUsageReceipts, readPendingRunUsageReceipts, persistUsageReceiptInTransaction, reconcileLateRunUsageReceiptInTransaction, type UsageReceiptIndex } from "./usage-receipts.js";
import { crashPoint } from "@paperclipai/shared/crash-points";

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
    providerWorkNeverStarted: sql<boolean>`(${nativeProviderWorkNeverStarted}) is true`,
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
 *   server-authored process event is the verified local stop. This holds for
 *   any terminal status (failed, cancelled, timed out, interrupted): a stopped
 *   process reports no more usage. Settlement still imports spooled receipts,
 *   and a receipt a reattached recorder delivers later posts through
 *   late-receipt reconciliation.
 * - Remote: every allocation has a termination receipt for its sandbox, so
 *   neither the original nor a reattached runner can report usage. That proof
 *   does not clear the recorded remote process identity.
 * Missing identity alone is never proof. One predicate serves the reconciler
 * scan and settlement so they cannot disagree. */
/** Native recovery will not run this provider again: it ended in terminal
 * failure, or the run's result was already accepted. */
const settledNativeCoordinator = sql`exists (select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
    and ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
    and ((${nativeRunFinalizations.resultId} is null and ${nativeRunFinalizations.phase} = 'terminal_failure')
      or ${nativeRunFinalizations.resultId} is not null))`;

// A verified local stop closes the receipt source for any terminal status: a
// restart cancels, times out or interrupts a run as often as it fails one.
const closedNativeReceiptSource = sql`${heartbeatRuns.runtimeMode} = 'native'
  and ${settledNativeCoordinator}
  and ((${heartbeatRuns.status} in ('failed', 'cancelled', 'timed_out', 'interrupted')
    and ${heartbeatRuns.processPid} is null and ${heartbeatRuns.processGroupId} is null
    and (select process_event.event_type from ${heartbeatRunEvents} process_event
      where process_event.company_id = ${heartbeatRuns.companyId} and process_event.run_id = ${heartbeatRuns.id}
        and process_event.source_event_id is null
        and process_event.event_type in ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped')
      order by process_event.seq desc limit 1) = 'native.local_process_stopped')
    or (${heartbeatRuns.status} in ('failed', 'cancelled', 'timed_out', 'interrupted') and ${remoteExecutionTerminated}))`;

/** A native run whose provider never started has nothing to account: recovery
 * settled, not one usage receipt was ever journaled for the run (a provider
 * turn journals one as soon as it starts), and its local process either never
 * launched or was verified stopped. Settle it at once, like a pre-provider
 * failure, instead of holding company work. A usage recorder binds every run
 * with an empty fence map; only a replaced receipt source (a non-empty map)
 * shows that provider work began. */
const inheritedProcessIdentityOnly = sql`${heartbeatRuns.runnerProfileJson}->>'inheritedProcessIdentityRunId' is not null
  and not exists (select 1 from ${heartbeatRunEvents} own_process
    where own_process.company_id = ${heartbeatRuns.companyId} and own_process.run_id = ${heartbeatRuns.id}
      and own_process.source_event_id is null
      and own_process.event_type in ('native.process_start_requested', 'native.process_identity_recorded'))`;

const nativeProviderWorkNeverStarted = sql`${heartbeatRuns.runtimeMode} = 'native'
  and ${heartbeatRuns.status} in ('failed', 'cancelled', 'timed_out', 'interrupted')
  and ${settledNativeCoordinator}
  and coalesce((${heartbeatRuns.usageJson}->>'accountingReceiptSequence')::int, 0) = 0
  and coalesce(${heartbeatRuns.usageJson}->'accountingReceiptSourceFences', '{}'::jsonb) = '{}'::jsonb
  and not exists (select 1 from ${runUsageReceipts} journaled_receipt
    where journaled_receipt.company_id = ${heartbeatRuns.companyId} and journaled_receipt.run_id = ${heartbeatRuns.id})
  and ((${heartbeatRuns.processPid} is null and ${heartbeatRuns.processGroupId} is null) or (${inheritedProcessIdentityOnly}))
  and coalesce((select process_event.event_type from ${heartbeatRunEvents} process_event
      where process_event.company_id = ${heartbeatRuns.companyId} and process_event.run_id = ${heartbeatRuns.id}
        and process_event.source_event_id is null
        and process_event.event_type in ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped')
      order by process_event.seq desc limit 1), 'native.local_process_stopped') = 'native.local_process_stopped'`;

/** Waiting for closure evidence is bounded. Past the remote runner reconnect
 * grace plus a margin, a terminal run whose recovery has settled no longer
 * holds new company work: its debt settles as unpriced and is flagged so the
 * board sees which run it was. The flag also exempts the charge from the
 * blocking unpriced-usage policy (budget-exposure.ts): accounting is never a
 * company gate. */
/** A run's accounting settled: an admission hold may have cleared. Held work
 * (queued runs, saved messages and Retries, and tasks whose start or
 * continuation was refused) waits passively, so wake its owners. */
async function notifyAccountingHoldRelease(tx: object, companyId: string) {
  await promoteDeferredWorkIntents(tx, { companyId, trigger: "accounting_settled" });
}

export const ACCOUNTING_CLOSURE_TIMEOUT_MS = REMOTE_RUNNER_RECONNECT_GRACE_MS + 3 * 60_000;
/** `at` is one shared cutoff, so the actionable scan and the wake query
 * cannot both miss a run whose bound falls between them. */
function closureEvidenceTimedOut(at: Date = new Date()) {
  return sql`${heartbeatRuns.runtimeMode} = 'native'
  and ${heartbeatRuns.status} in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
  and ${settledNativeCoordinator}
  and coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})
    <= ${at.toISOString()}::timestamptz - make_interval(secs => ${ACCOUNTING_CLOSURE_TIMEOUT_MS / 1000})`;
}

/** A failed usage capture can never complete its receipt, and replay cannot
 * certify what it missed. It is bounded like missing closure evidence: past
 * the same bound, once native recovery will not run the provider again, its
 * known usage settles as unpriced (or as a lower-bound estimate) and is
 * flagged, which exempts it from the blocking unpriced-usage policy
 * (budget-exposure.ts). Without the bound such a run held company admission
 * until its UTC budget window rolled over. */
function captureFailureBoundPassed(at: Date = new Date()) {
  return sql`${heartbeatRuns.usageJson}->>'accountingCaptureFailed' = 'true'
  and ${heartbeatRuns.status} in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
  and (${heartbeatRuns.runtimeMode} is distinct from 'native' or ${settledNativeCoordinator})
  and coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})
    <= ${at.toISOString()}::timestamptz - make_interval(secs => ${ACCOUNTING_CLOSURE_TIMEOUT_MS / 1000})`;
}

async function captureFailureSettles(db: Db, runId: string): Promise<boolean> {
  const [row] = await db.select({ due: sql<boolean>`(${captureFailureBoundPassed()}) is true` }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId));
  return row?.due === true;
}

async function readNativeReceiptClosure(db: Db, runId: string) {
  const [row] = await db.select({ closed: sql<boolean>`${closedNativeReceiptSource}`,
    timedOut: sql<boolean>`${closureEvidenceTimedOut()}`, neverStarted: sql<boolean>`${nativeProviderWorkNeverStarted}` }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId));
  if (row?.neverStarted === true) return "no_provider_work" as const;
  if (row?.closed === true) return "closed" as const;
  return row?.timedOut === true ? "timed_out" as const : null;
}

function withClosureTimeoutEvidence(provenance: Record<string, unknown>, timedOut: boolean, captureFailed = false) {
  if (!timedOut) return provenance;
  const evidence = text(provenance.evidence);
  const reason = captureFailed
    ? "usage capture failed; the usage observed before the failure settled after the accounting closure timeout, and the run may have spent more"
    : "closure evidence never arrived; settled after the accounting closure timeout, and the run may have spent more";
  return { source: "unknown", version: "accounting-receipt/v1", ...provenance,
    evidence: [evidence, reason].filter(Boolean).join("; ") };
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
  if (!identity.accountedAt && closure.runtimeMode === "native" && !closure.preProviderFailure && !closure.providerWorkNeverStarted
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
    // Tool-side image spend is separate from the provider receipt; settle any
    // paid image whose own accounting write did not complete.
    for (const projectId of new Set(await settleChargedImageReceiptsInTransaction(tx, run, publications))) {
      await queueBudgetEvaluation(tx, { companyId: run.companyId, agentId: run.agentId, projectId });
    }
    if (run.costAccountedAt) {
      if (object(run.usageJson).accountingLateReceiptPending === true) {
        // Clearing late debt can release an admission hold too.
        await notifyAccountingHoldRelease(tx, run.companyId);
        return reconcileLateRunUsageReceiptInTransaction(tx, run, publications);
      }
      await notifyStrandedAgentStatus(tx, { companyId: run.companyId, agentId: run.agentId });
      await notifyAccountingHoldRelease(tx, run.companyId);
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
    // nor terminal status can certify that the missing work was free, so it
    // never settles as pre-provider work. It waits for the closure bound and
    // then settles its known usage as possibly incomplete spend.
    const captureFailed = object(run.usageJson).accountingCaptureFailed === true;
    if (captureFailed && !await captureFailureSettles(tx, run.id)) return false;
    const providerWorkNeverStarted = !captureFailed && run.runtimeMode === "native" && object(run.usageJson).accountingReceiptReady === false
      && await readNativeReceiptClosure(tx, run.id) === "no_provider_work";
    const preProviderFailure = !captureFailed && (object(object(run.resultJson).executionRecovery).providerWorkStarted === false
      || object(run.usageJson).accountingProviderWorkStarted === false || providerWorkNeverStarted);
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
    const receiptUnavailable = !preProviderFailure && (captureFailed || object(run.usageJson).accountingReceiptReady === false);
    const receiptClosure = captureFailed ? "timed_out" as const
      : receiptUnavailable ? await readNativeReceiptClosure(tx, run.id) : null;
    if (receiptUnavailable && !receiptClosure) return false;
    const closureTimedOut = receiptClosure === "timed_out";
    if (!preProviderFailure) await ensureRuntimeAccountingBaseline(tx, run.companyId, run.agentId);
    // Acknowledgement is part of the same transaction. Budget checks inside
    // this transaction must not mistake this receipt for missing accounting.
    await notifyStrandedAgentStatus(tx, { companyId: run.companyId, agentId: run.agentId });
    await notifyAccountingHoldRelease(tx, run.companyId);
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
    const reportedCostUsd = amount(usage.cacheAdjustedCostUsd) ?? text(usage.costUsdExact) ?? amount(usage.costUsd);
    // A later checkpoint can clear the raw cost fields while the live budget
    // projection keeps the price already observed. A receipt that will never
    // complete (lost, timed out, or a failed capture) settles at no less than
    // that observed money, so settlement never lowers spend.
    const observedCents = receiptUnavailable ? text(object(usage.budgetExposure).costCents) : null;
    let observedCostUsd: string | null = null;
    if (observedCents) {
      try {
        const observedUnits = centsToUnits(observedCents);
        if (observedUnits > 0n && (reportedCostUsd === null || observedUnits > usdToUnits(reportedCostUsd))) {
          observedCostUsd = centsToUsd(observedCents);
        }
      } catch { /* An unreadable projection proves nothing; keep the reported cost. */ }
    }
    const knownCostUsd = observedCostUsd ?? reportedCostUsd;
    const lostReceiptEstimate = receiptUnavailable && knownCostUsd === null ? estimateLostReceipt(usage) : null;
    const costUsd = knownCostUsd ?? lostReceiptEstimate?.costUsdExact ?? null;
    const billingType = text(usage.billingType) ?? "unknown";
    // A lost receipt that already carries a provider-reported cost settles at
    // that cost, as an estimate marked as a lower bound, not as unpriced.
    const reportedLowerBound = receiptUnavailable && knownCostUsd !== null && billingType !== "subscription_included"
      && usdToUnits(knownCostUsd) > 0n;
    const lowerBoundProvenance = reportedLowerBound ? { source: "provider_reported", version: "accounting-receipt/v1",
      ...object(usage.pricingProvenance),
      evidence: [text(object(usage.pricingProvenance).evidence), "final receipt lost; provider-reported cost of the observed usage is a lower bound"]
        .filter(Boolean).join("; ") } : null;
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
      pricingProvenance: withClosureTimeoutEvidence(lostReceiptEstimate?.pricingProvenance ?? lowerBoundProvenance ?? object(usage.pricingProvenance), closureTimedOut, captureFailed),
      model: text(usage.model) ?? "unknown", billingType,
      costStatus: lostReceiptEstimate || reportedLowerBound ? "estimated" : (costUsd === null || usage.costStatus === "unpriced" || receiptUnavailable) && billingType !== "subscription_included" && hasBillableEvidence ? "unpriced" : usage.costStatus === "estimated" ? "estimated" : "reported",
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
    if (!lateDebt) await notifyAccountingHoldRelease(tx, run.companyId);
    await tx.update(heartbeatRuns).set({ costAccountingPending: lateDebt, costAccountedAt: new Date(), accountingProjectionVersion: "v2",
      accountingLastError: lateDebt ? "late_usage_requires_reconciliation" : null, accountingLastAttemptAt: new Date(),
      // A complete receipt arriving later may price this charge (see usage-receipts).
      ...(receiptUnavailable ? { usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({
        accountingReceiptUnavailable: true,
        // Unlike a verified stop, the run may still have spent. The flag names
        // the run in Costs; like any charge accounting settled without its
        // receipt, it is exempt from the blocking unpriced-usage policy
        // (budget-exposure.ts), because accounting is never a company gate.
        ...(closureTimedOut ? { accountingClosureTimedOut: true } : {}),
        // Late reconciliation measures a later receipt from the accepted money.
        ...(lostReceiptEstimate ? { costUsdExact: lostReceiptEstimate.costUsdExact, costStatus: "estimated",
          pricingProvenance: lostReceiptEstimate.pricingProvenance } : {}),
        ...(lowerBoundProvenance ? { costStatus: "estimated", pricingProvenance: lowerBoundProvenance } : {}),
        // The observed price became the accepted money; late reconciliation
        // measures growth from it rather than posting the full total again.
        // cacheAdjustedCostUsd outranks costUsdExact in every reader, so a
        // lower one would otherwise survive and win.
        ...(observedCostUsd ? { costUsdExact: observedCostUsd, cacheAdjustedCostUsd: null } : {}),
      })}::jsonb` } : {}),
    }).where(eq(heartbeatRuns.id, run.id));
    if (closureTimedOut) await logActivity(tx, { companyId: run.companyId, actorType: "system", actorId: "cost_accounting",
      action: "cost.accounting_closure_timed_out", entityType: "heartbeat_run", entityId: run.id, runId: run.id, agentId: run.agentId,
      details: { reason: captureFailed
        ? "Usage capture failed, so the final usage can never be confirmed; the run's known usage was recorded as a lower bound, or as unpriced when it had no price."
        : "Final usage never arrived and no stop of its provider was verified; the run's known usage was recorded as a lower bound, or as unpriced when it had no price.",
        ...(captureFailed ? { captureFailed: true } : {}),
        timeoutMinutes: ACCOUNTING_CLOSURE_TIMEOUT_MS / 60_000 } }, publications);
    return true;
  }), { "budget.accounting.owner": "run" });
  // Only a closed account reaches this gap; an open one returned false above.
  if (accounted) crashPoint("accounting.closure.after_commit_before_spool_unlink");
  for (const file of recoveredFiles) {
    try { await fs.rm(file, { force: true }); }
    catch (error) { logger.warn({ err: error, runId }, "Accounting committed; recovered receipt cleanup will retry"); }
  }
  return accounted;
}

function actionableRunAccounting(at: Date = new Date()) {
  return and(
    eq(heartbeatRuns.costAccountingPending, true), inArray(heartbeatRuns.status, terminalStatuses),
    or(and(sql`${heartbeatRuns.costAccountedAt} is not null`,
      or(sql`${heartbeatRuns.usageJson}->>'accountingLateReceiptPending' is distinct from 'true'`,
        sql`${heartbeatRuns.usageJson}->>'accountingLateReceiptId' is distinct from ${heartbeatRuns.usageJson}->>'accountingLateReceiptAttemptedId'`)), and(
      sql`${heartbeatRuns.costAccountedAt} is null`,
      or(sql`(${captureFailureBoundPassed(at)})`, and(
        sql`${heartbeatRuns.usageJson}->>'accountingCaptureFailed' is distinct from 'true'`,
        sql`(${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted' = 'false'
          or ${heartbeatRuns.usageJson}->>'accountingProviderWorkStarted' = 'false'
          or not exists (select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
          and ${heartbeatRuns.runtimeMode} = 'native' and ${nativeRunFinalizations.resultId} is null
          and ${nativeRunFinalizations.phase} <> 'terminal_failure'))`,
        sql`(${heartbeatRuns.usageJson}->>'accountingReceiptReady' is distinct from 'false' or ${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted' = 'false' or ${heartbeatRuns.usageJson}->>'accountingProviderWorkStarted' = 'false'
          or (${closedNativeReceiptSource}) or (${closureEvidenceTimedOut(at)}) or (${nativeProviderWorkNeverStarted}))`,
      )),
    )),
  );
}

/** Only unfinished, actionable debt warrants retries. Incomplete provider
 * receipts retain their accounting/idle hold and wake when evidence arrives. */
export async function readCostAccountingWork(db: Db, now = Date.now(), receiptDirectory?: string) {
  const cutoff = new Date(now);
  const [pending] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(actionableRunAccounting(cutoff)).limit(1);
  const [deadline] = await db.execute<{ at: Date | string | null }>(sql`
    select min(started_at) + interval '120 seconds 1 millisecond' as at from (
      select ${decisionInvocations.startedAt} as started_at from ${decisionInvocations}
        where ${decisionInvocations.status} = 'running'
      union all
      select ${promptInjectionInvocations.startedAt} from ${promptInjectionInvocations}
        where ${promptInjectionInvocations.status} = 'running'
    ) running_service_invocations`);
  // Wake when a run waiting for closure evidence reaches its bound.
  const [closure] = await db.select({ at: sql<Date | string | null>`min(coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}))` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.costAccountingPending, true), isNull(heartbeatRuns.costAccountedAt),
      sql`${heartbeatRuns.status} in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')`,
      or(and(
        sql`${heartbeatRuns.usageJson}->>'accountingReceiptReady' = 'false'`,
        sql`${heartbeatRuns.usageJson}->>'accountingCaptureFailed' is distinct from 'true'`,
        sql`${heartbeatRuns.runtimeMode} = 'native'`,
        settledNativeCoordinator,
      ), and(
        // A failed capture waits for the same bound; see captureFailureBoundPassed.
        sql`${heartbeatRuns.usageJson}->>'accountingCaptureFailed' = 'true'`,
        sql`(${heartbeatRuns.runtimeMode} is distinct from 'native' or ${settledNativeCoordinator})`,
      )),
      // Only future bounds: a run already past it is in the actionable scan,
      // and a past deadline must never schedule an immediate pass again.
      sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})
        > ${cutoff.toISOString()}::timestamptz - make_interval(secs => ${ACCOUNTING_CLOSURE_TIMEOUT_MS / 1000})`));
  const closureAt = closure?.at == null ? null : new Date(closure.at).getTime() + ACCOUNTING_CLOSURE_TIMEOUT_MS + 1;
  const serviceAt = deadline?.at == null ? null : new Date(deadline.at).getTime();
  const nextRunAt = serviceAt === null ? closureAt : closureAt === null ? serviceAt : Math.min(serviceAt, closureAt);
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
