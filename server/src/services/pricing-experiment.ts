/**
 * Pricing Experiment Service — M5 A/B Pricing Test
 *
 * Provides deterministic variant assignment and variant-aware tier
 * transformations for the A/B pricing experiment.
 *
 * Design:
 * - Variant is assigned deterministically from company ID (SHA-256 hash)
 * - Assignment is persisted on the companies table (idempotent)
 * - Experiment config is env-var driven via a single JSON var
 * - When experiment is disabled, all companies see control (variant A) pricing
 * - Tier overrides are shallow merges over the DB tier row
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { companies as companiesTable } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// ── Config ────────────────────────────────────────────────────────────

const tierOverrideSchema = z.object({
  priceMonthlyCents: z.number().int().nonnegative().optional(),
  priceYearlyCents: z.number().int().nonnegative().optional(),
  stripePriceMonthlyId: z.string().optional(),
  stripePriceYearlyId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  features: z.array(z.string()).optional(),
  includedSeats: z.number().int().nonnegative().optional(),
  includedAgentRuns: z.number().int().nonnegative().optional(),
  includedStorageGb: z.number().int().nonnegative().optional(),
});

const variantConfigSchema = z.object({
  weight: z.number().min(0).max(100).default(50),
  tierOverrides: z.record(z.string(), tierOverrideSchema).default({}),
});

const experimentConfigSchema = z.object({
  /** Master kill-switch — when false, all companies see control pricing. */
  enabled: z.boolean().default(false),
  /** Percent of NEW (unassigned) traffic to include in the experiment. */
  trafficPercent: z.number().min(0).max(100).default(50),
  /** Per-variant config. Variant "A" is the implicit control (no overrides). */
  variants: z
    .object({
      B: variantConfigSchema.default({}),
    })
    .default({}),
  /** ISO date string — experiment takes effect after this (optional). */
  startDate: z.string().optional(),
  /** ISO date string — experiment stops after this (optional). */
  endDate: z.string().optional(),
  /** Salt for deterministic hashing (rotate to reassign all companies). */
  salt: z.string().default("m5-pricing-experiment-v1"),
});

export type PricingExperimentConfig = z.infer<typeof experimentConfigSchema>;
export type PricingExperimentVariant = "A" | "B";

export const DEFAULT_EXPERIMENT_CONFIG: PricingExperimentConfig = {
  enabled: false,
  trafficPercent: 50,
  variants: {
    B: {
      weight: 50,
      tierOverrides: {},
    },
  },
  salt: "m5-pricing-experiment-v1",
};

// Track the bound service for downstream calls.
const serviceSymbol = Symbol("pricingExperimentService");

// ── Tier type (subset of subscription_tiers row) ───────────────────────

export interface TierRow {
  id: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  stripePriceMonthlyId: string | null;
  stripePriceYearlyId: string | null;
  stripeProductId: string | null;
  includedSeats: number;
  extraSeatPriceCents: number;
  includedAgentRuns: number;
  extraAgentRunPriceCents: number;
  includedStorageGb: number;
  extraStorageGbPriceCents: number;
  features: string[];
  isActive: boolean;
  sortOrder: number;
}

// ── Service factory ───────────────────────────────────────────────────

