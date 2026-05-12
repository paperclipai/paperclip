import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const qslFindings = pgTable(
  "qsl_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    fingerprint: text("fingerprint").notNull(),
    ruleId: text("rule_id"),
    title: text("title").notNull(),
    severity: text("severity"),
    threatCategory: text("threat_category"),
    reviewState: text("review_state").notNull().default("new"),
    reviewDecision: text("review_decision"),
    reviewerId: text("reviewer_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    latestRiskScore: integer("latest_risk_score"),
    latestPayload: jsonb("latest_payload").$type<Record<string, unknown>>(),
    reviewHistory: jsonb("review_history").$type<Array<Record<string, unknown>>>().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFingerprintIdx: uniqueIndex("qsl_findings_company_fingerprint_idx").on(
      table.companyId,
      table.fingerprint,
    ),
    companyReviewStateIdx: index("qsl_findings_company_review_state_idx").on(
      table.companyId,
      table.reviewState,
    ),
    companyLastSeenIdx: index("qsl_findings_company_last_seen_idx").on(
      table.companyId,
      table.lastSeen,
    ),
  }),
);
