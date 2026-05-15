import { pgTable, uuid, text, real, timestamp, index, unique, jsonb, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const nicheOpportunities = pgTable(
  "niche_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    headKeyword: text("head_keyword").notNull(),
    categoryPath: text("category_path").notNull(),
    tier: text("tier").notNull().default("B"),
    compositeScore: real("composite_score").notNull().default(0),
    status: text("status").notNull().default("unreviewed"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    miaIssueId: uuid("mia_issue_id"),
    metadata: text("metadata"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("niche_opp_company_status_idx").on(table.companyId, table.status),
    discoveredAtIdx: index("niche_opp_discovered_at_idx").on(table.discoveredAt),
    companyCategoryKeywordUq: unique("niche_opp_company_category_keyword_uq").on(
      table.companyId,
      table.categoryPath,
      table.headKeyword,
    ),
  }),
);

export const ndaActivityLog = pgTable(
  "nda_activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    cycleId: text("cycle_id"),
    loggedAt: timestamp("logged_at", { withTimezone: true }).notNull().defaultNow(),
    categoryPath: text("category_path").notNull(),
    categoryId: text("category_id"),
    headKeyword: text("head_keyword"),
    compositeScore: real("composite_score"),
    componentScores: jsonb("component_scores").notNull().default({}),
    hardGuardTriggered: boolean("hard_guard_triggered").notNull().default(false),
    aboveThreshold: boolean("above_threshold").notNull().default(false),
    captchaEvent: boolean("captcha_event").notNull().default(false),
    error: text("error"),
  },
  (table) => ({
    runIdx: index("nda_activity_log_run_idx").on(table.runId),
    cycleIdx: index("nda_activity_log_cycle_idx").on(table.cycleId),
  }),
);

export const ndaDiscoveryState = pgTable(
  "nda_discovery_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    stateKey: text("state_key").notNull(),
    valueJson: jsonb("value_json").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: index("nda_discovery_state_company_key_idx").on(
      table.companyId,
      table.stateKey,
    ),
  }),
);
