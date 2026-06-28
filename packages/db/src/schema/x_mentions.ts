import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const xMentionSources = pgTable(
  "x_mention_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    accountUserId: text("account_user_id").notNull(),
    accountHandle: text("account_handle"),
    sinceId: text("since_id"),
    monthlyBudgetCents: integer("monthly_budget_cents").notNull().default(5000),
    perRunBudgetCents: integer("per_run_budget_cents").notNull().default(500),
    budgetPausedAt: timestamp("budget_paused_at", { withTimezone: true }),
    budgetPauseReason: text("budget_pause_reason"),
    rateLimitResetAt: timestamp("rate_limit_reset_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceUq: uniqueIndex("x_mention_sources_company_source_uq").on(table.companyId, table.sourceKey),
    companyAccountIdx: index("x_mention_sources_company_account_idx").on(table.companyId, table.accountUserId),
    budgetPausedIdx: index("x_mention_sources_budget_paused_idx").on(table.companyId, table.budgetPausedAt),
  }),
);

export const xMentionAuthorAllowlist = pgTable(
  "x_mention_author_allowlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    xUserId: text("x_user_id").notNull(),
    handle: text("handle"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUq: uniqueIndex("x_mention_allowlist_company_user_uq").on(table.companyId, table.xUserId),
    companyActiveIdx: index("x_mention_allowlist_company_active_idx").on(table.companyId, table.isActive),
  }),
);

export const xMentions = pgTable(
  "x_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => xMentionSources.id, { onDelete: "cascade" }),
    tweetId: text("tweet_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    authorHandle: text("author_handle"),
    text: text("text").notNull().default(""),
    mentionedAt: timestamp("mentioned_at", { withTimezone: true }),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    gateStatus: text("gate_status").notNull().default("stored"),
    hydrationStatus: text("hydration_status").notNull().default("none"),
    manualApprovedAt: timestamp("manual_approved_at", { withTimezone: true }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    hydratedAt: timestamp("hydrated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTweetUq: uniqueIndex("x_mentions_company_tweet_uq").on(table.companyId, table.tweetId),
    sourceTweetIdx: index("x_mentions_source_tweet_idx").on(table.sourceId, table.tweetId),
    companyGateIdx: index("x_mentions_company_gate_idx").on(table.companyId, table.gateStatus),
    companyHydrationIdx: index("x_mentions_company_hydration_idx").on(table.companyId, table.hydrationStatus),
    companyAuthorIdx: index("x_mentions_company_author_idx").on(table.companyId, table.authorUserId),
  }),
);

export const xMentionBudgetLedger = pgTable(
  "x_mention_budget_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => xMentionSources.id, { onDelete: "cascade" }),
    mentionId: uuid("mention_id").references(() => xMentions.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    estimatedCostCents: integer("estimated_cost_cents").notNull(),
    actualCostCents: integer("actual_cost_cents"),
    status: text("status").notNull().default("recorded"),
    failureReason: text("failure_reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("x_mention_budget_company_occurred_idx").on(table.companyId, table.occurredAt),
    sourceOccurredIdx: index("x_mention_budget_source_occurred_idx").on(table.sourceId, table.occurredAt),
    operationIdx: index("x_mention_budget_operation_idx").on(table.companyId, table.operation),
  }),
);
