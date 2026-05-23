/**
 * Plan 4 — frozen auto-promotion decision record.
 *
 * One row per auto-promotion. Immutable: append-only trigger blocks
 * UPDATE/DELETE except CASCADE. UNIQUE(skill_id) enforces the
 * "auto-promoted at most once" invariant — a reverted skill is
 * permanently ineligible for re-auto-promotion (operator manual
 * promote is still allowed; the scanner just won't act).
 *
 * All thresholds at decision time are frozen on the row so historical
 * decisions remain interpretable after config changes.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { skills } from "./skills.js";

export const autoPromotionAudit = pgTable(
  "auto_promotion_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    guildId: uuid("guild_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: text("decided_by")
      .notNull()
      .default("auto-promotion-scanner"),
    successCountAtDecision: integer("success_count_at_decision").notNull(),
    failCountAtDecision: integer("fail_count_at_decision").notNull(),
    totalUsesAtDecision: integer("total_uses_at_decision").notNull(),
    distinctRunsAtDecision: integer("distinct_runs_at_decision").notNull(),
    successRatioAtDecision: numeric("success_ratio_at_decision", {
      precision: 4,
      scale: 3,
    }).notNull(),
    skillAgeHoursAtDecision: integer(
      "skill_age_hours_at_decision",
    ).notNull(),
    bodyStableHoursAtDecision: integer(
      "body_stable_hours_at_decision",
    ).notNull(),
    minUsesThreshold: integer("min_uses_threshold").notNull(),
    minSuccessRatioThreshold: numeric("min_success_ratio_threshold", {
      precision: 4,
      scale: 3,
    }).notNull(),
    minAgeHoursThreshold: integer("min_age_hours_threshold").notNull(),
    minBodyStableHoursThreshold: integer(
      "min_body_stable_hours_threshold",
    ).notNull(),
    minDistinctRunsThreshold: integer(
      "min_distinct_runs_threshold",
    ).notNull(),
    scanId: uuid("scan_id").notNull(),
  },
  (table) => ({
    guildDecidedIdx: index("auto_promotion_audit_guild_decided_idx").on(
      table.guildId,
      table.decidedAt.desc(),
    ),
    scanIdx: index("auto_promotion_audit_scan_idx").on(table.scanId),
    uniqueSkill: unique("auto_promotion_audit_skill_unique").on(table.skillId),
  }),
);
