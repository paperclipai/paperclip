import { z } from "zod";
import { AGENT_ADAPTER_TYPES, FINANCE_DIRECTIONS, FINANCE_EVENT_KINDS, FINANCE_UNITS } from "../constants.js";

export const createFinanceEventSchema = z.object({
  agentId: z.string().uuid().optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  heartbeatRunId: z.string().uuid().optional().nullable(),
  costEventId: z.string().uuid().optional().nullable(),
  billingCode: z.string().optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  eventKind: z.enum(FINANCE_EVENT_KINDS),
  direction: z.enum(FINANCE_DIRECTIONS).optional().default("debit"),
  biller: z.string().min(1),
  provider: z.string().min(1).optional().nullable(),
  executionAdapterType: z.enum(AGENT_ADAPTER_TYPES).optional().nullable(),
  pricingTier: z.string().min(1).optional().nullable(),
  region: z.string().min(1).optional().nullable(),
  model: z.string().min(1).optional().nullable(),
  quantity: z.number().int().nonnegative().optional().nullable(),
  unit: z.enum(FINANCE_UNITS).optional().nullable(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().length(3).optional().default("USD"),
  estimated: z.boolean().optional().default(false),
  externalInvoiceId: z.string().optional().nullable(),
  metadataJson: z.record(z.string(), z.unknown()).optional().nullable(),
  occurredAt: z.string().datetime(),
}).transform((value) => ({
  ...value,
  currency: value.currency.toUpperCase(),
}));

export type CreateFinanceEvent = z.infer<typeof createFinanceEventSchema>;