export function pricingExperimentService(db: Db) {
  /** Parse and validate experiment config from a raw JSON string. */
  const parseConfig = (raw: string | undefined | null): PricingExperimentConfig => {
    if (!raw || raw.trim().length === 0) return { ...DEFAULT_EXPERIMENT_CONFIG };
    try {
      const parsed = JSON.parse(raw);
      return experimentConfigSchema.parse(parsed);
    } catch (err) {
      logger.warn({ err }, "Invalid pricing experiment config — falling back to defaults");
      return { ...DEFAULT_EXPERIMENT_CONFIG };
    }
  };

  /**
   * Deterministically assign a company to variant A or B.
   * Uses SHA-256(companyId + salt) modulo 100.
   * Returns the same variant for the same company every time (as long as salt stays stable).
   */
  const assignVariant = (companyId: string, config: PricingExperimentConfig): PricingExperimentVariant => {
    if (!config.enabled) return "A";
    const hash = createHash("sha256").update(`${companyId}${config.salt}`).digest("hex");
    const bucket = Number.parseInt(hash.slice(0, 8), 16) % 100;
    if (bucket < config.trafficPercent) {
      // Within experiment traffic: split by variant weight
      const variantBBucket = Number.parseInt(hash.slice(8, 16), 16) % 100;
      const bWeight = config.variants.B?.weight ?? 50;
      return variantBBucket < bWeight ? "B" : "A";
    }
    return "A";
  };

  /**
   * Get or create the variant assignment for a company.
   * If already assigned, returns existing variant.
   * If not assigned and experiment is enabled, assigns deterministically.
   */
  const getOrAssignVariant = async (
    companyId: string,
    config?: PricingExperimentConfig,
  ): Promise<PricingExperimentVariant> => {
    const cfg = config ?? loadConfig();

    // Read current assignment
    const company = await db
      .select({
        variant: companiesTable.pricingExperimentVariant,
        enrolledAt: companiesTable.pricingExperimentEnrolledAt,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .then((r) => r[0] ?? null);

    if (company?.variant === "A" || company?.variant === "B") {
      return company.variant as PricingExperimentVariant;
    }

    if (!cfg.enabled) return "A";

    // Assign and persist
    const variant = assignVariant(companyId, cfg);
    await db
      .update(companiesTable)
      .set({
        pricingExperimentVariant: variant,
        pricingExperimentEnrolledAt: new Date(),
      })
      .where(eq(companiesTable.id, companyId));

    logger.info({ companyId, variant }, "Assigned pricing experiment variant");
    return variant;
  };

  /**
   * Apply variant tier overrides to a list of tier rows.
   * Variant A = control (no overrides). Variant B applies configured overrides.
   */
  const applyTierOverrides = (
    tiers: TierRow[],
    variant: PricingExperimentVariant,
    config?: PricingExperimentConfig,
  ): TierRow[] => {
    const cfg = config ?? loadConfig();
    if (variant === "A" || !cfg.enabled) return tiers;

    const overrides = cfg.variants.B?.tierOverrides ?? {};
    return tiers.map((tier) => {
      const override = overrides[tier.id];
      if (!override) return tier;
      return { ...tier, ...override };
    });
  };

  /**
   * Get experiment results summary (per-variant conversion stats).
   * Returns counts of companies assigned to each variant and their subscription status.
   */
  const getResults = async () => {
    const rows = await db
      .select({
        variant: companiesTable.pricingExperimentVariant,
      })
      .from(companiesTable)
      .where(
        and(
          isNotNull(companiesTable.pricingExperimentVariant),
          inArray(companiesTable.pricingExperimentVariant, ["A", "B"]),
        ),
      );

    const counts = { A: 0, B: 0 };
    for (const row of rows) {
      if (row.variant === "A") counts.A++;
      else if (row.variant === "B") counts.B++;
    }

    // Basic stats — subscription-level analysis requires a JOIN
    // which is done at the route level or via a dedicated endpoint
    return {
      enabled: loadConfig().enabled,
      totalAssigned: counts.A + counts.B,
      variantA: { count: counts.A },
      variantB: { count: counts.B },
    };
  };

  /** Load config from env. */
  const loadConfig = (): PricingExperimentConfig => {
    return parseConfig(process.env.PRICING_EXPERIMENT_CONFIG);
  };

  return {
    parseConfig,
    assignVariant,
    getOrAssignVariant,
    applyTierOverrides,
    getResults,
    loadConfig,
  };
}

export type PricingExperimentService = ReturnType<typeof pricingExperimentService>;