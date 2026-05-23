/**
 * Plan 4 — per-guild auto-promotion config + scanner health metric.
 *
 * Seeded for every existing guild at migration time with
 * enabled=false, dry_run=true, and the defaults below. Operator flips
 * to enabled=true via paperclip_set_auto_promotion_config; flip to
 * dry_run=false to start writing real promotions.
 *
 * Floors are enforced by CHECK constraints — an operator typo cannot
 * lower the safety thresholds below the floors.
 */
import {
  pgTable,
  uuid,
  boolean,
  integer,
  numeric,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const autoPromotionConfig = pgTable(
  "auto_promotion_config",
  {
    guildId: uuid("guild_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    dryRun: boolean("dry_run").notNull().default(true),
    scanHourUtc: integer("scan_hour_utc").notNull().default(6),
    minUses: integer("min_uses").notNull().default(5),
    minSuccessRatio: numeric("min_success_ratio", { precision: 4, scale: 3 })
      .notNull()
      .default("0.800"),
    minAgeHours: integer("min_age_hours").notNull().default(24),
    minBodyStableHours: integer("min_body_stable_hours")
      .notNull()
      .default(24),
    minDistinctRuns: integer("min_distinct_runs").notNull().default(3),
    maxPromotionsPerTick: integer("max_promotions_per_tick")
      .notNull()
      .default(3),
    lastSuccessfulScanAt: timestamp("last_successful_scan_at", {
      withTimezone: true,
    }),
    lastScanId: uuid("last_scan_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    scanHourCheck: check(
      "auto_promotion_config_scan_hour_check",
      sql`${table.scanHourUtc} BETWEEN 0 AND 23`,
    ),
    minUsesCheck: check(
      "auto_promotion_config_min_uses_check",
      sql`${table.minUses} >= 3`,
    ),
    minRatioCheck: check(
      "auto_promotion_config_min_ratio_check",
      sql`${table.minSuccessRatio} >= 0.600 AND ${table.minSuccessRatio} <= 1.000`,
    ),
    minAgeCheck: check(
      "auto_promotion_config_min_age_check",
      sql`${table.minAgeHours} >= 6`,
    ),
    minBodyStableCheck: check(
      "auto_promotion_config_min_body_stable_check",
      sql`${table.minBodyStableHours} >= 6`,
    ),
    minDistinctCheck: check(
      "auto_promotion_config_min_distinct_check",
      sql`${table.minDistinctRuns} >= 2`,
    ),
    maxPerTickCheck: check(
      "auto_promotion_config_max_per_tick_check",
      sql`${table.maxPromotionsPerTick} BETWEEN 1 AND 20`,
    ),
  }),
);
