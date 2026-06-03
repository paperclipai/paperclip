import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";
import {
  type BudgetCapAction,
  type PreflightDecision,
  enforcementResponse,
  preflightDecision,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { budgetCapsService, type ChargeAttribution } from "./budget-caps.js";
import { loadPreflightConfig, type PreflightConfig, loadEnforcementConfig } from "./budgeting-config.js";
import { approvals, issueApprovals, issues } from "@paperclipai/db";
import { issueService } from "./issues.js";

// POST /cost/preflight and POST /cost/charge (agent-budgeting policy §4). The
// preflight read is side-effect-free and bounded by evaluationBudgetMillis; the
// charge write is idempotent on idempotencyKey, refreshes the per-window
// aggregate (via the cost_events insert trigger), evaluates caps, and signals
// §4.3 enforcement codes when the charge crosses an enforcing cap.

export interface PreflightInput extends ChargeAttribution {
  estimatedCostMicros?: number;
  estimatedQty?: number;
  kind?: string;
}

export interface PreflightResult {
  decision: PreflightDecision;
  bindingCapId: string | null;
  headroomMicros: number | null;
  softHeadroomMicros: number | null;
  warnings: Array<{ capId: string; percent: number }>;
  approvalIds: string[];
  // True when the evaluation exceeded evaluationBudgetMillis and the configured
  // timeout action was applied (§4.1).
  evaluationTimedOut: boolean;
  preflightRequired: boolean;
}

export interface ChargeInput extends ChargeAttribution {
  qty?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number | null;
  unitPriceMicros?: number | null;
  costMicros?: number | null;
  currency?: string;
  pricebookVersion?: string | null;
  requestId?: string | null;
  idempotencyKey: string;
  userId?: string | null;
  runId?: string | null;
  meta?: Record<string, unknown> | null;
  occurredAt?: Date;
  kind?: string;
}

export interface ChargeResult {
  id: string;
  costMicros: number;
  headroomMicros: number | null;
  alertsFired: BudgetCapAction[];
  idempotent: boolean;
}

const MICROS_PER_CENT = 10_000; // 1 USD = 1_000_000 micros = 100 cents

// Round costMicros UP (policy §7.4: never round costs down).
function resolveCostMicros(input: ChargeInput): number {
  if (input.costMicros != null) return input.costMicros;
  const qty = input.qty ?? 0;
  const unit = input.unitPriceMicros ?? 0;
  return Math.ceil(qty * unit);
}

function uniqueActions(actions: Array<BudgetCapAction | null>): BudgetCapAction[] {
  return [...new Set(actions.filter((a): a is BudgetCapAction => a != null))];
}

export function budgetLifecycleService(
  db: Db,
  opts: { config?: PreflightConfig } = {},
) {
  const caps = budgetCapsService(db);
  const config = opts.config ?? loadPreflightConfig();

  return {
    config,

    async preflight(input: PreflightInput): Promise<PreflightResult> {
      const at = new Date();
      const addMicros = input.estimatedCostMicros ?? 0;

      // Bound the evaluation to evaluationBudgetMillis (§4.1). On timeout we
      // either fail-open (allow_with_metric) or fail-closed (deny).
      let timedOut = false;
      const evaluation = await Promise.race([
        caps.evaluate(input, { at, addMicros }).then((r) => ({ ok: true as const, r })),
        new Promise<{ ok: false }>((resolve) =>
          setTimeout(() => resolve({ ok: false }), config.evaluationBudgetMillis),
        ),
      ]);

      if (!evaluation.ok) {
        timedOut = true;
        const decision: PreflightDecision =
          config.evaluationTimeoutAction === "deny" ? "deny" : "allow";
        return {
          decision,
          bindingCapId: null,
          headroomMicros: null,
          softHeadroomMicros: null,
          warnings: [],
          approvalIds: [],
          evaluationTimedOut: true,
          preflightRequired: true,
        };
      }

      const { resolution, headroomMicros, softHeadroomMicros, warnings } = evaluation.r;
      const hasUnmetGate = resolution.approvalGates.length > 0;
      const decision = preflightDecision(resolution.action, hasUnmetGate);

      // Preflight is mandatory for this call (§4.1) when the estimate clears the
      // threshold or any binding cap is already at/above the critical percent.
      const preflightRequired =
        addMicros >= config.estimateThresholdMicros ||
        warnings.some((w) => w.percent >= config.criticalPreflightPercent) ||
        input.kind !== "tokens";

      return {
        decision,
        bindingCapId: resolution.binding?.capId ?? null,
        headroomMicros,
        softHeadroomMicros,
        warnings,
        // Approval grant lookup is the runtime gate's surface (ELI-77); until
        // then preflight reports no pre-existing unblocking approvals.
        approvalIds: [],
        evaluationTimedOut: timedOut,
        preflightRequired,
      };
    },

    async charge(input: ChargeInput): Promise<ChargeResult> {
      // Idempotency (§2.1): a repeat of the same idempotencyKey returns the
      // original row with no double-charge and no re-enforcement.
      const existing = await db
        .select({ id: costEvents.id, costMicros: costEvents.costMicros })
        .from(costEvents)
        .where(eq(costEvents.idempotencyKey, input.idempotencyKey))
        .then((rows) => rows[0]);

      if (existing) {
        const post = await caps.evaluate(input, { at: new Date(), addMicros: 0 });
        return {
          id: existing.id,
          costMicros: Number(existing.costMicros ?? 0),
          headroomMicros: post.headroomMicros,
          alertsFired: [],
          idempotent: true,
        };
      }

      const occurredAt = input.occurredAt ?? new Date();
      const costMicros = resolveCostMicros(input);

      const inserted = await db
        .insert(costEvents)
        .values({
          companyId: input.companyId,
          agentId: input.agentId ?? null,
          userId: input.userId ?? null,
          issueId: input.issueId ?? null,
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          heartbeatRunId: input.runId ?? null,
          billingCode: input.billingCode ?? null,
          provider: input.provider,
          model: input.model,
          kind: input.kind ?? "tokens",
          qty: input.qty != null ? String(input.qty) : null,
          inputTokens: input.inputTokens ?? 0,
          cachedInputTokens: input.cachedInputTokens ?? 0,
          outputTokens: input.outputTokens ?? 0,
          cacheWriteTokens: input.cacheWriteTokens ?? null,
          // Legacy integer-cents mirror kept for back-compat readers.
          costCents: Math.ceil(costMicros / MICROS_PER_CENT),
          unitPriceMicros: input.unitPriceMicros ?? null,
          costMicros,
          currency: input.currency ?? "USD",
          pricebookVersion: input.pricebookVersion ?? null,
          requestId: input.requestId ?? null,
          idempotencyKey: input.idempotencyKey,
          meta: input.meta ?? null,
          occurredAt,
        })
        .returning({ id: costEvents.id })
        .then((rows) => rows[0]);

      // Post-charge evaluation: the row is already folded into the aggregate by
      // the insert trigger, so addMicros = 0.
      const post = await caps.evaluate(input, { at: occurredAt, addMicros: 0 });
      const alertsFired = uniqueActions(post.firing.map((f) => f.action));

      const result: ChargeResult = {
        id: inserted.id,
        costMicros,
        headroomMicros: post.headroomMicros,
        alertsFired,
        idempotent: false,
      };

      // §4.3: if this charge crossed an enforcing cap, surface the enforcement
      // code. The row is already recorded (cost incurred → auditability
      // preserved); the id travels in the error body so the caller is not blind.
      const enforce = enforcementResponse(post.resolution.action);
      if (enforce) {
        throw new HttpError(enforce.status, enforce.code, result);
      }

      return result;
    },
  };
}

export type BudgetLifecycleService = ReturnType<typeof budgetLifecycleService>;
