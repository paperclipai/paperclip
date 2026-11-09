import { beginIdleTrackedWork } from "./task-admission.js";
import { priceAnthropicReceipt } from "./anthropic-pricing.js";
import { priceCodexReceipt } from "./codex-pricing.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, runUsageReceipts, costEvents, costAdjustments, type Db } from "@paperclipai/db";
import type { AdapterExecutionResult, AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { centsToUnits, compareCents, normalizeCents, pricingProvenanceSchema, usdToUnits, unitsToCents } from "@paperclipai/shared";
import { idleAccountingSpoolPath, registerIdleSpoolDirectory } from "./idle-local-work.js";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { receiptFingerprint } from "./receipt-fingerprint.js";
import { withOperationAccountingTransaction } from "./accounting-transaction.js";
import { ensureDurableDirectory, syncDirectory } from "../lib/durable-directory.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { knownRunCostCents } from "./budget-exposure.js";
import { createLiveRunUsageProjection, liveRunUsageCostCents } from "./budget-live-usage.js";
import { applyCostCorrectionInTransaction } from "./accounting-corrections.js";
import { logActivity, type ActivityPublication } from "./activity-log.js";
import { createCostEventInTransaction } from "./costs.js";
import { queueBudgetEvaluation } from "./budget-evaluation-work.js";
import { crashPoint } from "@paperclipai/shared/crash-points";

const token = z.number().int().nonnegative().max(2_147_483_647);
const price = z.number().finite().nonnegative().nullable().optional();
const usage = z.object({ inputTokens: token, outputTokens: token, cachedInputTokens: token.optional(), cacheWriteTokens: token.optional() });
const checkpointSchema = z.object({
  attemptId: z.string().uuid().optional(), usage: usage.optional(),
  usageByModel: z.array(z.object({ model: z.string().min(1).max(250), usage, costUsd: z.number().finite().nonnegative() })).max(500).optional(),
  usageBasis: z.enum(["per_run", "session_cumulative"]).nullable().optional(),
  provider: z.string().max(250).nullable().optional(), biller: z.string().max(250).nullable().optional(),
  model: z.string().max(250).nullable().optional(), billingType: z.string().max(100).nullable().optional(),
  costUsd: price, cacheAdjustedCostUsd: price,
  costStatus: z.enum(["reported", "estimated", "unpriced"]).optional(),
  pricingContext: z.object({ serviceTier: z.string().max(50).optional(), contextTier: z.enum(["short", "long"]).optional() }).optional(),
  pricingProvenance: pricingProvenanceSchema.optional(),
  costUsdExact: z.string().max(160).refine(value => { try { return !value.startsWith("-") && usdToUnits(value) >= 0n; } catch { return false; } }, "Invalid exact USD amount").nullable().optional(),
  providerRequestId: z.string().max(250).nullable().optional(), complete: z.boolean(),
});
const envelopeSchema = z.object({
  schema: z.literal("paperclip/accounting-receipt/v1"), id: z.string().uuid(), companyId: z.string().uuid(),
  runId: z.string().uuid(), sourceId: z.string().uuid(), sequence: z.number().int().positive(), receivedAt: z.iso.datetime(),
  adapterType: z.string().max(100), receipt: checkpointSchema,
  producerEvent: z.object({ sourceEventId: z.string(), turnId: z.string().optional(), providerTurnId: z.string().optional(),
    eventType: z.string(), usage: z.record(z.string(), z.unknown()).optional(),
    // The restored Runner failed this turn as lost on restore: its usage can
    // never be reported, so it does not hold the receipt open.
    lostOnRestore: z.literal(true).optional() }).optional(),
  // Derived by the recorder, not a provider's final charge. Keeping it in the
  // fsynced envelope preserves known partial attempts through database replay.
  liveCostCents: z.string().max(160).refine(value => {
    try { return compareCents(value, 0) >= 0; } catch { return false; }
  }, "Invalid live cost").transform(normalizeCents).nullable().optional(),
  // Set when another run's Runner stream reported this run's late usage. The
  // receipt's usage and cost are then an increment, not a run total.
  lateDelta: z.object({ attribution: z.enum(["exact", "inferred"]), reportedByRunId: z.string().uuid() }).optional(),
});
export type UsageReceiptEnvelope = z.infer<typeof envelopeSchema>;
export const usageReceiptSpoolPath = idleAccountingSpoolPath;

export async function spoolUsageReceipt(envelope: UsageReceiptEnvelope, directory = usageReceiptSpoolPath()) {
  registerIdleSpoolDirectory(directory);
  const parsed = envelopeSchema.parse(envelope);
  await ensureDurableDirectory(directory);
  const target = path.join(directory, `${parsed.id}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(parsed)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, target); await syncDirectory(directory);
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return target;
}

function lateReceiptDebts(usage: Record<string, unknown>): Record<string, boolean> {
  const raw = usage.accountingLateReceiptDebts;
  const debts = Object.fromEntries(Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {})
    .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  // Backward compatibility with the original single pending-receipt marker.
  if (usage.accountingLateReceiptPending === true && typeof usage.accountingLateReceiptId === "string"
    && !(usage.accountingLateReceiptId in debts))
    debts[usage.accountingLateReceiptId] = usage.accountingLateReceiptAttemptedId === usage.accountingLateReceiptId;
  return debts;
}

function acceptedReceiptSequence(usage: Record<string, unknown>, reconciled?: UsageReceiptEnvelope) {
  let sequence = Number(usage.accountingReceiptSequence ?? 0);
  if (usage.accountingReconciledReceiptSourceId === usage.accountingReceiptSourceId)
    sequence = Math.max(sequence, Number(usage.accountingReconciledReceiptSequence ?? 0));
  // Rows corrected before the explicit sequence field was introduced still have
  // their immutable reconciled receipt, which supplies the same source fence.
  if (reconciled && reconciled.sourceId === usage.accountingReceiptSourceId) sequence = Math.max(sequence, reconciled.sequence);
  return sequence;
}

/** Caller transaction may already own the run row. No company mutex or
 * filesystem work belongs in journal acceptance. */
export async function persistUsageReceiptInTransaction(tx: Db, raw: UsageReceiptEnvelope) {
  const envelope = envelopeSchema.parse(raw);
  const hash = receiptFingerprint(envelope);
  const [run] = await tx.select({
    id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
    usageJson: heartbeatRuns.usageJson, costAccountedAt: heartbeatRuns.costAccountedAt,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, envelope.runId), eq(heartbeatRuns.companyId, envelope.companyId))).for("update");
  if (!run) throw notFound("Accounting run not found");
  const [existing] = await tx.select().from(runUsageReceipts).where(and(eq(runUsageReceipts.companyId, envelope.companyId), eq(runUsageReceipts.runId, envelope.runId), eq(runUsageReceipts.sourceId, envelope.sourceId), eq(runUsageReceipts.sequence, envelope.sequence)));
  if (existing && existing.receiptHash !== hash) throw conflict("Conflicting usage checkpoint replay");
  if (!existing) await tx.insert(runUsageReceipts).values({
    id: envelope.id, companyId: envelope.companyId, runId: envelope.runId, sourceId: envelope.sourceId,
    sequence: envelope.sequence, receiptHash: hash, receiptJson: envelope, complete: envelope.receipt.complete, receivedAt: new Date(envelope.receivedAt),
  });
  const previous = run.usageJson ?? {};
  if (run.costAccountedAt || envelope.lateDelta) {
    const activeSource = previous.accountingReceiptSourceId === envelope.sourceId;
    const closedSources = previous.accountingReceiptSourceFences as Record<string, number> | undefined;
    if (!activeSource && typeof closedSources?.[envelope.sourceId] === "number" && envelope.sequence <= closedSources[envelope.sourceId])
      return { reconciliationRequired: false };
    const [reconciled] = typeof previous.accountingReconciledReceiptId === "string"
      ? await tx.select({ receiptJson: runUsageReceipts.receiptJson }).from(runUsageReceipts).where(and(
        eq(runUsageReceipts.runId, run.id), eq(runUsageReceipts.companyId, envelope.companyId),
        sql`${runUsageReceipts.id}::text = ${previous.accountingReconciledReceiptId}`)) : [];
    const reconciledEnvelope = reconciled ? envelopeSchema.parse(reconciled.receiptJson) : undefined;
    const newer = envelope.sequence > acceptedReceiptSequence(previous, reconciledEnvelope);
    const comparison = reconciledEnvelope ? { ...previous, ...reconciledEnvelope.receipt } : previous;
    const acceptedMoney = knownRunCostCents(comparison);
    const incomingMoney = liveRunUsageCostCents(envelope.receipt as AdapterUsageCheckpoint);
    const authoritative = envelope.receipt.pricingProvenance
      && !["rate_card", "unknown"].includes(envelope.receipt.pricingProvenance.source);
    const rateCardOnly = envelope.producerEvent && envelope.receipt.pricingProvenance?.source === "rate_card";
    // A charge settled without its final receipt accepts a complete receipt's
    // own price, including a rate-card price, as a correction. Reconciliation
    // can only post a receipt that carries its price; token changes are
    // detected below as usual.
    const ownPrice = envelope.receipt.cacheAdjustedCostUsd ?? envelope.receipt.costUsdExact ?? envelope.receipt.costUsd;
    const unavailableClosed = previous.accountingReceiptUnavailable === true && envelope.receipt.complete === true
      && ownPrice != null && envelope.receipt.costStatus !== "unpriced" && envelope.receipt.usageBasis !== "session_cumulative";
    const changed = unavailableClosed || envelope.lateDelta !== undefined
      || (envelope.producerEvent?.eventType === "usage.reported" && !envelope.receipt.usage)
      || envelope.receipt.usageBasis === "session_cumulative"
      || ["provider", "biller", "model", "billingType"].some(key => {
        const value = envelope.receipt[key as keyof typeof envelope.receipt];
        return value !== undefined && value !== null && value !== previous[key];
      }) || Object.entries(envelope.receipt.usage ?? {}).some(([key, value]) => previous[key] !== value)
      // A projection alone cannot be posted against a charge settled without
      // its receipt; only the receipt's own price (above) can correct it.
      || (!rateCardOnly && incomingMoney !== null && (previous.accountingReceiptUnavailable !== true || ownPrice != null)
        && (acceptedMoney === null || compareCents(incomingMoney, acceptedMoney) !== 0))
      || (!rateCardOnly && envelope.receipt.costStatus !== undefined && envelope.receipt.costStatus !== comparison.costStatus)
      || (authoritative
        && receiptFingerprint(envelope.receipt.pricingProvenance) !== receiptFingerprint(comparison.pricingProvenance ?? null));
    const debts = lateReceiptDebts(previous);
    if ((!existing && changed && (!activeSource || newer)) || envelope.id in debts) {
      if (!existing) {
        debts[envelope.id] = false;
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, envelope.companyId);
        await queueBudgetEvaluation(tx, { companyId: envelope.companyId, agentId: run.agentId,
          projectId: typeof (previous.ledgerScope as Record<string, unknown> | undefined)?.projectId === "string"
            ? (previous.ledgerScope as Record<string, string>).projectId : null });
        await tx.update(heartbeatRuns).set({ costAccountingPending: true,
          accountingLastError: "late_usage_requires_reconciliation",
          usageJson: { ...previous, accountingLateReceiptPending: true, accountingLateReceiptId: envelope.id,
            accountingLateReceiptDebts: debts },
        }).where(eq(heartbeatRuns.id, run.id));
      }
      return { reconciliationRequired: true };
    }
    return { reconciliationRequired: false };
  }
  // A replaced source cannot overwrite the accepted snapshot. Its immutable
  // journal entry remains available to source-handoff/recovery diagnostics.
  if (previous.accountingReceiptSourceId !== envelope.sourceId || Number(previous.accountingReceiptSequence ?? 0) >= envelope.sequence) {
    const fences = previous.accountingReceiptSourceFences as Record<string, number> | undefined;
    const [fenced] = !existing && typeof fences?.[envelope.sourceId] === "number" && envelope.sequence > fences[envelope.sourceId]
      ? await tx.select({ receiptJson: runUsageReceipts.receiptJson }).from(runUsageReceipts).where(and(
        eq(runUsageReceipts.companyId, envelope.companyId), eq(runUsageReceipts.runId, run.id),
        eq(runUsageReceipts.sourceId, envelope.sourceId), eq(runUsageReceipts.sequence, fences[envelope.sourceId]))) : [];
    const fencedReceipt = fenced ? envelopeSchema.parse(fenced.receiptJson).receipt : undefined;
    const sameFencedEvidence = fencedReceipt && receiptFingerprint({ usage: fencedReceipt.usage, money: liveRunUsageCostCents(fencedReceipt as AdapterUsageCheckpoint) })
      === receiptFingerprint({ usage: envelope.receipt.usage, money: liveRunUsageCostCents(envelope.receipt as AdapterUsageCheckpoint) });
    if (!existing && typeof fences?.[envelope.sourceId] === "number" && envelope.sequence > fences[envelope.sourceId] && !sameFencedEvidence) {
      await queueBudgetEvaluation(tx, { companyId: envelope.companyId, agentId: run.agentId,
        projectId: typeof (previous.ledgerScope as Record<string, unknown> | undefined)?.projectId === "string"
          ? (previous.ledgerScope as Record<string, string>).projectId : null });
      await tx.update(heartbeatRuns).set({ costAccountingPending: true, accountingLastError: "usage_after_source_handoff_requires_reconciliation",
        usageJson: { ...previous, accountingCaptureFailed: true, accountingReceiptReady: false,
          accountingSourceReceiptPending: envelope.id },
      }).where(eq(heartbeatRuns.id, run.id));
    }
    return { reconciliationRequired: false };
  }
  const receipt = envelope.receipt;
  const billingType = receipt.billingType === "api" ? "metered_api" : receipt.billingType === "subscription" ? "subscription_included" : receipt.billingType ?? "unknown";
  const oldProjection = previous.budgetExposure && typeof previous.budgetExposure === "object"
    ? previous.budgetExposure as Record<string, unknown> : {};
  const canonicalProjection = typeof oldProjection.sourceId === "string" && typeof oldProjection.sequence === "number";
  let previousCost = canonicalProjection ? null : knownRunCostCents(previous);
  if (typeof oldProjection.costCents === "string") {
    try {
      const projected = normalizeCents(oldProjection.costCents);
      if (compareCents(projected, 0) >= 0 && (canonicalProjection || compareCents(projected, previousCost ?? "0") > 0)) previousCost = projected;
    } catch { /* Older malformed projections are not billing evidence. */ }
  }
  const reportedCost = envelope.liveCostCents !== undefined ? envelope.liveCostCents
    : liveRunUsageCostCents({ ...receipt, billingType } as AdapterUsageCheckpoint);
  const observedCost = reportedCost === null ? previousCost
    : !receipt.complete && previousCost !== null && compareCents(previousCost, reportedCost) > 0 ? previousCost : reportedCost;
  // Running checkpoints cannot settle yet. Their terminal transition owns
  // the accounting wake; only a late receipt needs to reactivate that worker.
  if (!["queued", "running"].includes(run.status)) await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, envelope.companyId);
  await tx.update(heartbeatRuns).set({
    costAccountingPending: true,
    accountingLastError: previous.accountingCaptureFailed === true ? "usage_capture_failed" : null,
    usageJson: { ...previous, ...receipt.usage,
      provider: receipt.provider ?? "unknown", biller: receipt.biller ?? receipt.provider ?? "unknown", model: receipt.model ?? "unknown", billingType,
      costUsd: receipt.costUsd ?? null, costUsdExact: receipt.costUsdExact ?? null, cacheAdjustedCostUsd: receipt.cacheAdjustedCostUsd ?? null,
      usageByModel: receipt.usageByModel ?? null, usageSource: receipt.usageBasis ?? "per_run", providerRequestId: receipt.providerRequestId ?? null,
      accountingReceiptReady: previous.accountingCaptureFailed !== true && receipt.complete && receipt.usageBasis !== "session_cumulative", accountingReceiptId: envelope.id,
      accountingReceiptSequence: envelope.sequence, accountingReceiptReceivedAt: envelope.receivedAt,
      costStatus: receipt.costStatus ?? null,
      budgetExposure: { sourceId: envelope.sourceId, sequence: envelope.sequence, costCents: observedCost },
      pricingProvenance: receipt.pricingProvenance ?? { source: receipt.costUsd != null || receipt.costUsdExact != null ? "provider_reported" : "unknown", version: "accounting-receipt/v1" },
    },
  }).where(and(eq(heartbeatRuns.id, run.id), isNull(heartbeatRuns.costAccountedAt)));
  const scope = previous.ledgerScope && typeof previous.ledgerScope === "object" ? previous.ledgerScope as Record<string, unknown> : {};
  await queueBudgetEvaluation(tx, { companyId: envelope.companyId, agentId: run.agentId,
    projectId: typeof scope.projectId === "string" ? scope.projectId : null });
  return { reconciliationRequired: false };
}

const receiptTokenKeys = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;

function lateDeltaTotals(usage: Record<string, unknown>) {
  const saved = (usage.accountingLateDeltas ?? {}) as Record<string, unknown>;
  const count = (key: string) => typeof saved[key] === "number" ? saved[key] as number : 0;
  return { tokens: { inputTokens: count("inputTokens"), cachedInputTokens: count("cachedInputTokens"), outputTokens: count("outputTokens") },
    units: typeof saved.units === "string" ? BigInt(saved.units) : 0n };
}

function formatUsdUnits(units: bigint) {
  return `${units / 1_000_000_000n}.${String(units % 1_000_000_000n).padStart(9, "0")}`;
}

/** A provider can report more usage after its run's charge was posted. Cumulative
 * reports make the increment exact, so post it instead of leaving the run wrong.
 * Lower or conflicting evidence stays visible debt for an operator to review. */
function lateUsageGrowth(previous: Record<string, unknown>, late: UsageReceiptEnvelope,
  event: typeof costEvents.$inferSelect, newer: boolean, reconciled?: UsageReceiptEnvelope["receipt"]) {
  // A non-terminal report is never rate-card priced when it arrives, but its run
  // totals are all this growth posts. Price them now, or the tokens stay free.
  const receipt = priceAnthropicReceipt(priceCodexReceipt({ ...late.receipt, complete: true } as AdapterUsageCheckpoint)) as UsageReceiptEnvelope["receipt"];
  const accepted = (key: string) => typeof previous[key] === "number" ? previous[key] as number : 0;
  const billingType = receipt.billingType === "api" ? "metered_api"
    : receipt.billingType === "subscription" ? "subscription_included" : receipt.billingType ?? "unknown";
  if (!receipt.usage || receipt.usageBasis === "session_cumulative" || receipt.usageByModel?.length
    || (Array.isArray(previous.usageByModel) && previous.usageByModel.length) || receipt.model !== event.model
    || receipt.provider !== event.provider || (receipt.biller ?? receipt.provider) !== event.biller || billingType !== event.billingType) return null;
  if (!late.lateDelta && (!newer || late.sourceId !== previous.accountingReceiptSourceId)) return null;
  const reported = (key: typeof receiptTokenKeys[number]) => receipt.usage?.[key] ?? 0;
  const deltas = lateDeltaTotals(previous);
  // A source's cumulative receipts never include increments from later runs.
  const tokens = Object.fromEntries(receiptTokenKeys.map(key =>
    [key, late.lateDelta ? reported(key) : reported(key) - (accepted(key) - deltas.tokens[key])])) as Record<typeof receiptTokenKeys[number], number>;
  if (receiptTokenKeys.some(key => tokens[key] < 0) || receiptTokenKeys.every(key => tokens[key] === 0)) return null;
  const moneyValue = (value: unknown) => typeof value === "number" || typeof value === "string" ? usdToUnits(value) : null;
  const acceptedUnits = moneyValue(previous.cacheAdjustedCostUsd) ?? moneyValue(previous.costUsdExact) ?? moneyValue(previous.costUsd);
  const reportedUnits = moneyValue(receipt.cacheAdjustedCostUsd) ?? moneyValue(receipt.costUsdExact) ?? moneyValue(receipt.costUsd);
  const subscription = billingType === "subscription_included";
  // A price correction already moved the accepted total, so measure from it.
  const correctedTotal = reconciled ? moneyValue(reconciled.cacheAdjustedCostUsd) ?? moneyValue(reconciled.costUsdExact) ?? moneyValue(reconciled.costUsd) : null;
  const units = subscription ? 0n : reportedUnits === null ? null
    : late.lateDelta ? reportedUnits : reportedUnits - (correctedTotal ?? (acceptedUnits ?? 0n) - deltas.units);
  if (units !== null && units < 0n) return null;
  const totalUnits = units === null ? acceptedUnits : (acceptedUnits ?? 0n) + units;
  return { tokens, units, pricingProvenance: receipt.pricingProvenance, costStatus: receipt.costStatus, usage: {
    inputTokens: accepted("inputTokens") + tokens.inputTokens,
    cachedInputTokens: accepted("cachedInputTokens") + tokens.cachedInputTokens,
    outputTokens: accepted("outputTokens") + tokens.outputTokens,
    ...(late.lateDelta ? { accountingLateDeltas: {
      inputTokens: deltas.tokens.inputTokens + tokens.inputTokens,
      cachedInputTokens: deltas.tokens.cachedInputTokens + tokens.cachedInputTokens,
      outputTokens: deltas.tokens.outputTokens + tokens.outputTokens,
      units: String(deltas.units + (units ?? 0n)),
    } } : {}),
    // Keep the integrity check's receipt total equal to the run's charges.
    ...(subscription || units === null || totalUnits === null ? {} : { cacheAdjustedCostUsd: null, costUsd: null, costUsdExact: formatUsdUnits(totalUnits) }),
    ...(units === null && !subscription ? { costStatus: "unpriced" } : {}),
  } };
}

/** Caller owns the run row. A money-only authoritative revision can correct one
 * existing final charge. Ambiguous usage/source/model evidence remains debt. */
export async function reconcileLateRunUsageReceiptInTransaction(tx: Db, run: typeof heartbeatRuns.$inferSelect, publications: ActivityPublication[]) {
  const previous = run.usageJson ?? {};
  if (previous.accountingLateReceiptPending !== true || typeof previous.accountingLateReceiptId !== "string") return false;
  // Unchanged attempted debt is excluded from background scans. An explicit
  // operator retry still rechecks it after a reviewed ledger correction.
  const [saved] = await tx.select({ receiptJson: runUsageReceipts.receiptJson }).from(runUsageReceipts).where(and(
    eq(runUsageReceipts.companyId, run.companyId), eq(runUsageReceipts.runId, run.id),
    sql`${runUsageReceipts.id}::text = ${previous.accountingLateReceiptId}`));
  const late = saved ? envelopeSchema.parse(saved.receiptJson) : undefined;
  const receipt = late?.receipt;
  const [reconciled] = typeof previous.accountingReconciledReceiptId === "string"
    ? await tx.select({ receiptJson: runUsageReceipts.receiptJson }).from(runUsageReceipts).where(and(
      eq(runUsageReceipts.runId, run.id), eq(runUsageReceipts.companyId, run.companyId),
      sql`${runUsageReceipts.id}::text = ${previous.accountingReconciledReceiptId}`)) : [];
  const acceptedSequence = acceptedReceiptSequence(previous, reconciled ? envelopeSchema.parse(reconciled.receiptJson) : undefined);
  const events = await tx.select({ event: costEvents, exact: sql<string>`${costEvents.costCents}::text` }).from(costEvents)
    .where(and(eq(costEvents.companyId, run.companyId), eq(costEvents.heartbeatRunId, run.id),
      eq(costEvents.idempotencyKey, `heartbeat:${run.id}:final`))).for("update");
  const rawAmount = receipt?.cacheAdjustedCostUsd ?? receipt?.costUsdExact ?? receipt?.costUsd;
  const automaticCorrectionPrefix = `heartbeat:${run.id}:late:`;
  const [reviewedValuation] = events.length === 1 ? await tx.select({ id: costAdjustments.id }).from(costAdjustments)
    .where(and(eq(costAdjustments.companyId, run.companyId), eq(costAdjustments.costEventId, events[0].event.id),
      sql`not (${costAdjustments.actorId} = 'cost_accounting'
        and left(${costAdjustments.idempotencyKey}, length(${automaticCorrectionPrefix})) = ${automaticCorrectionPrefix})`)).limit(1) : [];
  const lateDeltas = lateDeltaTotals(previous);
  const sameTokens = receipt?.usage && receiptTokenKeys.every(key =>
    Number(previous[key] ?? 0) - lateDeltas.tokens[key] === Number(receipt.usage?.[key] ?? 0));
  const authoritative = receipt?.pricingProvenance && !["rate_card", "unknown"].includes(receipt.pricingProvenance.source);
  const billingType = receipt?.billingType === "api" ? "metered_api"
    : receipt?.billingType === "subscription" ? "subscription_included" : receipt?.billingType ?? "unknown";
  const biller = receipt?.biller ?? receipt?.provider ?? "unknown";
  const qualified = late && receipt?.complete && receipt.usageBasis !== "session_cumulative"
    && late.sourceId === previous.accountingReceiptSourceId && sameTokens
    && (authoritative || (previous.accountingReceiptUnavailable === true && receipt.pricingProvenance?.source === "rate_card"))
    && rawAmount != null && receipt.costStatus !== "unpriced" && events.length === 1
    && receipt.model === events[0].event.model && receipt.provider === events[0].event.provider
    && biller === events[0].event.biller && billingType === events[0].event.billingType
    && (!receipt.providerRequestId || !events[0].event.providerRequestId || receipt.providerRequestId === events[0].event.providerRequestId)
    && (!receipt.usageByModel || receipt.usageByModel.length === 0);
  const debts = lateReceiptDebts(previous);
  const currentId = previous.accountingLateReceiptId;
  async function updateDebtState(reconciled: boolean, advanceReceiptIdentity = reconciled) {
    if (reconciled) delete debts[currentId];
    else debts[currentId] = true;
    const nextId = Object.keys(debts).find(id => !debts[id]) ?? Object.keys(debts)[0] ?? null;
    await tx.update(heartbeatRuns).set({ costAccountingPending: nextId !== null,
      accountingLastError: nextId ? "late_usage_requires_reconciliation" : null, accountingLastAttemptAt: new Date(),
      usageJson: { ...previous, accountingLateReceiptPending: nextId !== null,
        accountingLateReceiptDebts: debts, accountingLateReceiptId: nextId,
        accountingLateReceiptAttemptedId: nextId && debts[nextId] ? nextId : null,
        ...(reconciled && advanceReceiptIdentity ? { accountingReconciledReceiptId: currentId,
          accountingReconciledReceiptSourceId: late!.sourceId,
          accountingReconciledReceiptSequence: late!.sequence } : {}),
        // A complete receipt now accounts for the usage a closure timeout
        // could not see, so its unknown-spend charge stops blocking.
        // Only a complete whole-run receipt from the run's own source does;
        // an increment reported by a later run does not.
        ...(reconciled && late?.receipt.complete && !late.lateDelta && late.sourceId === previous.accountingReceiptSourceId
          && previous.accountingClosureTimedOut === true ? { accountingClosureTimedOut: false } : {}),
      },
    }).where(eq(heartbeatRuns.id, run.id));
  }
  const growth = late && events.length === 1 && !reviewedValuation
    ? lateUsageGrowth(previous, late, events[0].event, late.sequence > acceptedSequence,
      reconciled ? envelopeSchema.parse(reconciled.receiptJson).receipt : undefined) : null;
  if (growth && late) {
    const { event } = events[0];
    const costStatus = growth.units === null && event.billingType !== "subscription_included" ? "unpriced" : growth.costStatus ?? event.costStatus;
    await createCostEventInTransaction(tx, run.companyId, {
      idempotencyKey: `${automaticCorrectionPrefix}${late.id}`, agentId: run.agentId, heartbeatRunId: run.id,
      issueId: event.issueId, projectId: event.projectId, goalId: event.goalId, billingCode: event.billingCode,
      provider: event.provider, biller: event.biller, providerRequestId: receipt?.providerRequestId ?? null,
      pricingProvenance: growth.pricingProvenance ?? event.pricingProvenance, model: event.model, billingType: event.billingType,
      costStatus, inputTokens: growth.tokens.inputTokens, cachedInputTokens: growth.tokens.cachedInputTokens,
      outputTokens: growth.tokens.outputTokens, costCents: growth.units === null ? "0" : unitsToCents(growth.units),
      occurredAt: new Date(late.receivedAt),
    }, publications, undefined, { deferBudgetEvaluation: true });
    Object.assign(previous, growth.usage);
    await logActivity(tx, { companyId: run.companyId, actorType: "system", actorId: "cost_accounting", action: "cost.late_usage_posted",
      entityType: "heartbeat_run", entityId: run.id, runId: run.id, agentId: run.agentId,
      details: { receiptId: late.id, attribution: late.lateDelta?.attribution ?? "exact", reportedByRunId: late.lateDelta?.reportedByRunId ?? run.id,
        inputTokens: growth.tokens.inputTokens, cachedInputTokens: growth.tokens.cachedInputTokens, outputTokens: growth.tokens.outputTokens,
        costCents: growth.units === null ? null : unitsToCents(growth.units) } }, publications);
    await queueBudgetEvaluation(tx, { companyId: run.companyId, agentId: run.agentId, projectId: event.projectId });
    await updateDebtState(true, late.lateDelta === undefined);
    if (Object.keys(debts).length === 0) await notifyDeliveryWork(tx, DELIVERY_QUEUES.strandedAgentStatus,
      JSON.stringify({ companyId: run.companyId, agentId: run.agentId }));
    return true;
  }
  // Totals are cumulative, so an older receipt at or below the accepted totals
  // from this source is already covered. Conflicting billing stays visible debt.
  if (late && !late.lateDelta && late.sourceId === previous.accountingReceiptSourceId && late.sequence <= acceptedSequence && receipt?.usage
    && receipt.usageBasis !== "session_cumulative" && events.length === 1 && receipt.model === events[0].event.model
    && receipt.provider === events[0].event.provider && biller === events[0].event.biller && billingType === events[0].event.billingType
    && receiptTokenKeys.every(key => (receipt.usage?.[key] ?? 0) <= Number(previous[key] ?? 0) - lateDeltas.tokens[key])) {
    await queueBudgetEvaluation(tx, { companyId: run.companyId, agentId: run.agentId, projectId: events[0].event.projectId });
    await updateDebtState(true, false);
    if (Object.keys(debts).length === 0) await notifyDeliveryWork(tx, DELIVERY_QUEUES.strandedAgentStatus,
      JSON.stringify({ companyId: run.companyId, agentId: run.agentId }));
    return true;
  }
  if (!qualified) { await updateDebtState(false); return false; }
  // A receipt's money covers the whole run. Earlier late charges already hold
  // their share, so the original charge may only be corrected to the remainder.
  const lateCharges = await tx.select({ exact: sql<string>`${costEvents.costCents}::text` }).from(costEvents).where(and(
    eq(costEvents.companyId, run.companyId), eq(costEvents.heartbeatRunId, run.id),
    sql`left(${costEvents.idempotencyKey}, length(${automaticCorrectionPrefix})) = ${automaticCorrectionPrefix}`));
  const correctedUnits = usdToUnits(rawAmount) + lateDeltas.units - lateCharges.reduce((sum, charge) => sum + centsToUnits(charge.exact), 0n);
  if (correctedUnits < 0n) { await updateDebtState(false); return false; }
  const corrected = receipt.billingType === "subscription_included" || receipt.billingType === "subscription"
    ? "0.0000000" : unitsToCents(correctedUnits);
  if (reviewedValuation) {
    if (compareCents(events[0].exact, corrected) !== 0) { await updateDebtState(false); return false; }
    // The operator has already reconciled this exact billing evidence. Resolve
    // the hold without creating another adjustment or replacing their pricing
    // authority, and never rewind a newer accepted source sequence.
    await queueBudgetEvaluation(tx, { companyId: run.companyId, agentId: run.agentId,
      projectId: typeof (previous.ledgerScope as Record<string, unknown> | undefined)?.projectId === "string"
        ? (previous.ledgerScope as Record<string, string>).projectId : null });
    await updateDebtState(true, late.sequence > acceptedSequence);
    if (Object.keys(debts).length === 0) await notifyDeliveryWork(tx, DELIVERY_QUEUES.strandedAgentStatus,
      JSON.stringify({ companyId: run.companyId, agentId: run.agentId }));
    return true;
  }
  if (late.sequence <= acceptedSequence) {
    // A higher complete receipt from this same cumulative source already
    // supersedes this money-only debt. Resolve it without repricing or rewinding
    // the reconciled receipt identity; unrelated source/usage debt remains.
    await queueBudgetEvaluation(tx, { companyId: run.companyId, agentId: run.agentId,
      projectId: typeof (previous.ledgerScope as Record<string, unknown> | undefined)?.projectId === "string"
        ? (previous.ledgerScope as Record<string, string>).projectId : null });
    await updateDebtState(true, false);
    if (Object.keys(debts).length === 0) await notifyDeliveryWork(tx, DELIVERY_QUEUES.strandedAgentStatus,
      JSON.stringify({ companyId: run.companyId, agentId: run.agentId }));
    return true;
  }
  if (compareCents(events[0].exact, corrected) !== 0 || events[0].event.costStatus !== "reported"
    || receiptFingerprint(events[0].event.pricingProvenance) !== receiptFingerprint(receipt.pricingProvenance)) {
    await applyCostCorrectionInTransaction(tx, publications, { companyId: run.companyId, eventId: events[0].event.id,
      idempotencyKey: `heartbeat:${run.id}:late:${late.id}`, expectedCents: events[0].exact, correctedCents: corrected,
      reason: "Authoritative late run usage receipt", pricing: receipt.pricingProvenance!, actorId: "cost_accounting" });
  }
  await queueBudgetEvaluation(tx, { companyId: run.companyId, agentId: run.agentId,
    projectId: typeof (previous.ledgerScope as Record<string, unknown> | undefined)?.projectId === "string"
      ? (previous.ledgerScope as Record<string, string>).projectId : null });
  await updateDebtState(true);
  if (Object.keys(debts).length === 0) await notifyDeliveryWork(tx, DELIVERY_QUEUES.strandedAgentStatus,
    JSON.stringify({ companyId: run.companyId, agentId: run.agentId }));
  return true;
}

export async function persistUsageReceipt(db: Db, raw: UsageReceiptEnvelope) {
  const envelope = envelopeSchema.parse(raw);
  // Late evidence is committed as run-level debt that accounting resolves or
  // surfaces. It never fails the delivering session or an unrelated later run.
  await withOperationAccountingTransaction(db, envelope.companyId,
    tx => persistUsageReceiptInTransaction(tx, envelope));
}

export async function replayUsageReceipts(db: Db, directory = usageReceiptSpoolPath(), limit = 100) {
  let files: string[];
  try { files = (await fs.readdir(directory)).filter(name => name.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { replayed: 0, failed: 0 }; throw error; }
  let replayed = 0, failed = 0;
  for (const name of files.slice(0, limit)) {
    const file = path.join(directory, name);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Invalid accounting spool entry");
      await persistUsageReceipt(db, envelopeSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))));
      await fs.rm(file, { force: true }); replayed++;
    } catch (error) {
      failed++;
      // Rotate failures behind fresh entries without discarding the evidence.
      await fs.rename(file, path.join(directory, `retry-${Date.now()}-${randomUUID()}.json`)).catch(() => undefined);
      logger.error({ err: error, receiptFile: name }, "Accounting spool receipt remains pending");
    }
  }
  return { replayed, failed };
}

type ReceiptIdentity = { companyId: unknown; runId: unknown } | null;
export type UsageReceiptIndex = Map<string, ReceiptIdentity>;
function receiptIdentity(raw: unknown): ReceiptIdentity {
  return raw && typeof raw === "object" && "companyId" in raw && "runId" in raw
    ? { companyId: raw.companyId, runId: raw.runId } : null;
}

/** Build once per recovery batch, before acquiring any accounting lock.
 * Spool publications are immutable, uniquely named files. Cache identities,
 * never receipt contents: matching evidence is revalidated during settlement. */
export async function indexPendingUsageReceipts(directory = usageReceiptSpoolPath()): Promise<UsageReceiptIndex> {
  const index: UsageReceiptIndex = new Map();
  let names: string[];
  try { names = await fs.readdir(directory); }
  // Indexing is only an optimization. The locked drain reports missing or
  // unreadable storage through the existing per-run recovery error path.
  catch { return index; }
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const file = path.join(directory, name);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > 1024 * 1024) { index.set(file, null); continue; }
      index.set(file, receiptIdentity(JSON.parse(await fs.readFile(file, "utf8"))));
    } catch (error) {
      if (error instanceof SyntaxError) index.set(file, null);
      // Unreadable or concurrently moved entries remain unknown and are
      // checked again under the lock, preserving per-run failure reporting.
    }
  }
  return index;
}

export type PendingRunUsageReceipt = { file: string; envelope: UsageReceiptEnvelope };

/** Capture immutable spool evidence before a database transaction. Finalizers
 * revalidate their closed producer identity after taking the run-row fence. */
export async function readPendingRunUsageReceipts(input: { companyId: string; runId: string }, directory = usageReceiptSpoolPath(), index?: UsageReceiptIndex): Promise<PendingRunUsageReceipt[]> {
  const pending = new Map<string, PendingRunUsageReceipt>();
  for (let scan = 0; scan < 3; scan++) {
    const names = await fs.readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    let moved = false;
    for (const name of names.filter(name => name.endsWith(".json"))) {
      const file = path.join(directory, name);
      if (pending.has(file)) continue;
      const indexed = index?.get(file);
      if (indexed !== undefined && (indexed?.companyId !== input.companyId || indexed?.runId !== input.runId)) continue;
      try {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.size > 1024 * 1024) continue;
        const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
        const identity = receiptIdentity(raw);
        if (identity?.companyId !== input.companyId || identity?.runId !== input.runId) continue;
        pending.set(file, { file, envelope: envelopeSchema.parse(raw) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { moved = true; continue; }
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    if (!moved) return [...pending.values()];
  }
  throw new Error("Accounting spool changed during recovery; retry required");
}

export async function recoverPendingRunUsageReceipts(db: Db, input: { companyId: string; runId: string }, directory = usageReceiptSpoolPath(), options: { retainFiles?: boolean; index?: UsageReceiptIndex } = {}) {
  const pending = await readPendingRunUsageReceipts(input, directory, options.index);
  for (const item of pending) {
    await persistUsageReceipt(db, item.envelope);
    if (!options.retainFiles) await fs.rm(item.file, { force: true });
  }
  return pending.map(item => item.file);
}

export async function createRunUsageRecorder(db: Db, input: { companyId: string; runId: string; adapterType: string }, directory = usageReceiptSpoolPath()) {
  registerIdleSpoolDirectory(directory);
  const sourceId = randomUUID();
  // Verify durable storage before starting paid work, including a directory
  // sync. The database binding fences checkpoints from replaced controllers.
  await ensureDurableDirectory(directory);
  const probe = await fs.open(path.join(directory, `${sourceId}.probe`), "wx", 0o600);
  try { await probe.sync(); } finally { await probe.close(); await fs.rm(path.join(directory, `${sourceId}.probe`)); }
  await syncDirectory(directory);
  const [beforeHandoff] = await db.select({ usageJson: heartbeatRuns.usageJson }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
  const receiptIdentity = (state: Record<string, unknown> | null | undefined) => JSON.stringify([
    state?.accountingReceiptSourceId, state?.accountingReceiptSequence, state?.accountingReceiptId,
  ]);
  const pending = await readPendingRunUsageReceipts(input, directory);
  const bound = await withOperationAccountingTransaction(db, input.companyId, async tx => {
    const [run] = await tx.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
      usageJson: heartbeatRuns.usageJson, costAccountedAt: heartbeatRuns.costAccountedAt }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).for("update");
    if (!run) throw notFound("Accounting run not found");
    if (run.costAccountedAt) throw conflict("Run cannot accept a new usage recorder");
    if (receiptIdentity(run.usageJson) !== receiptIdentity(beforeHandoff?.usageJson))
      throw conflict("Usage source changed during receipt recovery; retry recorder handoff");
    for (const item of pending) await persistUsageReceiptInTransaction(tx, item.envelope);
    await queueBudgetEvaluation(tx, { companyId: input.companyId, agentId: run.agentId,
      projectId: typeof (run.usageJson?.ledgerScope as Record<string, unknown> | undefined)?.projectId === "string"
        ? (run.usageJson!.ledgerScope as Record<string, string>).projectId : null });
    const [current] = await tx.select({ usageJson: heartbeatRuns.usageJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const old = current.usageJson ?? {};
    const fences = { ...(old.accountingReceiptSourceFences as Record<string, number> | undefined) };
    if (typeof old.accountingReceiptSourceId === "string") fences[old.accountingReceiptSourceId] = Number(old.accountingReceiptSequence ?? 0);
    return tx.update(heartbeatRuns).set({ usageJson: { ...old, accountingReceiptSourceFences: fences,
      accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0, accountingReceiptReady: false } })
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), isNull(heartbeatRuns.costAccountedAt))).returning({ id: heartbeatRuns.id, runtimeMode: heartbeatRuns.runtimeMode, usageJson: heartbeatRuns.usageJson });
  });
  for (const item of pending) await fs.rm(item.file, { force: true });
  if (bound.length !== 1) throw conflict("Run cannot accept a new usage recorder");
  let sequence = 0;
  let currentAttempt = "default";
  const attempts = new Map<string, AdapterUsageCheckpoint>();
  let initialLiveUsage: Parameters<typeof createLiveRunUsageProjection>[0];
  // Native run deltas retain their baseline across same-run recovery. Restore
  // the previous snapshot as the same attempt, never add it a second time.
  // An empty final result must not erase the last durable observation.
  const priorReceiptId = bound[0].usageJson?.accountingReceiptId;
  if (bound[0].runtimeMode === "native" && typeof priorReceiptId === "string") {
    const [previous] = await db.select().from(runUsageReceipts).where(and(
      eq(runUsageReceipts.id, priorReceiptId), eq(runUsageReceipts.runId, input.runId), eq(runUsageReceipts.companyId, input.companyId),
    ));
    if (previous) {
      const restored = envelopeSchema.parse(previous.receiptJson);
      const receipt = restored.receipt as AdapterUsageCheckpoint;
      attempts.set("default", receipt);
      initialLiveUsage = { receipt, costCents: restored.liveCostCents };
    }
  }
  const projectLiveUsage = createLiveRunUsageProjection(initialLiveUsage);
  let chain = Promise.resolve();
  let captureFailed = bound[0].usageJson?.accountingCaptureFailed === true;
  let finishFailedCapture: (() => void) | undefined;
  async function persistFailure() {
    if (!captureFailed) return;
    const persisted = await withOperationAccountingTransaction(db, input.companyId, async tx => {
      const [run] = await tx.select({ agentId: heartbeatRuns.agentId, costAccountedAt: heartbeatRuns.costAccountedAt,
        usageJson: heartbeatRuns.usageJson }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).for("update");
      if (!run || run.costAccountedAt || run.usageJson?.accountingReceiptSourceId !== sourceId) return false;
      if (run.usageJson?.accountingCaptureFailed === true) return true;
      await queueBudgetEvaluation(tx, { companyId: input.companyId, agentId: run.agentId,
        projectId: typeof (run.usageJson?.ledgerScope as Record<string, unknown> | undefined)?.projectId === "string"
          ? (run.usageJson!.ledgerScope as Record<string, string>).projectId : null });
      const rows = await tx.update(heartbeatRuns).set({
        costAccountingPending: true, accountingLastError: "usage_capture_failed",
        usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || '{"accountingCaptureFailed":true,"accountingReceiptReady":false}'::jsonb`,
      }).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        isNull(heartbeatRuns.costAccountedAt), sql`${heartbeatRuns.usageJson}->>'accountingReceiptSourceId' = ${sourceId}`)).returning({ id: heartbeatRuns.id });
      return rows.length === 1;
    });
    if (persisted) { finishFailedCapture?.(); finishFailedCapture = undefined; }
  }
  function enqueue(action: () => Promise<AdapterUsageCheckpoint>) {
    const finishQueuedCapture = beginIdleTrackedWork();
    const result = chain.then(action).catch(async error => {
      captureFailed = true;
      finishFailedCapture ??= beginIdleTrackedWork();
      // Persist before exposing rejection: the adapter's flush may throw before
      // complete(), and failure finalization must not settle an older receipt.
      try { await persistFailure(); }
      catch (failure) { logger.error({ err: failure, runId: input.runId }, "Usage capture failure fence requires retry before finalization"); }
      throw error;
    });
    chain = result.then(() => undefined, () => undefined).finally(finishQueuedCapture);
    return result;
  }
  async function capture(raw: AdapterUsageCheckpoint) {
    const parsed = checkpointSchema.parse(raw) as AdapterUsageCheckpoint;
    const attempt = parsed.attemptId ?? currentAttempt;
    if (!attempts.has(attempt)) currentAttempt = attempt;
    const previous = attempts.get(attempt);
    const priced = priceAnthropicReceipt(priceCodexReceipt({ ...parsed, usage: parsed.usage ?? previous?.usage,
      complete: parsed.complete && !(previous?.usage && !parsed.usage) }));
    priced.pricingProvenance ??= {
      source: priced.costUsd != null || priced.costUsdExact != null || priced.cacheAdjustedCostUsd != null ? "provider_reported" : "unknown",
      version: "accounting-receipt/v1",
    };
    attempts.set(attempt, priced);
    const liveCostCents = projectLiveUsage(attempt, priced);
    const parts = [...attempts.values()];
    const latest = attempts.get(currentAttempt)!;
    const receipt: AdapterUsageCheckpoint = { ...latest, complete: latest.complete && !captureFailed, usage: {
      inputTokens: parts.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0),
      cachedInputTokens: parts.reduce((sum, item) => sum + (item.usage?.cachedInputTokens ?? 0), 0),
      ...(parts.some(item => item.usage?.cacheWriteTokens !== undefined) ? { cacheWriteTokens: parts.reduce((sum, item) => sum + (item.usage?.cacheWriteTokens ?? 0), 0) } : {}),
      outputTokens: parts.reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0),
    } };
    if (parts.length > 1) {
      let total = 0n, priced = true;
      for (const part of parts) {
        const subscription = ["subscription", "subscription_included"].includes(part.billingType ?? "");
        const cost = subscription ? 0 : part.cacheAdjustedCostUsd ?? part.costUsdExact ?? part.costUsd;
        if (cost == null || (!subscription && part.costStatus === "unpriced")) priced = false;
        if (cost != null) total += usdToUnits(cost);
      }
      if (new Set(parts.map(part => part.billingType ?? "unknown")).size > 1) receipt.billingType = "unknown";
      const decimal = `${total / 1_000_000_000n}.${String(total % 1_000_000_000n).padStart(9, "0")}`;
      receipt.costUsdExact = decimal;
      receipt.costUsd = Number(decimal);
      receipt.cacheAdjustedCostUsd = null;
      // A rejected resume can report a complete, explicit zero before the
      // successful retry. It contributes neither spend nor tokens and must
      // not discard the successful attempt's known model attribution.
      const attributed = parts.filter(part => {
        const cost = part.cacheAdjustedCostUsd ?? part.costUsdExact ?? part.costUsd;
        return !part.complete || part.costStatus === "unpriced" || cost == null || usdToUnits(cost) !== 0n
          || Object.values(part.usage ?? {}).some(value => (value ?? 0) !== 0);
      });
      receipt.usageByModel = attributed.length === 1 ? attributed[0].usageByModel : undefined;
      receipt.costStatus = priced && parts.some(part => part.costStatus === "estimated") ? "estimated" : priced ? "reported" : "unpriced";
      receipt.pricingProvenance = { source: receipt.costStatus === "estimated" ? "rate_card" : "unknown", version: "per-attempt/v1", evidence: "Sum of attempted-run receipts; component prices are retained in the immutable receipt journal." };
      // Every attempted provider must supply a final receipt before the total
      // can be considered complete, even if a later attempt succeeded.
      receipt.complete = !captureFailed && parts.every(part => part.complete);
    }
    const envelope: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), ...input, sourceId, sequence: ++sequence, receivedAt: new Date().toISOString(), receipt, liveCostCents };
    const file = await spoolUsageReceipt(envelope, directory);
    crashPoint("accounting.usage_receipt.after_spool_before_db");
    try {
      await persistUsageReceipt(db, envelope);
      crashPoint("accounting.usage_receipt.after_db_before_unlink");
      await fs.rm(file, { force: true });
    }
    catch (error) {
      // The fsynced receipt is durable even when the DB transaction failed.
      // Wake the owned spool recovery path; never certify that failed write as free.
      const { wakeCostAccountingWork } = await import("./budget-enforcement-worker.js");
      wakeCostAccountingWork(db);
      logger.warn({ err: error, runId: input.runId, receiptId: envelope.id }, "Usage receipt is durable on disk; database replay pending");
    }
    return receipt;
  }
  return {
    capture: (receipt: AdapterUsageCheckpoint) => enqueue(() => capture(receipt)),
    // Retry a transient database failure before heartbeat can mark the run
    // terminal. A failed retry must propagate and leave finalization pending.
    persistFailure: async () => { await chain; await persistFailure(); },
    complete: (result: AdapterExecutionResult) => enqueue(async () => {
      const final = checkpointSchema.parse({ ...result, complete: result.usageComplete !== false }) as AdapterUsageCheckpoint;
      const previous = attempts.get(currentAttempt);
      // A bounded stdout tail can lose a terminal record already saved from the
      // full stream. Keep that stronger evidence, but never hide additional
      // usage/charges or certify a snapshot inherited from a replaced recorder.
      if (sequence > 0 && previous?.complete && result.usageComplete === false) {
        const moreTokens = (["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"] as const)
          .some(key => (final.usage?.[key] ?? 0) > (previous.usage?.[key] ?? 0));
        const finalPrice = final.cacheAdjustedCostUsd ?? final.costUsdExact ?? final.costUsd;
        const previousPrice = previous.cacheAdjustedCostUsd ?? previous.costUsdExact ?? previous.costUsd;
        const moreCost = finalPrice != null && (previousPrice == null || usdToUnits(finalPrice) > usdToUnits(previousPrice));
        if (!moreTokens && !moreCost) return capture(previous);
      }
      return capture(final);
    }),
  };
}

