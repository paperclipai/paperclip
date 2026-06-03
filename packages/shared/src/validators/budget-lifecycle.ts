import { z } from "zod";

// Request bodies for the budgeting lifecycle endpoints (agent-budgeting policy
// §4.1 preflight and §4.2 charge). Both carry the §2.1 cost-attribution
// dimensions. `agentId` is nullable: source-less timer/system charges (e.g. a
// provider-health probe) are first-class and attribute to no agent (§2.1).

const COST_KINDS = [
  "tokens",
  "requests",
  "seconds",
  "storage_bytes_day",
  "egress_bytes",
  "storage_bytes",
  "fixed",
] as const;

// Shared attribution dimensions. companyId is the tenant boundary (never null);
// every other dimension is optional and defaults to the runtime context.
const attribution = {
  companyId: z.string().uuid(),
  agentId: z.string().uuid().optional().nullable(),
  userId: z.string().optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  runId: z.string().uuid().optional().nullable(),
  billingCode: z.string().min(1).optional().nullable(),
  provider: z.string().min(1),
  model: z.string().min(1),
  kind: z.enum(COST_KINDS).optional().default("tokens"),
};

export const preflightRequestSchema = z.object({
  ...attribution,
  estimatedQty: z.number().nonnegative().optional().default(0),
  // Adapter-computed estimate using the current pricebook (§4.1). Caps are
  // evaluated against window spend + this estimate so the prospective call is
  // included in the decision.
  estimatedCostMicros: z.number().int().nonnegative().optional().default(0),
});
export type PreflightRequest = z.infer<typeof preflightRequestSchema>;

export const chargeRequestSchema = z
  .object({
    ...attribution,
    qty: z.number().nonnegative().optional().default(0),
    inputTokens: z.number().int().nonnegative().optional().default(0),
    cachedInputTokens: z.number().int().nonnegative().optional().default(0),
    outputTokens: z.number().int().nonnegative().optional().default(0),
    cacheWriteTokens: z.number().int().nonnegative().optional().nullable(),
    // Frozen pricing. The server records cost_micros; it is computed as
    // ceil(qty * unitPriceMicros) when unitPriceMicros is supplied, otherwise the
    // adapter-supplied costMicros is recorded verbatim (a server-side pricebook
    // resolver is ELI-74's surface and plugs in here when present).
    unitPriceMicros: z.number().int().nonnegative().optional().nullable(),
    costMicros: z.number().int().nonnegative().optional().nullable(),
    currency: z.string().length(3).optional().default("USD"),
    pricebookVersion: z.string().optional().nullable(),
    requestId: z.string().optional().nullable(),
    // Deduplicates retries (§2.1). Unique in cost_events; a repeat returns the
    // original row with no double-charge.
    idempotencyKey: z.string().min(1),
    meta: z.record(z.unknown()).optional().nullable(),
    occurredAt: z.string().datetime().optional(),
  })
  .refine((v) => v.costMicros != null || v.unitPriceMicros != null, {
    message: "one of costMicros or unitPriceMicros is required",
    path: ["costMicros"],
  });
export type ChargeRequest = z.infer<typeof chargeRequestSchema>;
