import { z } from "zod";
import {
  BUDGET_INCIDENT_RESOLUTION_ACTIONS,
  BUDGET_METRICS,
  BUDGET_SCOPE_TYPES,
  BUDGET_WINDOW_KINDS,
} from "../constants.js";

export const upsertBudgetPolicySchema = z.object({
  scopeType: z.enum(BUDGET_SCOPE_TYPES),
  scopeId: z.string().uuid(),
  metric: z.enum(BUDGET_METRICS).optional().default("billed_cents"),
  windowKind: z.enum(BUDGET_WINDOW_KINDS).optional().default("calendar_month_utc"),
  amount: z.number().int().nonnegative(),
  warnPercent: z.number().int().min(1).max(99).optional().default(80),
  hardStopEnabled: z.boolean().optional().default(true),
  notifyEnabled: z.boolean().optional().default(true),
  isActive: z.boolean().optional().default(true),
});

export type UpsertBudgetPolicy = z.infer<typeof upsertBudgetPolicySchema>;

export const resolveBudgetIncidentSchema = z.object({
  action: z.enum(BUDGET_INCIDENT_RESOLUTION_ACTIONS),
  amount: z.number().int().nonnegative().optional(),
  decisionNote: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.action === "raise_budget_and_resume" && typeof value.amount !== "number") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "amount is required when raising a budget",
      path: ["amount"],
    });
  }
});

export type ResolveBudgetIncident = z.infer<typeof resolveBudgetIncidentSchema>;
