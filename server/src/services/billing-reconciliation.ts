import { createFinanceEventInTransaction } from "./finance.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { fastResponseRequests, decisionInvocations, budgetReservations, agentRuntimeState, costEvents, costAdjustments, billingInvoices, billingInvoiceLines, financeEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { adjustCostSchema, importBillingInvoiceSchema, normalizeCents, subtractCents, type AdjustCost, type ImportBillingInvoice } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { withAccountingReadSnapshot, withAccountingTransaction } from "./accounting-transaction.js";
import { receiptFingerprint } from "./receipt-fingerprint.js";
import { logActivity } from "./activity-log.js";
import { updateMonthlySpendProjections } from "./costs.js";
import { budgetServiceInTransaction, deliverBudgetEnforcement, type BudgetServiceHooks } from "./budgets.js";

async function invoiceCostCandidates(tx: Db, companyId: string, biller: string, line: {
  costEventId?: string | null; runId?: string | null; providerRequestId?: string | null; model?: string | null;
}) {
  if (!(line.costEventId || line.runId || line.providerRequestId)) return [];
  return tx.select({ id: costEvents.id, cents: sql<string>`${costEvents.costCents}::text`, status: costEvents.costStatus })
    .from(costEvents).where(and(eq(costEvents.companyId, companyId), eq(costEvents.biller, biller),
      line.costEventId ? eq(costEvents.id, line.costEventId) : undefined,
      line.runId ? eq(costEvents.heartbeatRunId, line.runId) : undefined,
      line.providerRequestId ? eq(costEvents.providerRequestId, line.providerRequestId) : undefined,
      line.model ? eq(costEvents.model, line.model) : undefined)).limit(2);
}