export async function readAcceptedRunUsageCheckpoint(db: Db, input: { companyId: string; runId: string }): Promise<AdapterUsageCheckpoint | undefined> {
  const [run] = await db.select({ usageJson: heartbeatRuns.usageJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  const state = run?.usageJson;
  if (typeof state?.accountingReceiptId !== "string") return undefined;
  const [saved] = await db.select({ receiptJson: runUsageReceipts.receiptJson }).from(runUsageReceipts).where(and(
    eq(runUsageReceipts.companyId, input.companyId), eq(runUsageReceipts.runId, input.runId),
    sql`${runUsageReceipts.id}::text = ${state.accountingReceiptId}`));
  if (!saved) return undefined;
  const receipt = envelopeSchema.parse(saved.receiptJson);
  if (receipt.sourceId !== state.accountingReceiptSourceId || receipt.sequence !== state.accountingReceiptSequence) return undefined;
  return { ...receipt.receipt, complete: receipt.receipt.complete && state.accountingReceiptReady === true } as AdapterUsageCheckpoint;
}

const producerAccountingProjectionFields = [
  "accountingReceiptOwner", "accountingReceiptSourceId", "accountingReceiptSequence", "accountingReceiptReady",
  "accountingReceiptId", "accountingReceiptReceivedAt", "accountingCaptureFailed", "accountingReceiptSourceFences",
  "accountingSourceReceiptPending", "accountingLateReceiptPending", "accountingLateReceiptId",
  "accountingLateReceiptAttemptedId", "accountingReconciledReceiptId", "accountingLateReceiptDebts", "accountingLateDeltas",
  "accountingReconciledReceiptSourceId", "accountingReconciledReceiptSequence",
  "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens",
  "provider", "biller", "model", "billingType", "usageSource", "providerRequestId", "usageByModel",
  "costUsd", "costUsdExact", "cacheAdjustedCostUsd", "costStatus", "pricingProvenance", "budgetExposure",
];

export function preserveAcceptedRunUsageProjectionSql(patch: Record<string, unknown>) {
  const fields = sql.join(producerAccountingProjectionFields.map(field => sql`${field}`), sql`, `);
  return sql`case when ${heartbeatRuns.usageJson}->>'accountingReceiptOwner' = 'native_producer'
    then ${JSON.stringify(patch)}::jsonb || (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
      from jsonb_each(coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb)) where key in (${fields}))
    else ${JSON.stringify(patch)}::jsonb end`;
}
