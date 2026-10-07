import { z } from "zod";
import { centsToUnits, normalizeCents } from "./money.js";

export const exactCentsSchema = z.union([z.string().max(160), z.number().finite()]).transform((value, ctx) => {
  try {
    if ((typeof value === "number" ? value < 0 : value.startsWith("-")) || centsToUnits(value) < 0n) throw new Error("Money cannot be negative");
    return normalizeCents(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid money" });
    return z.NEVER;
  }
});
export const pricingProvenanceSchema = z.object({
  source: z.enum(["provider_reported", "provider_invoice", "operator", "rate_card", "unknown"]).default("unknown"),
  version: z.string().max(100).optional(),
  evidence: z.string().max(1000).optional(),
  inputCentsPerMillion: exactCentsSchema.optional(),
  cachedInputCentsPerMillion: exactCentsSchema.optional(),
  outputCentsPerMillion: exactCentsSchema.optional(),
  cacheWriteCentsPerMillion: exactCentsSchema.optional(),
  serviceTier: z.string().max(50).optional(),
  contextTier: z.enum(["short", "long"]).optional(),
});
export const importBillingInvoiceSchema = z.object({
  biller: z.string().trim().min(1).max(150),
  externalId: z.string().trim().min(1).max(200),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform(value => value.toUpperCase()),
  lines: z.array(z.object({
    externalId: z.string().trim().min(1).max(200),
    kind: z.enum(["inference", "fee", "credit"]).default("inference"),
    amountCents: exactCentsSchema,
    occurredAt: z.iso.datetime({ offset: true }),
    costEventId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
    providerRequestId: z.string().min(1).max(250).optional(),
    model: z.string().min(1).max(250).optional(),
    pricing: pricingProvenanceSchema.optional(),
  })).min(1).max(2000),
}).superRefine((invoice, ctx) => {
  if (new Set(invoice.lines.map(line => line.externalId)).size !== invoice.lines.length)
    ctx.addIssue({ code: "custom", path: ["lines"], message: "Invoice line identifiers must be unique" });
});
export const adjustCostSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  expectedCents: exactCentsSchema,
  correctedCents: exactCentsSchema,
  invoiceLineId: z.string().uuid().optional(),
  reason: z.string().trim().min(1).max(1000),
  pricing: pricingProvenanceSchema,
});
export const repairAccountingSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(1000) });
export const retryAccountingSchema = z.object({ runId: z.string().uuid() });
export const importProviderCostsSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  secretId: z.string().uuid(),
  accountId: z.string().trim().min(1).max(150).regex(/^[a-zA-Z0-9_-]+$/),
  scopeIds: z.array(z.string().trim().min(1).max(150)).min(1).max(25),
  from: z.iso.date(),
  to: z.iso.date(),
}).superRefine((input, ctx) => {
  const duration = Date.parse(input.to) - Date.parse(input.from);
  if (duration <= 0 || duration > 31 * 86400000 || Date.parse(input.to) > Math.floor(Date.now() / 86400000) * 86400000)
    ctx.addIssue({ code: "custom", message: "Choose up to 31 completed UTC days; the end date is exclusive." });
  if (new Set(input.scopeIds).size !== input.scopeIds.length)
    ctx.addIssue({ code: "custom", message: "Project/workspace identifiers must be unique." });
});
export type ImportProviderCosts = z.input<typeof importProviderCostsSchema>;
export type ImportBillingInvoice = z.input<typeof importBillingInvoiceSchema>;
export type AdjustCost = z.input<typeof adjustCostSchema>;
export interface AccountingFinding {
  kind: "company_projection" | "agent_projection" | "runtime_projection" | "missing_receipt" | "missing_acknowledgement" | "legacy_runtime" | "receipt_mismatch";
  entityId: string;
  repairable: boolean;
  actual: Record<string, string>;
  expected: Record<string, string>;
}
export interface AccountingInspection {
  companyId: string;
  fingerprint: string;
  findings: AccountingFinding[];
  checkedAt: string;
}
export interface AccountingHealth {
  companyId: string;
  pendingRunCount: number;
  unpricedEventCount: number;
  oldestPendingAt: string | null;
  pendingCancellationCount: number;
  heldReservationCents: string;
  items: Array<{ runId: string | null; costEventId?: string; agentId: string; state: "waiting_for_receipt" | "retryable" | "unpriced"; lastError: string | null; attempts: number; since: string; lastAttemptAt: string | null }>;
}
export interface BillingInvoice {
  id: string; companyId: string; biller: string; externalId: string; currency: string; createdAt: string;
}
export interface CostAdjustment {
  id: string;
  companyId: string;
  costEventId: string;
  invoiceLineId: string | null;
  idempotencyKey: string;
  receiptHash: string;
  previousCents: string;
  correctedCents: string;
  previousStatus: string;
  previousPricing: Record<string, unknown>;
  pricing: Record<string, unknown>;
  reason: string;
  actorId: string;
  createdAt: string;
}
export interface BillingReconciliation {
  invoice: BillingInvoice;
  lines: Array<{ id: string; externalId: string; kind: string; amountCents: string; status: string;
    matchedEventId: string | null; recordedCents: string | null; differenceCents: string | null }>;
}
