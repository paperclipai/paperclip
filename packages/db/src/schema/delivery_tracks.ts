import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

/**
 * Per-issue opt-in to delivery tracking.
 *
 * No row means the issue behaves exactly like any other issue: no candidate,
 * no review, no evidence, no extra completion gate. A row is created only by an
 * explicit enroll call, and every requirement is stored on the row itself so
 * there is no instance-wide or project-wide rule engine to reason about.
 */
export const deliveryTracks = pgTable(
  "delivery_tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id),
    repositoryUrl: text("repository_url"),
    requireReview: boolean("require_review").notNull().default(false),
    requireVerifiedEvidence: boolean("require_verified_evidence").notNull().default(false),
    pinPlanRevision: boolean("pin_plan_revision").notNull().default(false),
    reviewerAgentIds: jsonb("reviewer_agent_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("active"),
    enrolledByAgentId: uuid("enrolled_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    enrolledByUserId: text("enrolled_by_user_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueUq: uniqueIndex("delivery_tracks_issue_uq").on(table.companyId, table.issueId),
    companyStatusIdx: index("delivery_tracks_company_status_idx").on(table.companyId, table.status),
  }),
);
