import { and, eq, sql } from "drizzle-orm";
import { costAdjustments, costEvents, decisionInvocations, promptInjectionInvocations, fastResponseRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { normalizeCents } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { receiptFingerprint } from "./receipt-fingerprint.js";
import { logActivity, type ActivityPublication } from "./activity-log.js";
import { queueBudgetEvaluation } from "./budget-evaluation-work.js";

export interface CostCorrectionInput {
  companyId: string;
  eventId: string;
  idempotencyKey: string;
  expectedCents: string;
  correctedCents: string;
  reason: string;
  pricing: Record<string, unknown>;
  actorId: string;
  invoiceLineId?: string | null;
  receiptHash?: string;
  costStatus?: "reported" | "estimated" | "unpriced";
  receiptUsage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; providerRequestId: string | null };
}

/** Manual correction follows the same owner-before-ledger order as settlement. */
export async function lockCostCorrectionOwner(tx: Db, companyId: string, eventId: string) {
  const [event] = await tx.select().from(costEvents).where(and(eq(costEvents.id, eventId), eq(costEvents.companyId, companyId)));
  if (!event) throw notFound("Cost event not found");
  if (event.issueId) await tx.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.id, event.issueId), eq(issues.companyId, companyId))).for("key share");
  if (event.usageKind === "decision") await tx.select({ id: decisionInvocations.id }).from(decisionInvocations)
    .where(and(eq(decisionInvocations.costEventId, eventId), eq(decisionInvocations.companyId, companyId))).for("update");
  else if (event.usageKind === "prompt_injection") await tx.select({ id: promptInjectionInvocations.id }).from(promptInjectionInvocations)
    .where(and(eq(promptInjectionInvocations.costEventId, eventId), eq(promptInjectionInvocations.companyId, companyId))).for("update");
  else if (event.usageKind === "fast_response") await tx.select({ id: fastResponseRequests.id }).from(fastResponseRequests)
    .where(and(eq(fastResponseRequests.costEventId, eventId), eq(fastResponseRequests.companyId, companyId))).for("update");
  else if (event.heartbeatRunId) await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, event.heartbeatRunId), eq(heartbeatRuns.companyId, companyId))).for("update");
}

/** Caller validates receipt/invoice authority and acquires its operation fence
 * before this ledger row. Evidence and the original receipt hash are retained. */
export async function applyCostCorrectionInTransaction(tx: Db, publications: ActivityPublication[], input: CostCorrectionInput) {
  const { companyId, eventId } = input;
  const expectedCents = normalizeCents(input.expectedCents);
  const correctedCents = normalizeCents(input.correctedCents);
  const hash = input.receiptHash ?? receiptFingerprint({ eventId, expectedCents, correctedCents,
    reason: input.reason, pricing: input.pricing, invoiceLineId: input.invoiceLineId ?? null, costStatus: input.costStatus,
    receiptUsage: input.receiptUsage });
  const [existing] = await tx.select().from(costAdjustments).where(and(
    eq(costAdjustments.companyId, companyId), eq(costAdjustments.idempotencyKey, input.idempotencyKey)));
  if (existing) {
    if (existing.receiptHash !== hash) throw conflict("Correction key already has different contents");
    return existing;
  }
  const [event] = await tx.select({ event: costEvents, exact: sql<string>`${costEvents.costCents}::text` }).from(costEvents)
    .where(and(eq(costEvents.companyId, companyId), eq(costEvents.id, eventId))).for("update");
  if (!event) throw notFound("Cost event not found");
  if (normalizeCents(event.exact) !== expectedCents) throw conflict("Charge changed since review; review it again");
  const [adjustment] = await tx.insert(costAdjustments).values({ companyId, costEventId: eventId,
    invoiceLineId: input.invoiceLineId, idempotencyKey: input.idempotencyKey, receiptHash: hash,
    previousCents: expectedCents, correctedCents, previousStatus: event.event.costStatus,
    previousPricing: event.event.pricingProvenance ?? {},
    previousUsageJson: input.receiptUsage ? { inputTokens: event.event.inputTokens, cachedInputTokens: event.event.cachedInputTokens,
      outputTokens: event.event.outputTokens, providerRequestId: event.event.providerRequestId } : null,
    reason: input.reason, actorId: input.actorId,
    pricing: input.pricing }).onConflictDoNothing().returning();
  if (!adjustment) throw Object.assign(new Error("Concurrent correction requires a fresh snapshot"), { code: "40001" });
  const [updated] = await tx.update(costEvents).set({ costCents: sql`${correctedCents}::numeric`,
    reportedCostCents: event.event.reportedCostCents ?? normalizeCents(event.exact),
    ...(input.receiptUsage ? { ...input.receiptUsage, reportedUsageJson: event.event.reportedUsageJson ?? {
      inputTokens: event.event.inputTokens, cachedInputTokens: event.event.cachedInputTokens,
      outputTokens: event.event.outputTokens, providerRequestId: event.event.providerRequestId,
    } } : {}),
    costStatus: input.costStatus ?? (input.pricing.source === "rate_card" ? "estimated" : "reported"), pricingProvenance: input.pricing,
  }).where(and(eq(costEvents.id, eventId), eq(costEvents.companyId, companyId))).returning();
  await queueBudgetEvaluation(tx, { companyId, agentId: updated.agentId, projectId: updated.projectId });
  await logActivity(tx, { companyId, actorType: input.actorId === "cost_accounting" ? "system" : "user", actorId: input.actorId,
    action: "accounting.charge_corrected", entityType: "cost_event", entityId: eventId,
    details: { adjustmentId: adjustment.id, previousCents: expectedCents, correctedCents, reason: input.reason, pricing: input.pricing },
  }, publications);
  return adjustment;
}