export function billingReconciliationService(db: Db, hooks: BudgetServiceHooks = {}) {
  return {
    importInvoice: (companyId: string, raw: ImportBillingInvoice, actorId: string) => withAccountingTransaction(db, companyId, async (tx, publications) => {
      const input = importBillingInvoiceSchema.parse(raw);
      // Line order in an export is not part of invoice identity.
      input.lines.sort((a,b) => a.externalId.localeCompare(b.externalId));
      const receiptHash = receiptFingerprint(input);
      const [existing] = await tx.select().from(billingInvoices).where(and(eq(billingInvoices.companyId, companyId), eq(billingInvoices.biller, input.biller), eq(billingInvoices.externalId, input.externalId)));
      if (existing) {
        if (existing.receiptHash !== receiptHash) throw conflict("Invoice identifier already has different contents");
        return existing;
      }
      // Validate explicit references, even on non-USD invoices that we cannot
      // compare with the USD cost ledger. Never infer cross-company matches.
      for (const line of input.lines) {
        if (line.costEventId) {
          const [event] = await tx.select({ id: costEvents.id }).from(costEvents).where(and(eq(costEvents.companyId, companyId), eq(costEvents.id, line.costEventId)));
          if (!event) throw notFound("Invoice cost event not found");
        }
        if (line.runId) {
          const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, line.runId)));
          if (!run) throw notFound("Invoice run not found");
        }
      }
      const [invoice] = await tx.insert(billingInvoices).values({ companyId, biller: input.biller, externalId: input.externalId, currency: input.currency, receiptHash, importedBy: actorId }).returning();
      await tx.insert(billingInvoiceLines).values(input.lines.map(line => ({ ...line, companyId, invoiceId: invoice.id, occurredAt: new Date(line.occurredAt), pricing: line.pricing ?? {} })));
      const matches = [];
      const matchCounts = new Map<string, number>();
      for (const line of input.lines) {
        const candidates = line.kind === "inference" ? await invoiceCostCandidates(tx, companyId, input.biller, line) : [];
        matches.push({ line, candidates });
        if (candidates.length === 1) matchCounts.set(candidates[0].id, (matchCounts.get(candidates[0].id) ?? 0) + 1);
      }
      for (const { line, candidates } of matches) {
        // Ambiguous evidence cannot authorize another debit. Keep every line
        // for reconciliation, including differences from an existing charge.
        if (candidates.length > 1 || candidates.length === 1 && matchCounts.get(candidates[0].id)! > 1) continue;
        const costEventId = line.costEventId ?? candidates[0]?.id;
        if (line.kind === "inference" && costEventId) {
          const [recorded] = await tx.select({ id: financeEvents.id }).from(financeEvents).where(and(
            eq(financeEvents.companyId, companyId), eq(financeEvents.costEventId, costEventId),
            eq(financeEvents.biller, input.biller), eq(financeEvents.currency, input.currency),
            eq(financeEvents.eventKind, "inference_charge"), eq(financeEvents.direction, "debit"),
            sql`${financeEvents.metadataJson}->>'source' is distinct from 'provider_cost_report'`,
          )).limit(1);
          if (recorded) continue;
        }
        await createFinanceEventInTransaction(tx, publications, companyId, {
          idempotencyKey: `invoice:${invoice.id}:${receiptFingerprint(line.externalId)}`,
          biller: input.biller, externalInvoiceId: input.externalId,
          eventKind: line.kind === "inference" ? "inference_charge" : line.kind === "credit" ? "credit_refund" : "platform_fee",
          direction: line.kind === "credit" ? "credit" : "debit",
          amountCents: line.amountCents, currency: input.currency, occurredAt: new Date(line.occurredAt),
          description: `Invoice ${input.externalId} · ${line.externalId}`.slice(0, 500),
          costEventId, heartbeatRunId: line.runId,
          metadataJson: { source: "provider_invoice", invoiceId: invoice.id, externalLineId: line.externalId },
        }, { actorType: "user", actorId });
      }
      await logActivity(tx, { companyId, actorType: "user", actorId, action: "accounting.invoice_imported", entityType: "billing_invoice", entityId: invoice.id,
        details: { biller: invoice.biller, externalId: invoice.externalId, currency: invoice.currency, lineCount: input.lines.length, receiptHash } }, publications);
      return invoice;
    }),
    list: (companyId: string) => db.select().from(billingInvoices).where(eq(billingInvoices.companyId, companyId)).orderBy(desc(billingInvoices.createdAt)).limit(100),
    reconcile: (companyId: string, invoiceId: string) => withAccountingReadSnapshot(db, companyId, async tx => {
      const [invoice] = await tx.select().from(billingInvoices).where(and(eq(billingInvoices.companyId, companyId), eq(billingInvoices.id, invoiceId)));
      if (!invoice) throw notFound("Invoice not found");
      const lines = await tx.select().from(billingInvoiceLines).where(and(eq(billingInvoiceLines.companyId, companyId), eq(billingInvoiceLines.invoiceId, invoiceId))).orderBy(billingInvoiceLines.externalId);
      const rows = [];
      for (const line of lines) {
        const candidates = invoice.currency !== "USD" || line.kind !== "inference" ? []
          : await invoiceCostCandidates(tx, companyId, invoice.biller, line);
        const match = candidates.length === 1 ? candidates[0] : null;
        const differenceCents = match ? subtractCents(line.amountCents, match.cents) : null;
        const status = invoice.currency !== "USD" ? "unsupported_currency" : line.kind !== "inference" ? "non_inference"
          : candidates.length > 1 ? "ambiguous" : !match ? "unmatched" : differenceCents === "0.0000000" && match.status !== "unpriced" ? "matched" : "difference";
        rows.push({ ...line, amountCents: normalizeCents(line.amountCents), status, matchedEventId: match?.id ?? null,
          recordedCents: match ? normalizeCents(match.cents) : null, differenceCents });
      }
      // Multiple invoice lines cannot independently revalue the same charge.
      const counts = new Map<string, number>();
      for (const row of rows) if (row.matchedEventId) counts.set(row.matchedEventId, (counts.get(row.matchedEventId) ?? 0) + 1);
      for (const row of rows) if (row.matchedEventId && counts.get(row.matchedEventId)! > 1) row.status = "ambiguous";
      return { invoice, lines: rows };
    }),
    adjustments: (companyId: string, eventId: string) => db.select().from(costAdjustments).where(and(eq(costAdjustments.companyId, companyId), eq(costAdjustments.costEventId, eventId))).orderBy(desc(costAdjustments.createdAt)),
    adjust: async (companyId: string, eventId: string, raw: AdjustCost, actorId: string) => {
      const input = adjustCostSchema.parse(raw);
      const result = await withAccountingTransaction(db, companyId, async (tx, publications) => {
        const hash = receiptFingerprint({ eventId, ...input });
        const [existing] = await tx.select().from(costAdjustments).where(and(eq(costAdjustments.companyId, companyId), eq(costAdjustments.idempotencyKey, input.idempotencyKey)));
        if (existing) {
          if (existing.receiptHash !== hash) throw conflict("Correction key already has different contents");
          return existing;
        }
        const [event] = await tx.select({ event: costEvents, exact: sql<string>`${costEvents.costCents}::text` }).from(costEvents)
          .where(and(eq(costEvents.companyId, companyId), eq(costEvents.id, eventId))).for("update");
        if (!event) throw notFound("Cost event not found");
        if (normalizeCents(event.exact) !== input.expectedCents) throw conflict("Charge changed since review; review it again");
        if (input.invoiceLineId) {
          const reportLine = await tx.select({ line: billingInvoiceLines, invoice: billingInvoices }).from(billingInvoiceLines)
            .innerJoin(billingInvoices, eq(billingInvoices.id, billingInvoiceLines.invoiceId)).where(and(eq(billingInvoiceLines.id, input.invoiceLineId), eq(billingInvoiceLines.companyId, companyId), eq(billingInvoices.companyId, companyId)));
          const row = reportLine[0];
          if (!row) throw notFound("Invoice line not found");
          if (row.invoice.currency !== "USD" || row.line.kind !== "inference" || row.invoice.biller !== event.event.biller
            || normalizeCents(row.line.amountCents) !== input.correctedCents
            || row.line.costEventId && row.line.costEventId !== eventId
            || row.line.runId && row.line.runId !== event.event.heartbeatRunId
            || row.line.providerRequestId && row.line.providerRequestId !== event.event.providerRequestId
            || row.line.model && row.line.model !== event.event.model) throw unprocessable("Invoice line does not support this correction");
          const review = await billingReconciliationService(tx).reconcile(companyId, row.invoice.id);
          const reviewedLine = review.lines.find(line => line.id === input.invoiceLineId);
          if (!reviewedLine || !["matched", "difference"].includes(reviewedLine.status) || reviewedLine.matchedEventId !== eventId)
            throw unprocessable("Invoice match is ambiguous or unverified; review an explicit correction without attaching this line");
          const [used] = await tx.select().from(costAdjustments).where(and(eq(costAdjustments.companyId, companyId), eq(costAdjustments.invoiceLineId, input.invoiceLineId)));
          if (used) throw conflict("Invoice line has already been applied");
        }
        const [adjustment] = await tx.insert(costAdjustments).values({ companyId, costEventId: eventId, invoiceLineId: input.invoiceLineId,
          idempotencyKey: input.idempotencyKey, receiptHash: hash, previousCents: input.expectedCents, correctedCents: input.correctedCents,
          previousStatus: event.event.costStatus, previousPricing: event.event.pricingProvenance ?? {},
          reason: input.reason, actorId, pricing: input.pricing }).returning();
        // Original provider value and fingerprint remain immutable. cost_cents
        // is the effective valuation, backed by this append-only correction.
        const [updated] = await tx.update(costEvents).set({ costCents: sql`${input.correctedCents}::numeric`,
          reportedCostCents: event.event.reportedCostCents ?? normalizeCents(event.exact), costStatus: input.pricing.source === "rate_card" ? "estimated" : "reported", pricingProvenance: input.pricing,
        }).where(eq(costEvents.id, eventId)).returning();
        await updateMonthlySpendProjections(tx, companyId, updated.agentId, subtractCents(input.correctedCents, input.expectedCents), updated.occurredAt);
        if (updated.heartbeatRunId && updated.agentId) {
          const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, updated.heartbeatRunId), eq(heartbeatRuns.companyId, companyId)));
          if (run?.costAccountedAt && run.accountingProjectionVersion === "v2") await tx.update(agentRuntimeState)
            .set({ totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${subtractCents(input.correctedCents, input.expectedCents)}::numeric`, updatedAt: new Date() })
            .where(and(eq(agentRuntimeState.agentId, updated.agentId), eq(agentRuntimeState.companyId, companyId)));
        }
        if (updated.usageKind === "decision") {
          const [invocation] = await tx.select({ id: decisionInvocations.id }).from(decisionInvocations).where(and(
            eq(decisionInvocations.companyId, companyId), eq(decisionInvocations.costEventId, eventId),
          ));
          if (invocation) await tx.update(budgetReservations).set({ state: "settled", settledAt: new Date() }).where(and(
            eq(budgetReservations.companyId, companyId), eq(budgetReservations.decisionInvocationId, invocation.id), eq(budgetReservations.state, "held"),
          ));
        }
        if (updated.usageKind === "fast_response") {
          const [invocation] = await tx.select({ id: fastResponseRequests.id }).from(fastResponseRequests).where(and(eq(fastResponseRequests.companyId, companyId), eq(fastResponseRequests.costEventId, eventId)));
          if (invocation) await tx.update(budgetReservations).set({ state: "settled", settledAt: new Date() }).where(and(eq(budgetReservations.companyId, companyId), eq(budgetReservations.fastResponseRequestId, invocation.id), eq(budgetReservations.state, "held")));
        }
        const budgets = budgetServiceInTransaction(tx, publications);
        await budgets.evaluateCostEvent(updated);
        await budgets.getInvocationBlock(companyId, updated.agentId, { projectId: updated.projectId });
        await logActivity(tx, { companyId, actorType: "user", actorId, action: "accounting.charge_corrected", entityType: "cost_event", entityId: eventId,
          details: { adjustmentId: adjustment.id, previousCents: input.expectedCents, correctedCents: input.correctedCents, reason: input.reason, pricing: input.pricing } }, publications);
        return adjustment;
      });
      await deliverBudgetEnforcement(db, hooks, companyId);
      return result;
    },
  };
}
