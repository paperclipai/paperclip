import { BILLING_TYPES, type BillingType } from "@paperclipai/shared";
import { z } from "zod";
import { badRequest } from "../errors.js";

export interface CostEventCursorFilterInput {
  from?: Date;
  to?: Date;
  billingTypes?: BillingType[];
}

export interface CostEventCursorPosition {
  occurredAt: string;
  id: string;
}

export interface NormalizedCostEventCursorFilters {
  from: string | null;
  to: string | null;
  billingTypes: BillingType[];
}

const cursorSchema = z.object({
  v: z.literal(1),
  filters: z.object({
    from: z.string().datetime().nullable(),
    to: z.string().datetime().nullable(),
    billingTypes: z.array(z.enum(BILLING_TYPES)),
  }).strict(),
  position: z.object({
    occurredAt: z.string().datetime(),
    id: z.string().uuid(),
  }).strict(),
}).strict();

export function normalizeCostEventCursorFilters(
  input: CostEventCursorFilterInput,
): NormalizedCostEventCursorFilters {
  return {
    from: input.from?.toISOString() ?? null,
    to: input.to?.toISOString() ?? null,
    billingTypes: [...new Set(input.billingTypes ?? [])].sort(),
  };
}

export function encodeCostEventCursor(
  filters: NormalizedCostEventCursorFilters,
  position: CostEventCursorPosition,
): string {
  const payload = cursorSchema.parse({ v: 1, filters, position });
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCostEventCursor(
  cursor: string | undefined,
  expectedFilters: NormalizedCostEventCursorFilters,
): CostEventCursorPosition | null {
  if (cursor === undefined) return null;
  if (cursor.length > 4096) throw badRequest("Invalid cost-events cursor");

  let payload: z.infer<typeof cursorSchema>;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    payload = cursorSchema.parse(JSON.parse(decoded));
  } catch {
    throw badRequest("Invalid cost-events cursor");
  }

  const matchesFilters = payload.filters.from === expectedFilters.from
    && payload.filters.to === expectedFilters.to
    && payload.filters.billingTypes.length === expectedFilters.billingTypes.length
    && payload.filters.billingTypes.every((value, index) => value === expectedFilters.billingTypes[index]);

  if (!matchesFilters) {
    throw badRequest("Cost-events cursor does not match request filters");
  }

  return payload.position;
}
