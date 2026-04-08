import { and, asc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, heartbeatRuns } from "@paperclipai/db";

const DEFAULT_BILLING_TYPE = "subscription_included";
const SHADOW_COLUMN_MISSING_WARNING =
  "Database column cost_events.shadow_cost_cents is missing. Apply the migration that adds it before running --apply.";

type ShadowRateCard = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

// Verified against OpenAI API Pricing on 2026-04-06:
// https://openai.com/api/pricing/
const OPENAI_SHADOW_RATE_CARDS: Record<string, ShadowRateCard> = {
  "gpt-5.4": {
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
  },
};

export interface ShadowCostBackfillOptions {
  companyId: string;
  biller?: string;
  billingType?: string;
  force?: boolean;
  from?: Date;
  limit?: number;
  model?: string;
  provider?: string;
  to?: Date;
}

type ShadowBackfillCandidate = {
  id: string;
  companyId: string;
  provider: string;
  biller: string;
  billingType: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  currentShadowCostCents: number;
  heartbeatRunId: string | null;
  occurredAt: Date;
  usageJson: Record<string, unknown> | null;
};

export interface ShadowCostBackfillPlanRow {
  id: string;
  companyId: string;
  provider: string;
  biller: string;
  billingType: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  currentShadowCostCents: number;
  proposedShadowCostCents: number;
  deltaShadowCostCents: number;
  occurredAt: Date;
  heartbeatRunId: string | null;
  action: "update" | "skip";
  source: "openai_rate_card" | "heartbeat_usage_cost" | "self_hosted_zero" | "unsupported";
  reason:
    | "already_matches_target"
    | "existing_shadow_cost"
    | "missing_heartbeat_cost_usd"
    | "no_shadow_formula"
    | "self_hosted_zero"
    | "unsupported_model_rate_card"
    | "zero_shadow_cost"
    | null;
}

export interface ShadowCostBackfillPlan {
  columnPresent: boolean;
  warnings: string[];
  rows: ShadowCostBackfillPlanRow[];
  summary: {
    matchedRowCount: number;
    updateRowCount: number;
    skippedRowCount: number;
    unsupportedRowCount: number;
    existingShadowRowCount: number;
    zeroShadowRowCount: number;
    totalCurrentShadowCostCents: number;
    totalProposedShadowCostCents: number;
    totalDeltaShadowCostCents: number;
  };
}

export interface ShadowCostBackfillApplyResult {
  updatedCount: number;
  totalShadowCostCents: number;
  totalDeltaShadowCostCents: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeKey(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function roundUsdToCents(usd: number): number {
  return Math.max(0, Math.round(usd * 100));
}

function readUsageCostUsd(usageJson: Record<string, unknown> | null): number | null {
  if (!usageJson) return null;
  const aliases = ["costUsd", "cost_usd", "total_cost_usd"] as const;
  for (const key of aliases) {
    const parsed = asFiniteNumber(usageJson[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function calculateRateCardShadowCostCents(
  usage: Pick<ShadowBackfillCandidate, "inputTokens" | "cachedInputTokens" | "outputTokens">,
  rateCard: ShadowRateCard,
): number {
  const totalUsd =
    (usage.inputTokens / 1_000_000) * rateCard.inputUsdPerMillion +
    (usage.cachedInputTokens / 1_000_000) * rateCard.cachedInputUsdPerMillion +
    (usage.outputTokens / 1_000_000) * rateCard.outputUsdPerMillion;
  return roundUsdToCents(totalUsd);
}

export function calculateShadowCostForCandidate(candidate: ShadowBackfillCandidate): Pick<
  ShadowCostBackfillPlanRow,
  "proposedShadowCostCents" | "reason" | "source"
> {
  const provider = normalizeKey(candidate.provider);
  const model = normalizeKey(candidate.model);

  if (candidate.billingType !== DEFAULT_BILLING_TYPE) {
    return {
      proposedShadowCostCents: 0,
      source: "unsupported",
      reason: "no_shadow_formula",
    };
  }

  if (provider === "ollama") {
    return {
      proposedShadowCostCents: 0,
      source: "self_hosted_zero",
      reason: "self_hosted_zero",
    };
  }

  if (provider === "openai") {
    const rateCard = OPENAI_SHADOW_RATE_CARDS[model];
    if (!rateCard) {
      return {
        proposedShadowCostCents: 0,
        source: "unsupported",
        reason: "unsupported_model_rate_card",
      };
    }
    return {
      proposedShadowCostCents: calculateRateCardShadowCostCents(candidate, rateCard),
      source: "openai_rate_card",
      reason: null,
    };
  }

  if (provider === "anthropic") {
    const costUsd = readUsageCostUsd(candidate.usageJson);
    if (costUsd === null) {
      return {
        proposedShadowCostCents: 0,
        source: "unsupported",
        reason: "missing_heartbeat_cost_usd",
      };
    }
    return {
      proposedShadowCostCents: roundUsdToCents(costUsd),
      source: "heartbeat_usage_cost",
      reason: null,
    };
  }

  return {
    proposedShadowCostCents: 0,
    source: "unsupported",
    reason: "no_shadow_formula",
  };
}

function planBackfillRows(
  rows: ShadowBackfillCandidate[],
  force = false,
): ShadowCostBackfillPlanRow[] {
  return rows.map((row) => {
    const calculated = calculateShadowCostForCandidate(row);
    if (calculated.proposedShadowCostCents <= 0) {
      return {
        ...row,
        ...calculated,
        deltaShadowCostCents: 0,
        action: "skip",
        reason: calculated.reason ?? "zero_shadow_cost",
      };
    }

    if (!force && row.currentShadowCostCents > 0) {
      return {
        ...row,
        ...calculated,
        deltaShadowCostCents: 0,
        action: "skip",
        reason:
          row.currentShadowCostCents === calculated.proposedShadowCostCents
            ? "already_matches_target"
            : "existing_shadow_cost",
      };
    }

    if (row.currentShadowCostCents === calculated.proposedShadowCostCents) {
      return {
        ...row,
        ...calculated,
        deltaShadowCostCents: 0,
        action: "skip",
        reason: "already_matches_target",
      };
    }

    return {
      ...row,
      ...calculated,
      deltaShadowCostCents: calculated.proposedShadowCostCents - row.currentShadowCostCents,
      action: "update",
    };
  });
}

function summarizePlan(rows: ShadowCostBackfillPlanRow[]) {
  return {
    matchedRowCount: rows.length,
    updateRowCount: rows.filter((row) => row.action === "update").length,
    skippedRowCount: rows.filter((row) => row.action === "skip").length,
    unsupportedRowCount: rows.filter((row) => row.reason === "no_shadow_formula" || row.reason === "unsupported_model_rate_card" || row.reason === "missing_heartbeat_cost_usd").length,
    existingShadowRowCount: rows.filter((row) => row.reason === "existing_shadow_cost" || row.reason === "already_matches_target").length,
    zeroShadowRowCount: rows.filter((row) => row.reason === "zero_shadow_cost" || row.reason === "self_hosted_zero").length,
    totalCurrentShadowCostCents: rows.reduce((sum, row) => sum + row.currentShadowCostCents, 0),
    totalProposedShadowCostCents: rows.reduce((sum, row) => sum + row.proposedShadowCostCents, 0),
    totalDeltaShadowCostCents: rows.reduce((sum, row) => sum + row.deltaShadowCostCents, 0),
  };
}

function firstQueryRow<T extends Record<string, unknown>>(result: unknown): T | null {
  if (Array.isArray(result)) {
    return (result[0] as T | undefined) ?? null;
  }
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = (result as { rows?: unknown[] }).rows;
    if (Array.isArray(rows)) {
      return (rows[0] as T | undefined) ?? null;
    }
  }
  return null;
}

export function shadowCostBackfillService(db: Db) {
  return {
    async hasShadowCostColumn(): Promise<boolean> {
      const result = await db.execute(sql`
        select exists(
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'cost_events'
            and column_name = 'shadow_cost_cents'
        ) as present
      `);
      return Boolean(firstQueryRow<{ present?: boolean }>(result)?.present);
    },

    async plan(options: ShadowCostBackfillOptions): Promise<ShadowCostBackfillPlan> {
      const columnPresent = await this.hasShadowCostColumn();
      const warnings = columnPresent ? [] : [SHADOW_COLUMN_MISSING_WARNING];
      const conditions: SQL[] = [
        eq(costEvents.companyId, options.companyId),
        eq(costEvents.billingType, options.billingType ?? DEFAULT_BILLING_TYPE),
      ];

      if (options.provider) conditions.push(eq(costEvents.provider, options.provider));
      if (options.biller) conditions.push(eq(costEvents.biller, options.biller));
      if (options.model) conditions.push(eq(costEvents.model, options.model));
      if (options.from) conditions.push(gte(costEvents.occurredAt, options.from));
      if (options.to) conditions.push(lte(costEvents.occurredAt, options.to));

      const baseQuery = db
        .select({
          id: costEvents.id,
          companyId: costEvents.companyId,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          inputTokens: costEvents.inputTokens,
          cachedInputTokens: costEvents.cachedInputTokens,
          outputTokens: costEvents.outputTokens,
          costCents: costEvents.costCents,
          currentShadowCostCents: columnPresent ? costEvents.shadowCostCents : sql<number>`0`,
          heartbeatRunId: costEvents.heartbeatRunId,
          occurredAt: costEvents.occurredAt,
          usageJson: heartbeatRuns.usageJson,
        })
        .from(costEvents)
        .leftJoin(heartbeatRuns, eq(costEvents.heartbeatRunId, heartbeatRuns.id))
        .where(and(...conditions))
        .orderBy(asc(costEvents.occurredAt), asc(costEvents.id));

      const rows = await (typeof options.limit === "number"
        ? baseQuery.limit(options.limit)
        : baseQuery);

      const planRows = planBackfillRows(rows as ShadowBackfillCandidate[], options.force ?? false);

      return {
        columnPresent,
        warnings,
        rows: planRows,
        summary: summarizePlan(planRows),
      };
    },

    async apply(plan: ShadowCostBackfillPlan): Promise<ShadowCostBackfillApplyResult> {
      if (!plan.columnPresent) {
        throw new Error(SHADOW_COLUMN_MISSING_WARNING);
      }

      const updates = plan.rows.filter((row) => row.action === "update");
      if (updates.length === 0) {
        return {
          updatedCount: 0,
          totalShadowCostCents: 0,
          totalDeltaShadowCostCents: 0,
        };
      }

      await db.transaction(async (tx) => {
        for (const row of updates) {
          await tx
            .update(costEvents)
            .set({ shadowCostCents: row.proposedShadowCostCents })
            .where(eq(costEvents.id, row.id));
        }
      });

      return {
        updatedCount: updates.length,
        totalShadowCostCents: updates.reduce((sum, row) => sum + row.proposedShadowCostCents, 0),
        totalDeltaShadowCostCents: updates.reduce((sum, row) => sum + row.deltaShadowCostCents, 0),
      };
    },
  };
}
